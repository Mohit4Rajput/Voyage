import test from 'node:test';
import assert from 'node:assert/strict';
import {startHostedApp,validateHosting} from '../hosted/server.mjs';
import {createLocalDatabase} from '../local/database.mjs';
import {Providers} from '../providers.mjs';
import fs from 'node:fs/promises';
import {brief} from './fixtures.mjs';
import {normalizeBrief} from '../../supabase/functions/_shared/domain.mjs';
const env={APP_ORIGIN:'https://voyage.example',SUPABASE_URL:'https://project.supabase.co',SUPABASE_ANON_KEY:'public-test-key',TURNSTILE_SITE_KEY:'captcha-public'};
test('hosting fails closed for missing credentials and non-HTTPS origins',()=>{
  assert.throws(()=>validateHosting({}));assert.throws(()=>validateHosting({...env,APP_ORIGIN:'http://voyage.example'}));assert.throws(()=>validateHosting({...env,APP_ORIGIN:'https://voyage.example/'}));
});
test('hosted server uses real Auth, secure cookies, RLS tokens and public shares',async t=>{
  const seen=[];const user={id:crypto.randomUUID(),email_confirmed_at:new Date().toISOString()};
  const mock=async(url,options)=>{seen.push({url,options});let data={};if(url.endsWith('/auth/v1/verify'))data={access_token:'verified-access',refresh_token:'private-refresh',expires_in:3600,user};else if(url.endsWith('/auth/v1/user'))data=user;else if(url.includes('/rest/v1/trips?'))data=[];else if(url.includes('/rpc/resolve_options_share'))data={options:[]};return new Response(JSON.stringify(data),{status:200});};
  const app=await startHostedApp({env,port:0,fetchImpl:mock});t.after(()=>app.close());const base='http://127.0.0.1:'+app.server.address().port;
  const post=(p,b,origin=env.APP_ORIGIN)=>fetch(base+p,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(b)});
  assert.equal((await post('/api/session',{})).status,401);
  assert.equal((await post('/api/auth/start',{email:'a@example.com',captchaToken:'one-use-token'},'https://evil.example')).status,403);
  assert.equal((await post('/api/auth/start',{email:'a@example.com'})).status,400);
  assert.equal((await post('/api/auth/start',{email:'a@example.com',captchaToken:'one-use-token'})).status,200);
  const otp=seen.find(x=>x.url.endsWith('/auth/v1/otp'));assert.equal(JSON.parse(otp.options.body).gotrue_meta_security.captcha_token,'one-use-token');
  const signed=await post('/api/auth/confirm',{email:'a@example.com',code:'123456'});assert.equal(signed.status,200);const cookies=signed.headers.getSetCookie();assert.equal(cookies.length,2);for(const c of cookies){assert.match(c,/HttpOnly/);assert.match(c,/Secure/);assert.match(c,/SameSite=Lax/);assert.match(c,/__Host-/);}
  const state=await fetch(base+'/api/state',{headers:{Cookie:'__Host-voyage_access=verified-access'}});assert.equal(state.status,200);assert.equal((await state.json()).data.userId,user.id);assert.equal(seen.find(x=>x.url.includes('/rest/v1/trips?')).options.headers.Authorization,'Bearer verified-access');
  assert.equal((await fetch(base+'/api/plan.pdf?planId='+crypto.randomUUID())).status,401);
  assert.equal((await post('/api/command',{action:'resolve-options-share',token:'a'.repeat(64)})).status,200);
  assert.equal((await post('/api/email/action',{})).status,410);
  const html=await(await fetch(base+'/')).text();assert.match(html,/hosted-auth.mjs/);assert.doesNotMatch(html,/src="\/app.mjs"/);
});
test('global API reservations are persistent, atomic, bounded and not callable by users',async t=>{
  const db=await createLocalDatabase(null);t.after(()=>db.close());
  await db.admin('update private.hosting_limits set enabled=true,search_daily=2,search_monthly=3');
  assert.equal(await db.rpc(null,'reserve_provider_call',{p_kind:'search'}),true);
  const attempts=await Promise.allSettled(Array.from({length:3},()=>db.rpc(null,'reserve_provider_call',{p_kind:'search'})));for(const a of attempts)assert.equal(a.status,'fulfilled');assert.equal(attempts.filter(a=>a.value===true).length,1);
  const uid=crypto.randomUUID();await db.admin('insert into auth.users(id) values($1)',[uid]);
  await assert.rejects(db.rpc(uid,'reserve_provider_call',{p_kind:'model'}));
  assert.equal((await db.admin("select used from private.provider_usage where kind='search' order by length(period) desc limit 1")).rows[0].used,2);
  await db.admin("update private.provider_usage set used=0 where length(period)=10");
  assert.equal(await db.rpc(null,'reserve_provider_call',{p_kind:'search'}),true);
  assert.equal(await db.rpc(null,'reserve_provider_call',{p_kind:'search'}),false,'monthly allowance still applies after daily counter resets');
});
test('hosted enqueue requires verified accounts and applies global quota without charging retries',async t=>{
  const db=await createLocalDatabase(null);t.after(()=>db.close());
  await db.admin('alter table auth.users add column email_confirmed_at timestamptz');
  const migration=await fs.readFile(new URL('../../supabase/migrations/202610180003_hosting_limits.sql',import.meta.url),'utf8');
  await db.admin(migration.slice(migration.indexOf('create or replace function public.enqueue_research')));
  await db.admin('update private.hosting_limits set enabled=true,jobs_per_day=1');
  const uid=crypto.randomUUID();await db.admin('insert into auth.users(id) values($1)',[uid]);
  const trip=await db.rpc(uid,'save_travel_brief',{p_trip_id:null,p_expected_revision:0,p_brief:normalizeBrief(brief)});
  const args={p_trip_id:trip.id,p_revision:1,p_kind:'options',p_request_key:crypto.randomUUID()};
  await assert.rejects(db.rpc(uid,'enqueue_research',args),e=>e.code==='UNAUTHORIZED');
  await db.admin('update auth.users set email_confirmed_at=now() where id=$1',[uid]);
  const job=await db.rpc(uid,'enqueue_research',args);assert.equal((await db.rpc(uid,'enqueue_research',args)).id,job.id);
  await db.rpc(uid,'cancel_research',{p_job_id:job.id});
  await assert.rejects(db.rpc(uid,'enqueue_research',{...args,p_request_key:crypto.randomUUID()}),e=>e.code==='RATE_LIMITED');
});
test('exhausted provider budget prevents outgoing requests',async()=>{
  let called=false;const p=new Providers({},{model:'test:free',beforeCall:async()=>{throw Error('BUDGET');},fetchImpl:async()=>{called=true;throw Error('Unexpected network');}});
  await assert.rejects(p.search('test'),/BUDGET/);p.freeChecked=true;
  await assert.rejects(p.generate('test',{}),/BUDGET/);assert.equal(called,false);
});
