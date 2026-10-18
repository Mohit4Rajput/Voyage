import {randomBytes,createHash} from 'node:crypto';
import {AppError,uuid} from '../supabase/functions/_shared/domain.mjs';
import {itineraryPdf} from './itinerary-pdf.mjs';

const hash=s=>createHash('sha256').update(s).digest('hex');
export function createDelivery({db,env,origin,fetchImpl=fetch}){
  const mode=env.MAIL_DELIVERY_MODE??'outbox';
  if(!['outbox','resend'].includes(mode))throw Error('MAIL_DELIVERY_MODE must be outbox or resend.');
  const liveReady=!!(env.RESEND_API_KEY&&env.MAIL_FROM);
  let busy=false;
  const ensureReady=()=>{if(mode==='resend'&&!liveReady)throw new AppError('MAIL_NOT_CONFIGURED','Set RESEND_API_KEY and MAIL_FROM on the server before sending real email.',503);};
  async function plan(user,id){
    uuid(id);
    return db.asUser(user,async c=>{
      const row=(await c.query('select p.*, (p.brief_revision=t.current_revision and p.selected_option_id=t.selected_option_id) as is_current from public.itinerary_versions p join public.trips t on t.id=p.trip_id where p.id=$1',[id])).rows[0];
      if(!row)throw new AppError('NOT_FOUND','Itinerary not found.',404);
      const sources=(await c.query('select source_key,title,url,checked_at from public.research_sources where job_id=$1',[row.job_id])).rows;
      return{row,sources};
    });
  }
  async function pdf(user,id){const{row,sources}=await plan(user,id);const bytes=await itineraryPdf(row,sources);if(bytes.length>5*1024*1024)throw new AppError('PDF_TOO_LARGE','The PDF exceeds the 5 MB delivery limit.',413);return bytes;}
  async function prior(user,input,kind,email){
    const old=(await db.admin('select * from private.mail_jobs where user_id=$1 and request_key=$2',[user,uuid(input.requestId)])).rows[0];
    if(old&&(old.kind!==kind||old.email!==email||old.mode!==mode||(old.plan_id??null)!==(input.planId??null)||(old.trip_id??null)!==(input.tripId??null)||(old.job_id??null)!==(input.jobId??null)))throw new AppError('CONFLICT','This request ID belongs to a different email action.',409);
    return old;
  }
  async function quota(user,kind){
    const count=Number((await db.admin("select count(*) n from private.mail_jobs where user_id=$1 and kind=$2 and created_at>now()-interval '1 day'",[user,kind])).rows[0].n);
    if(count>=5)throw new AppError('RATE_LIMITED','Email actions are limited to five of each type per rolling 24 hours.',429);
  }
  const summary=j=>({id:j.id,kind:j.kind,status:j.status,mode:j.mode,error_code:j.error_code,created_at:j.created_at});
  function recipient(value){
    if(typeof value!=='string'||value.trim().length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()))throw new AppError('VALIDATION_ERROR','Enter one valid recipient email address.');
    return value.trim();
  }
  async function queueOptions(user,input){
    ensureReady();const email=recipient(input.email);uuid(input.tripId);uuid(input.jobId);
    const old=await prior(user,input,'options',email);if(old)return summary(old);await quota(user,'options');
    const token=randomBytes(32).toString('hex');
    await db.rpc(user,'create_options_share',{p_trip_id:input.tripId,p_job_id:input.jobId,p_token_hash:hash(token)});
    const shared=await db.rpc(user,'resolve_options_share',{p_token_hash:hash(token)});
    const url=`${origin()}/#options=${token}`;
    const descriptions=shared.options.map((o,i)=>`${i+1}. ${o.content.destination}: ${o.content.title}\n${o.content.why_it_fits}\nBudget: ${o.content.budget.complete?'Indicative estimate; see full shortlist.':'Unresolved; costs still need verification.'}`).join('\n\n');
    const payload={subject:'Destination options shared with you - Voyage',text:`${mode==='outbox'?'LOCAL TEST ONLY - no email was sent.\n\n':''}A Voyage traveler shared this destination shortlist with you.\n\n${descriptions}\n\nView the saved shortlist (expires in 30 days):\n${url}\n\nPrices, availability, entry requirements and feasibility still require confirmation.`};
    const id=crypto.randomUUID();await db.admin("insert into private.mail_jobs(id,user_id,kind,mode,email,trip_id,job_id,request_key,payload) values($1,$2,'options',$3,$4,$5,$6,$7,$8)",[id,user,mode,email,input.tripId,input.jobId,input.requestId,payload]);
    return{id,kind:'options',status:'queued',mode};
  }
  async function queueItinerary(user,input){
    ensureReady();const email=recipient(input.email);
    uuid(input.planId);const old=await prior(user,input,'itinerary',email);if(old)return summary(old);
    await quota(user,'itinerary');const bytes=await pdf(user,input.planId);
    const id=crypto.randomUUID(),payload={subject:'Your Voyage itinerary PDF',text:`${mode==='outbox'?'LOCAL TEST ONLY - no email was sent.\n\n':''}Your requested itinerary version is attached. Prices, availability and entry requirements still need confirmation before booking.`,attachments:[{filename:`voyage-itinerary-${input.planId}.pdf`,content:bytes.toString('base64'),content_type:'application/pdf'}]};
    await db.admin("insert into private.mail_jobs(id,user_id,kind,mode,email,plan_id,request_key,payload) values($1,$2,'itinerary',$3,$4,$5,$6,$7)",[id,user,mode,email,input.planId,input.requestId,payload]);
    return{id,kind:'itinerary',status:'queued',mode};
  }
  async function tick(){
    if(busy)return;busy=true;let job;
    try{
      await db.admin("update private.mail_jobs set status='failed',error_code='RETRY_EXHAUSTED',lease_until=null,updated_at=now() where mode=$1 and status='sending' and attempts>=3 and lease_until<now()",[mode]);
      job=(await db.admin(`update private.mail_jobs set status='sending',attempts=attempts+1,lease_until=now()+interval '90 seconds',updated_at=now()
        where id=(select id from private.mail_jobs where mode=$1 and kind in ('options','itinerary') and attempts<3 and next_attempt<=now() and (status='queued' or (status='sending' and lease_until<now())) order by created_at limit 1) returning *`,[mode])).rows[0];
      if(!job)return;
      if(Date.now()-Date.parse(job.created_at)>23*3600000)throw Object.assign(Error(),{code:'DELIVERY_EXPIRED',permanent:true});
      if(mode==='outbox'){await db.admin("update private.mail_jobs set status='outbox',lease_until=null,updated_at=now() where id=$1",[job.id]);return;}
      ensureReady();
      const payload=job.payload;
      let response;
      try{response=await fetchImpl('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${env.RESEND_API_KEY}`,'Content-Type':'application/json','Idempotency-Key':`voyage/${job.id}`},body:JSON.stringify({from:env.MAIL_FROM,to:[job.email],...payload}),signal:AbortSignal.timeout(20000)});}catch{throw Object.assign(Error(),{code:'MAIL_TIMEOUT'});}
      if(!response.ok)throw Object.assign(Error(),{code:`MAIL_HTTP_${response.status}`,permanent:response.status<500&&response.status!==429});
      const result=await response.json();if(!result.id)throw Object.assign(Error(),{code:'MAIL_RESPONSE_INVALID'});
      await db.admin("update private.mail_jobs set status='accepted',provider_id=$2,error_code=null,lease_until=null,updated_at=now() where id=$1",[job.id,result.id]);
    }catch(error){if(job)await db.admin("update private.mail_jobs set status=$2,error_code=$3,lease_until=null,next_attempt=now()+interval '30 seconds',updated_at=now() where id=$1",[job.id,error.permanent||job.attempts>=3?'failed':'queued',error.code??'MAIL_FAILED']);}
    finally{busy=false;}
  }
  async function status(user){
    const jobs=(await db.admin("select * from private.mail_jobs where user_id=$1 and kind in ('options','itinerary') order by created_at desc limit 20",[user])).rows;
    return{mode,liveReady,jobs:jobs.map(j=>({...summary(j),email:j.email,plan_id:j.plan_id,...(j.mode==='outbox'&&j.status==='outbox'?{text:j.payload.text,has_attachment:!!j.payload.attachments?.length}:{})}))};
  }
  async function refreshStatus(user){
    if(mode==='resend'&&liveReady){
      const jobs=(await db.admin("select id,provider_id from private.mail_jobs where user_id=$1 and status='accepted' and provider_id is not null order by created_at desc limit 5",[user])).rows;
      for(const job of jobs){try{const r=await fetchImpl(`https://api.resend.com/emails/${encodeURIComponent(job.provider_id)}`,{headers:{Authorization:`Bearer ${env.RESEND_API_KEY}`},signal:AbortSignal.timeout(10000)});if(!r.ok)continue;const data=await r.json();const event=data.last_event;const state={delivered:'delivered',bounced:'bounced',complained:'complained',failed:'failed'}[event];if(state)await db.admin('update private.mail_jobs set status=$2,updated_at=now() where id=$1',[job.id,state]);}catch{}}
    }
    return status(user);
  }
  async function attachment(user,id){const row=(await db.admin("select payload from private.mail_jobs where id=$1 and user_id=$2 and mode='outbox' and status='outbox'",[uuid(id),user])).rows[0];if(!row?.payload.attachments?.[0])throw new AppError('NOT_FOUND','Attachment not found.',404);return Buffer.from(row.payload.attachments[0].content,'base64');}
  return{mode,liveReady,pdf,queueOptions,queueItinerary,tick,status,refreshStatus,attachment};
}
