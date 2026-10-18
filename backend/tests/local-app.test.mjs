import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { startLocalApp } from '../local/server.mjs';
import { brief } from './fixtures.mjs';

test('local default permits twenty searches and explains the next rejection',async t=>{
  const app=await startLocalApp({port:0,dataDir:null,env:{},autoWorker:false});t.after(()=>app.close());
  const session=await fetch(app.url+'/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  const cookie=session.headers.get('set-cookie').split(';')[0];
  const command=async body=>{const response=await fetch(app.url+'/api/command',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(body)});return{status:response.status,...await response.json()};};
  const saved=await command({action:'save-brief',expectedRevision:0,brief});
  for(let i=0;i<20;i++){
    const job=await command({action:'research-options',tripId:saved.data.id,revision:1,requestId:crypto.randomUUID(),mode:'fixture'});
    assert.equal(job.status,202,`search ${i+1} must be allowed`);
    await command({action:'cancel-research',jobId:job.data.id});
  }
  const blocked=await command({action:'research-options',tripId:saved.data.id,revision:1,requestId:crypto.randomUUID(),mode:'fixture'});
  assert.equal(blocked.status,429);assert.match(blocked.error.message,/20 destination searches/);assert.match(blocked.error.message,/LOCAL_DAILY_RESEARCH_LIMIT/);
  assert.equal((await(await fetch(app.url+'/api/health')).json()).data.dailyResearchLimit,20);
});

