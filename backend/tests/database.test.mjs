import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { normalizeBrief, validateOptions, validatePlan } from '../../supabase/functions/_shared/domain.mjs';
import { brief, sources, candidates, options, plan } from './fixtures.mjs';

test('real Postgres migration, ownership and durable job lifecycle', async t => {
  const db=new PGlite();
  const owner='11111111-1111-4111-8111-111111111111', other='22222222-2222-4222-8222-222222222222';
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to anon,authenticated,service_role;
    insert into auth.users values('${owner}'),('${other}');`);
  const migration=await fs.readFile(new URL('../../supabase/migrations/202610150001_research_backend.sql',import.meta.url),'utf8');
  await db.exec(migration);
  await db.exec(await fs.readFile(new URL('../../supabase/migrations/202610150002_sharing_and_polls.sql',import.meta.url),'utf8'));
  async function user(uid,sql,params=[]) {
    await db.exec('begin; set local role authenticated;');
    try {
      await db.query("select set_config('request.jwt.claim.sub',$1,true)",[uid]);
      const out=await db.query(sql,params); await db.exec('commit'); return out.rows;
    } catch(e) {await db.exec('rollback');throw e;}
  }
  async function service(sql,params=[]) {
    await db.exec('begin; set local role service_role;');
    try {const out=await db.query(sql,params);await db.exec('commit');return out.rows;}
    catch(e){await db.exec('rollback');throw e;}
  }
  const b=normalizeBrief(brief);
  let trip,job,claim,optionId,planId;
  try {
    await t.test('owner saves valid revision; direct writes and cross-user reads/writes blocked',async()=>{
      [trip]=await user(owner,'select * from public.save_travel_brief(null,0,$1)',[b]);
      assert.equal(trip.current_revision,1);
      assert.equal((await user(other,'select * from public.trips where id=$1',[trip.id])).length,0);
      await assert.rejects(user(other,'select * from public.save_travel_brief($1,1,$2)',[trip.id,b]),/NOT_FOUND/);
      await assert.rejects(user(owner,"update public.trips set owner_id=$1 where id=$2",[other,trip.id]),/permission denied/);
      await assert.rejects(user(owner,'select * from public.save_travel_brief($1,0,$2)',[trip.id,b]),/CONFLICT/);
      await assert.rejects(user(owner,'select * from public.save_travel_brief($1,null,$2)',[trip.id,b]),/CONFLICT/);
      await assert.rejects(user(owner,'select * from public.save_travel_brief(null,0,$1)',[{...b,nights:99}]),/VALIDATION_ERROR/);
      await assert.rejects(user(owner,'select * from public.save_travel_brief(null,0,$1)',[{...b,budget_per_person_minor:null}]),/VALIDATION_ERROR/);
    });
    await t.test('enqueue is idempotent and worker commands are not public',async()=>{
      const key=crypto.randomUUID();
      [job]=await user(owner,"select * from public.enqueue_research($1,1,'options',$2)",[trip.id,key]);
      const [same]=await user(owner,"select * from public.enqueue_research($1,1,'options',$2)",[trip.id,key]);
      assert.equal(job.id,same.id);
      await assert.rejects(user(owner,"select * from public.enqueue_research($1,1,'itinerary',$2)",[trip.id,key]),/CONFLICT/);
      await assert.rejects(user(owner,'select public.worker_claim(null)'),/permission denied/);
      await assert.rejects(user(owner,'select * from private.job_state'),/permission denied/);
      const [row]=await service('select public.worker_claim($1) as value',[job.id]);claim=row.value;
      assert.equal(claim.job.id,job.id);assert.equal(claim.brief.departure_location,b.departure_location);
      assert.equal((await service('select public.worker_claim($1) as value',[job.id]))[0].value,null);
      assert.equal((await service('select public.worker_heartbeat($1,$2) as value',[job.id,crypto.randomUUID()]))[0].value,false);
    });
    await t.test('completion is fenced, atomic and only owner can select results',async()=>{
      const result=validateOptions(options(),b,sources,candidates);
      assert.equal((await service('select public.worker_complete($1,$2,$3,$4) as value',[job.id,claim.lease_token,result,sources]))[0].value,true);
      assert.equal((await service('select public.worker_complete($1,$2,$3,$4) as value',[job.id,claim.lease_token,result,sources]))[0].value,false);
      const rows=await user(owner,'select * from public.trip_options where trip_id=$1',[trip.id]);optionId=rows[0].id;
      assert.equal((await user(other,'select * from public.trip_options where trip_id=$1',[trip.id])).length,0);
      assert.equal((await user(other,'select * from public.research_sources where job_id=$1',[job.id])).length,0);
      await assert.rejects(user(other,'select * from public.choose_trip_option($1,1,$2)',[trip.id,optionId]),/NOT_FOUND/);
      await user(owner,'select * from public.choose_trip_option($1,1,$2)',[trip.id,optionId]);
    });
    await t.test('stage-two plan uses selected option and can lock only current affordable version',async()=>{
      const [j]=await user(owner,"select * from public.enqueue_research($1,1,'itinerary',$2)",[trip.id,crypto.randomUUID()]);
      const [row]=await service('select public.worker_claim($1) as value',[j.id]);
      const c=row.value; assert.equal(c.job.selected_option_id,optionId);
      const output=validatePlan(plan(),b,sources);
      await service('select public.worker_complete($1,$2,$3,$4)',[j.id,c.lease_token,output,sources]);
      const [p]=await user(owner,'select * from public.itinerary_versions where job_id=$1',[j.id]);planId=p.id;
      await assert.rejects(user(other,'select * from public.lock_itinerary($1)',[p.id]),/NOT_FOUND/);
      const [locked]=await user(owner,'select * from public.lock_itinerary($1)',[p.id]);assert.equal(locked.status,'locked');
      await assert.rejects(user(owner,"update public.itinerary_versions set content='{}' where id=$1",[p.id]),/permission denied/);
    });
    await t.test('private invitations bind to one voter; organizer sees only aggregate choice counts',async()=>{
      const [row]=await user(owner,'select public.create_trip_poll($1,$2) as value',[trip.id,job.id]);const poll=row.value;
      const hash='a'.repeat(64);
      const [created]=await user(owner,'select public.create_poll_invite($1,$2,$3) as value',[poll.id,'Traveler 1',hash]);const invite=created.value;
      await assert.rejects(user(other,'select public.trip_poll_summary($1)',[poll.id]),/NOT_FOUND/);
      const [redeemed]=await user(other,'select public.redeem_poll_invite($1) as value',[hash]);assert.equal(redeemed.value.options.length,1);
      await assert.rejects(user(owner,'select public.redeem_poll_invite($1)',[hash]),/INVITE_ALREADY_USED/);
      await user(other,'select public.submit_trip_ballot($1,$2,$3)',[invite,optionId,[]]);
      await user(other,'select public.submit_trip_ballot($1,$2,$3)',[invite,optionId,['dates']]);
      const [summary]=await user(owner,'select public.trip_poll_summary($1) as value',[poll.id]);
      assert.equal(Number(summary.value.totals[0].votes),1);assert.equal(summary.value.participants[0].responded,true);
      assert.equal(summary.value.participants[0].option_id,undefined);
      assert.equal(summary.value.veto_counts.dates,1);
      await assert.rejects(user(owner,'select * from private.ballots'),/permission denied/);
      await user(owner,'select public.close_trip_poll($1)',[poll.id]);
      await assert.rejects(user(other,'select public.submit_trip_ballot($1,$2,$3)',[invite,optionId,[]]),/POLL_CLOSED/);
      const [expiring]=await user(owner,'select public.create_trip_poll($1,$2) as value',[trip.id,job.id]);
      const [secondInvite]=await user(owner,'select public.create_poll_invite($1,$2,$3) as value',[expiring.value.id,'Traveler 2','c'.repeat(64)]);
      await user(other,'select public.redeem_poll_invite($1)',['c'.repeat(64)]);
      await db.query("update private.polls set closes_at=now()-interval '1 second' where id=$1",[expiring.value.id]);
      await assert.rejects(user(other,'select public.submit_trip_ballot($1,$2,$3)',[secondInvite.value,optionId,[]]),/POLL_CLOSED/);
    });
    await t.test('share resolves a pinned plan, excludes private input and revokes immediately',async()=>{
      const hash='b'.repeat(64);
      const [created]=await user(owner,'select public.create_plan_share($1,$2) as value',[planId,hash]);
      const [shared]=await user(other,'select public.resolve_plan_share($1) as value',[hash]);
      assert.equal(shared.value.plan_id,planId);assert.equal(shared.value.brief,undefined);assert.equal(shared.value.owner_id,undefined);
      await assert.rejects(user(other,'select public.revoke_plan_share($1)',[created.value]),/NOT_FOUND/);
      await user(owner,'select public.revoke_plan_share($1)',[created.value]);
      await assert.rejects(user(other,'select public.resolve_plan_share($1)',[hash]),/NOT_FOUND/);
      const expiredHash='d'.repeat(64);
      const [expires]=await user(owner,'select public.create_plan_share($1,$2) as value',[planId,expiredHash]);
      await db.query("update private.plan_shares set expires_at=now()-interval '1 second' where id=$1",[expires.value]);
      await assert.rejects(user(other,'select public.resolve_plan_share($1)',[expiredHash]),/NOT_FOUND/);
    });
    await t.test('saving new brief cancels active research and rejects old worker publication',async()=>{
      const [j]=await user(owner,"select * from public.enqueue_research($1,1,'options',$2)",[trip.id,crypto.randomUUID()]);
      const [row]=await service('select public.worker_claim($1) as value',[j.id]);
      await user(owner,'select * from public.save_travel_brief($1,1,$2)',[trip.id,{...b,intent:'Changed to a different intent'}]);
      assert.equal((await service('select public.worker_checkpoint($1,$2,$3,$4,$5) as value',[j.id,row.value.lease_token,{},'researching','Old progress']))[0].value,false);
      assert.equal((await service('select public.worker_complete($1,$2,$3,$4) as value',[j.id,row.value.lease_token,{options:[]},sources]))[0].value,false);
      const [updated]=await user(owner,'select * from public.trips where id=$1',[trip.id]);assert.equal(updated.current_revision,2);assert.equal(updated.selected_option_id,null);
      await assert.rejects(user(owner,'select * from public.lock_itinerary($1)',[planId]),/CONFLICT/);
      await assert.rejects(user(owner,"select * from public.enqueue_research($1,2,'options',$2)",[trip.id,crypto.randomUUID()]),/RATE_LIMITED/);
    });
    await t.test('crash lease recovers checkpoint; stale lease can never publish',async()=>{
      const [t2]=await user(other,'select * from public.save_travel_brief(null,0,$1)',[b]);
      const [j]=await user(other,"select * from public.enqueue_research($1,1,'options',$2)",[t2.id,crypto.randomUUID()]);
      const first=(await service('select public.worker_claim($1) as value',[j.id]))[0].value;
      await service('select public.worker_checkpoint($1,$2,$3,$4,$5)',[j.id,first.lease_token,{search_index:2},'researching','Checkpoint fixture']);
      await db.query("update private.job_state set lease_until=now()-interval '1 second' where job_id=$1",[j.id]);
      const next=(await service('select public.worker_claim($1) as value',[j.id]))[0].value;
      assert.notEqual(first.lease_token,next.lease_token);assert.equal(next.checkpoint.search_index,2);
      assert.equal((await service('select public.worker_complete($1,$2,$3,$4) as value',[j.id,first.lease_token,{options:[]},[]]))[0].value,false);
      assert.equal((await service('select public.worker_fail($1,$2,$3,$4) as value',[j.id,next.lease_token,'TAVILY_429',true]))[0].value,true);
      const [pending]=await user(other,'select * from public.research_jobs where id=$1',[j.id]);assert.equal(pending.status,'queued');
    });
  } finally {await db.close();}
});