test('local HTTP workbench: complete feature journey with separate user cookies',async t=>{
  const app=await startLocalApp({port:0,dataDir:null,env:{LOCAL_DAILY_RESEARCH_LIMIT:'3'}});
  t.after(()=>app.close());
  function browser(){let cookie='';const api=async(route,body)=>{
    const response=await fetch(app.url+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',Cookie:cookie},...(body?{body:JSON.stringify(body)}:{})});
    const setCookie=response.headers.get('set-cookie');if(setCookie)cookie=setCookie.split(';')[0];
    const out=await response.json();return{status:response.status,...out};
  };api.raw=route=>fetch(app.url+route,{headers:{Cookie:cookie}});return api;}
  const owner=browser(),guest=browser();
  const cmd=(api,action,input={})=>api('/api/command',{action,...input});
  async function finish(jobId,tripId){const deadline=Date.now()+15000;while(Date.now()<deadline){const state=(await owner(`/api/state?tripId=${tripId}`)).data;const job=state.jobs.find(j=>j.id===jobId);if(['completed','failed','cancelled'].includes(job.status)){assert.equal(job.status,'completed',job.error_code);return state;}await delay(100);}throw Error('Local fixture job timed out');}
  let trip,options,optionJob,plan,poll,invite,share;
  await t.test('static workbench loads; secrets and cross-origin requests are blocked',async()=>{
    const page=await fetch(app.url);assert.equal(page.status,200);assert.match(await page.text(),/Local workbench|LOCAL WORKBENCH/);
    assert.notEqual((await fetch(app.url+'/.env')).status,200);
    assert.equal((await fetch(app.url+'/api/health',{headers:{Origin:'https://external.example'}})).status,403);
    assert.equal((await owner('/api/health')).data.auth,'local session simulation');
    assert.equal((await owner('/api/health')).data.liveAvailable,false);
  });
  await t.test('session, input validation, save and reload',async()=>{
    await owner('/api/session',{});await guest('/api/session',{});
    assert.equal((await cmd(owner,'save-brief',{brief:{...brief,end_date:'2026-11-07'},expectedRevision:0})).status,400);
    const saved=await cmd(owner,'save-brief',{brief,expectedRevision:0});assert.equal(saved.status,200);trip=saved.data;
    const restored=await owner(`/api/state?tripId=${trip.id}`);assert.equal(restored.data.brief.departure_location,brief.departure_location);
    assert.equal((await guest(`/api/state?tripId=${trip.id}`)).status,404);
  });
  await t.test('background research returns three clearly synthetic options',async()=>{
    const requestId=crypto.randomUUID();
    optionJob=(await cmd(owner,'research-options',{tripId:trip.id,revision:1,requestId,mode:'fixture'})).data;
    const duplicate=await cmd(owner,'research-options',{tripId:trip.id,revision:1,requestId,mode:'fixture'});assert.equal(duplicate.data.id,optionJob.id);
    const state=await finish(optionJob.id,trip.id);options=state.options;
    assert.equal(options.length,3);assert.equal(options[0].content.execution_mode,'fixture');
    assert.ok(options[0].content.why_it_fits.includes(brief.intent));
  });
  await t.test('saved email stays private, unverified and outside the travel brief',async()=>{
    assert.equal((await cmd(owner,'save-contact-email',{email:'not-an-email'})).status,400);
    const saved=await cmd(owner,'save-contact-email',{email:'traveler@example.com'});
    assert.equal(saved.status,200);assert.equal(saved.data.verified,false);
    assert.equal((await cmd(owner,'get-contact-email')).data.email,'traveler@example.com');
    assert.equal((await cmd(guest,'get-contact-email')).data.email,null);
    const current=(await owner(`/api/state?tripId=${trip.id}`)).data;
    assert.equal(current.trip.current_revision,1);assert.equal(JSON.stringify(current).includes('traveler@example.com'),false);
    await assert.rejects(app.db.asUser(current.userId,c=>c.query('select * from private.traveler_contacts')));
    assert.equal((await cmd(owner,'save-contact-email',{email:null})).data.email,null);
  });
  await t.test('selection is explicit, then the selected itinerary is saved and locked',async()=>{
    const chosen=options.find(o=>o.content.destination==='Test Region B');
    assert.equal((await cmd(owner,'select-option',{tripId:trip.id,revision:1,optionId:chosen.id})).status,200);
    const mismatch=await cmd(owner,'build-itinerary',{tripId:trip.id,revision:1,requestId:crypto.randomUUID(),mode:'live'});assert.equal(mismatch.status,409);
    const quotaFixtures=[];
    for(let i=0;i<2;i++)quotaFixtures.push((await app.db.admin("insert into public.research_jobs(trip_id,brief_revision,kind,request_key,status) values($1,1,'options',$2,'cancelled') returning id",[trip.id,crypto.randomUUID()])).rows[0].id);
    const queued=await cmd(owner,'build-itinerary',{tripId:trip.id,revision:1,requestId:crypto.randomUUID(),mode:'fixture'});
    assert.equal(queued.status,202,'three option searches must leave itinerary capacity');
    await app.db.admin('delete from public.research_jobs where id=any($1::uuid[])',[quotaFixtures]);
    const state=await finish(queued.data.id,trip.id);plan=state.plans[0];
    assert.equal(plan.content.bases[0].name,'Test Base B');assert.equal(plan.content.days.length,3);
    assert.equal(plan.content.execution_mode,'fixture');assert.equal(plan.content.budget.within_budget,true);
    assert.equal((await cmd(owner,'lock-plan',{planId:plan.id})).data.status,'locked');
  });
  await t.test('PDF downloads work while email sharing is disabled',async()=>{
    const pdf=await owner.raw(`/api/plan.pdf?planId=${plan.id}`);assert.equal(pdf.status,200);assert.match(pdf.headers.get('content-type'),/application\/pdf/);
    const bytes=Buffer.from(await pdf.arrayBuffer());assert.equal(bytes.subarray(0,5).toString(),'%PDF-');assert.match(bytes.subarray(-30).toString(),/%%EOF/);
    assert.equal((await guest.raw(`/api/plan.pdf?planId=${plan.id}`)).status,404);
    assert.equal((await fetch(app.url+`/api/plan.pdf?planId=${plan.id}`)).status,401);
    assert.equal((await owner('/api/email/verify',{token:'old'})).status,410);
    assert.equal((await owner('/api/email/action',{action:'send-itinerary'})).status,410);
    assert.equal((await owner('/api/email/status')).status,410);
  });
  await t.test('view-only shortlist shares are private, pinned, expiring and revocable',async()=>{
    assert.equal((await cmd(owner,'create-poll',{tripId:trip.id,jobId:optionJob.id})).status,400);
    assert.equal((await cmd(guest,'create-options-share',{tripId:trip.id,jobId:optionJob.id})).status,404);
    const sharedLink=(await cmd(owner,'create-options-share',{tripId:trip.id,jobId:optionJob.id})).data;
    const read=await cmd(guest,'resolve-options-share',{token:sharedLink.token});
    assert.equal(read.status,200);assert.equal(read.data.options.length,3);
    assert.equal(read.data.brief,undefined);assert.equal(read.data.owner_id,undefined);assert.equal(read.data.options[0].job_id,undefined);
    assert.equal(read.data.sources[0].excerpt,undefined);
    assert.equal((await cmd(guest,'revoke-options-share',{shareId:sharedLink.id})).status,404);
    assert.equal((await cmd(guest,'select-option',{tripId:trip.id,revision:1,optionId:options[0].id})).status,404);
    await app.db.admin("update public.trip_options set content=jsonb_set(content,'{title}',to_jsonb('Changed owner copy'::text)) where id=$1",[options[0].id]);
    assert.notEqual((await cmd(guest,'resolve-options-share',{token:sharedLink.token})).data.options[0].content.title,'Changed owner copy');
    await cmd(owner,'revoke-options-share',{shareId:sharedLink.id});assert.equal((await cmd(guest,'resolve-options-share',{token:sharedLink.token})).status,404);
    const expired=(await cmd(owner,'create-options-share',{tripId:trip.id,jobId:optionJob.id})).data;
    await app.db.admin("update private.option_shares set expires_at=now()-interval '1 second' where id=$1",[expired.id]);
    assert.equal((await cmd(guest,'resolve-options-share',{token:expired.token})).status,404);
    assert.equal((await cmd(guest,'resolve-options-share',{token:'invalid'})).status,400);
    await assert.rejects(app.db.asUser((await owner('/api/state')).data.userId,c=>c.query('select * from private.option_shares')));
  });
  await t.test('plan share, sanitized read and revocation work',async()=>{
    share=(await cmd(owner,'create-share',{planId:plan.id})).data;
    const shared=await cmd(guest,'resolve-share',{token:share.token});assert.equal(shared.status,200);assert.equal(shared.data.plan_id,plan.id);assert.equal(shared.data.brief,undefined);
    await cmd(owner,'revoke-share',{shareId:share.id});assert.equal((await cmd(guest,'resolve-share',{token:share.token})).status,404);
  });
  await t.test('brief edits cancel queued research and block stale selection/version locking',async()=>{
    const queued=(await cmd(owner,'research-options',{tripId:trip.id,revision:1,requestId:crypto.randomUUID(),mode:'fixture'})).data;
    const updated=await cmd(owner,'save-brief',{tripId:trip.id,expectedRevision:1,brief:{...brief,intent:'Updated user intent'}});assert.equal(updated.data.current_revision,2);
    const state=(await owner(`/api/state?tripId=${trip.id}`)).data;
    assert.equal(state.trip.selected_option_id,null);assert.equal(state.jobs.find(j=>j.id===queued.id).status,'cancelled');
    assert.equal((await cmd(owner,'lock-plan',{planId:plan.id})).status,409);
    assert.equal((await cmd(owner,'save-brief',{tripId:trip.id,expectedRevision:1,brief})).status,409);
    const third=await cmd(owner,'research-options',{tripId:trip.id,revision:2,requestId:crypto.randomUUID(),mode:'fixture'});
    assert.equal(third.status,202);
    await cmd(owner,'cancel-research',{jobId:third.data.id});
    assert.equal((await cmd(owner,'research-options',{tripId:trip.id,revision:2,requestId:crypto.randomUUID(),mode:'fixture'})).status,429);
  });
});
