import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { createLocalDatabase } from './database.mjs';
import { createFixtureProvider } from './fixture-provider.mjs';
import { root, loadEnv } from '../env.mjs';
import { Providers } from '../providers.mjs';
import { runResearch } from '../research.mjs';
import { AppError, uuid } from '../../supabase/functions/_shared/domain.mjs';
import { buildCommand, mapDatabaseError } from '../../supabase/functions/_shared/commands.mjs';
import { createDelivery } from '../delivery.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const files=new Map([['/',['index.html','text/html']],['/app.mjs',['app.mjs','text/javascript']],['/style.css',['style.css','text/css']]]);
async function bodyJson(request){
  let size=0;const chunks=[];
  for await(const chunk of request){size+=chunk.length;if(size>20000)throw new AppError('PAYLOAD_TOO_LARGE','Maximum input is 20 KB.',413);chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new AppError('INVALID_JSON','Expected JSON input.');}
}
export async function startLocalApp({port=4173,dataDir=path.join(root,'backend/.local/database'),env,autoWorker=true}={}){
  env??=await loadEnv();
  const dailyResearchLimit=Number(env.LOCAL_DAILY_RESEARCH_LIMIT??20);
  const db=await createLocalDatabase(dataDir,{dailyResearchLimit});
  const model=JSON.parse(await fs.readFile(path.join(root,'backend/model-config.json'),'utf8')).model;
  let busy=false,stopping=false,workerTask=null,commands=Promise.resolve();
  const serialCommand=fn=>{const result=commands.then(fn,fn);commands=result.catch(()=>{});return result;};
  let publicOrigin;
  const delivery=createDelivery({db,env,origin:()=>publicOrigin});
  const server=http.createServer(async(request,response)=>{
    const requestId=crypto.randomUUID();
    const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"};
    const reply=(data,status=200,extra={})=>{response.writeHead(status,{'Content-Type':'application/json',...headers,...extra});response.end(JSON.stringify({data,error:null,requestId}));};
    try{
      const host=request.headers.host;
      if(host!==new URL(publicOrigin).host)throw new AppError('HOST_NOT_ALLOWED','Use the local URL printed in the terminal.',403);
      if(request.headers.origin&&request.headers.origin!==publicOrigin)throw new AppError('ORIGIN_NOT_ALLOWED','Cross-origin requests are not allowed.',403);
      const url=new URL(request.url,publicOrigin);
      if(request.method==='GET'&&files.has(url.pathname)){
        const[file,type]=files.get(url.pathname);
        const content=await fs.readFile(path.join(root,'backend/local/ui',file));
        response.writeHead(200,{'Content-Type':type,...headers});response.end(content);return;
      }
      if(request.method==='GET'&&url.pathname==='/api/health'){
        reply({database:'embedded Postgres (PGlite)',auth:'local session simulation',deployment:'local only',fixtureAvailable:true,liveAvailable:!!(env.OPENROUTER_API_KEY&&env.TAVILY_API_KEY),dailyResearchLimit,model,mailMode:delivery.mode,mailReady:delivery.liveReady});return;
      }
      if(url.pathname.startsWith('/api/email/'))throw new AppError('FEATURE_REMOVED','Email sharing is disabled. Download the itinerary PDF instead.',410);
      const cookies=String(request.headers.cookie??'').split(';').map(c=>c.trim());
      const headerToken=request.headers['x-voyage-local-session'];
      const token=headerToken||cookies.find(c=>c.startsWith('voyage_local='))?.slice('voyage_local='.length);
      let userId=null;
      if(token&&/^[a-f0-9]{64}$/.test(token))userId=(await db.admin('select user_id from private.local_sessions where token_hash=$1',[hash(token)])).rows[0]?.user_id;
      if(request.method==='POST'&&url.pathname==='/api/session'){
        const input=await bodyJson(request);
        if(input.isolated===true&&!headerToken)userId=null;
        let nextToken;
        if(!userId||input.newUser===true){
          userId=crypto.randomUUID();nextToken=randomBytes(32).toString('hex');
          await db.admin('insert into auth.users(id) values($1)',[userId]);
          await db.admin('insert into private.local_sessions(token_hash,user_id) values($1,$2)',[hash(nextToken),userId]);
        }
        reply({userId,authMode:'local_session_simulation',...(input.isolated===true&&nextToken?{localToken:nextToken}:{})},200,nextToken&&input.isolated!==true?{'Set-Cookie':`voyage_local=${nextToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`}:{});return;
      }
      if(!userId)throw new AppError('UNAUTHORIZED','Start a local test session.',401);
      if(request.method==='GET'&&url.pathname==='/api/plan.pdf'){
        const bytes=await delivery.pdf(userId,url.searchParams.get('planId'));
        response.writeHead(200,{'Content-Type':'application/pdf','Content-Disposition':'attachment; filename="voyage-itinerary.pdf"',...headers,'Content-Type':'application/pdf'});response.end(bytes);return;
      }
      if(request.method==='GET'&&url.pathname==='/api/state'){
        const tripId=url.searchParams.get('tripId');if(tripId)uuid(tripId);
        const state=await db.asUser(userId,async conn=>{
          const trips=(await conn.query('select * from public.trips order by updated_at desc')).rows;
          const trip=tripId?trips.find(t=>t.id===tripId):trips[0];
          if(tripId&&!trip)throw new AppError('NOT_FOUND','Trip not found.',404);
          if(!trip)return{trips,trip:null,brief:null,jobs:[],options:[],plans:[],sources:[]};
          const brief=(await conn.query('select brief from public.trip_brief_revisions where trip_id=$1 and revision=$2',[trip.id,trip.current_revision])).rows[0]?.brief;
          const jobs=(await conn.query('select * from public.research_jobs where trip_id=$1 order by created_at desc',[trip.id])).rows;
          const options=(await conn.query('select * from public.trip_options where trip_id=$1 and brief_revision=$2 order by created_at desc,rank',[trip.id,trip.current_revision])).rows;
          const plans=(await conn.query('select * from public.itinerary_versions where trip_id=$1 order by created_at desc',[trip.id])).rows;
          const sources=(await conn.query('select s.* from public.research_sources s join public.research_jobs j on j.id=s.job_id where j.trip_id=$1',[trip.id])).rows;
          return{trips,trip,brief,jobs,options,plans,sources};
        });
        const modes=(await db.admin('select job_id,mode from private.local_job_modes where job_id=any($1::uuid[])',[state.jobs.map(j=>j.id)])).rows;
        state.jobs=state.jobs.map(j=>({...j,mode:modes.find(m=>m.job_id===j.id)?.mode??'fixture'}));
        reply({...state,userId});return;
      }
      if(request.method==='POST'&&url.pathname==='/api/command'){
        const input=await bodyJson(request);
        const {name,args,issuedToken}=await buildCommand(input);
        const data=await serialCommand(async()=>{
          const mode=input.mode??'fixture';
          if(!['fixture','live'].includes(mode))throw new AppError('VALIDATION_ERROR','Choose fixture or live mode.');
          if(name==='enqueue_research'&&args.p_kind==='itinerary'){
            const selected=(await db.asUser(userId,c=>c.query('select o.content from public.trips t join public.trip_options o on o.id=t.selected_option_id where t.id=$1',[args.p_trip_id]))).rows[0];
            if(selected&&(selected.content.execution_mode??'live')!==mode)throw new AppError('CONFLICT','Choose an option generated in the same research mode before building a plan.',409);
          }
          if(name==='enqueue_research'&&mode==='live'){
            if(!env.OPENROUTER_API_KEY||!env.TAVILY_API_KEY)throw new AppError('MISSING_KEYS','Save the provider keys in root .env first.');
            const count=(await db.admin("select count(*) as n from private.local_job_modes m join public.research_jobs j on j.id=m.job_id where m.mode='live' and j.kind=$1 and j.created_at>now()-interval '1 day'",[args.p_kind])).rows[0].n;
            const prior=(await db.asUser(userId,c=>c.query('select id from public.research_jobs where trip_id=$1 and request_key=$2',[args.p_trip_id,args.p_request_key]))).rows;
            if(Number(count)>=dailyResearchLimit&&!prior.length)throw new AppError('RATE_LIMITED',`Local live research allows ${dailyResearchLimit} destination searches and ${dailyResearchLimit} itinerary builds per rolling 24 hours. Earlier attempts still count; increase LOCAL_DAILY_RESEARCH_LIMIT in root .env and restart for more testing capacity.`,429);
          }
          let result;
          try{result=await db.rpc(userId,name,args);}catch(error){
            if(name==='enqueue_research'&&error.code==='RATE_LIMITED')throw new AppError('RATE_LIMITED',`Local testing allows ${dailyResearchLimit} ${args.p_kind==='options'?'destination searches':'itinerary builds'} per user per rolling 24 hours, including failed and cancelled attempts. Increase LOCAL_DAILY_RESEARCH_LIMIT in root .env and restart if needed.`,429);
            throw error;
          }
          if(name==='enqueue_research'){
            const prior=(await db.admin('select mode from private.local_job_modes where job_id=$1',[result.id])).rows[0];
            if(prior&&prior.mode!==mode)throw new AppError('CONFLICT','This request ID already belongs to a different execution mode.',409);
            await db.admin('insert into private.local_job_modes(job_id,mode) values($1,$2) on conflict do nothing',[result.id,mode]);
          }
          return issuedToken?{id:result,token:issuedToken}:result;
        });
        reply(data,['research-options','build-itinerary'].includes(input.action)?202:200);return;
      }
      throw new AppError('NOT_FOUND','Not found.',404);
    }catch(error){
      const safe=error instanceof AppError?error:new AppError('LOCAL_ERROR','Local request failed. Check the terminal.',500);
      if(!(error instanceof AppError))console.error('Local request failed (details withheld).');
      response.writeHead(safe.status,{'Content-Type':'application/json',...headers});response.end(JSON.stringify({data:null,error:{code:safe.code,message:safe.message},requestId}));
    }
  });
  async function tick(){
    if(busy||stopping)return;
    busy=true;
    let claim,timer,active=true;
    try{
      const candidate=(await db.admin("select j.id from public.research_jobs j join private.local_job_modes m on m.job_id=j.id join private.job_state s on s.job_id=j.id where j.status not in ('completed','failed','cancelled') and s.available_at<=now() and (s.lease_until is null or s.lease_until<now()) order by j.created_at limit 1")).rows[0];
      if(!candidate)return;
      claim=await db.rpc(null,'worker_claim',{p_only_job:candidate.id});if(!claim)return;
      const mode=(await db.admin('select mode from private.local_job_modes where job_id=$1',[claim.job.id])).rows[0].mode;
      const providers=mode==='live'?new Providers(env,{model}):createFixtureProvider(claim.brief);
      const args={p_job_id:claim.job.id,p_lease_token:claim.lease_token};
      const ensureActive=()=>{if(!active||stopping)throw new AppError('LEASE_LOST','Job cancelled or worker stopped.');};
      timer=setInterval(async()=>{try{active=await db.rpc(null,'worker_heartbeat',args);}catch{active=false;}},30000);
      const out=await runResearch({job:claim.job,brief:claim.brief,selectedOption:claim.selected_option,checkpoint:claim.checkpoint,providers,ensureActive,
        save:async(cp,status,progress)=>{ensureActive();active=await db.rpc(null,'worker_checkpoint',{...args,p_checkpoint:cp,p_status:status,p_progress:progress});ensureActive();}});
      ensureActive();
      out.result.execution_mode=mode;
      if(out.result.options)out.result.options=out.result.options.map(o=>({...o,execution_mode:mode}));
      await db.rpc(null,'worker_complete',{...args,p_result:out.result,p_sources:out.sources});
    }catch(error){
      if(claim){const code=error instanceof AppError?error.code:'LOCAL_WORKER_ERROR';console.error(`Local research ${claim.job.id}: ${code}`);await db.rpc(null,'worker_fail',{p_job_id:claim.job.id,p_lease_token:claim.lease_token,p_code:code,p_retry:error.retryable===true}).catch(()=>{});}
      else console.error('Local worker could not claim a job.');
    }finally{if(timer)clearInterval(timer);busy=false;}
  }
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  publicOrigin=`http://127.0.0.1:${server.address().port}`;
  const interval=autoWorker?setInterval(()=>{if(!busy)workerTask=tick();},300):null;
  return{url:publicOrigin,db,tick,delivery,close:async()=>{stopping=true;if(interval)clearInterval(interval);await new Promise(r=>server.close(r));await workerTask;await db.close();}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const qa=process.argv.includes('--qa');
  const app=await startLocalApp({port:qa?4174:Number(process.env.PORT)||4173,...(qa?{dataDir:path.join(root,'backend/.local/browser-qa')}:{})});
  console.log(`Voyage local workbench: ${app.url}`);
  console.log('Embedded Postgres + simulated local sessions. Fixture mode uses no API quota.');
  const stop=()=>app.close().then(()=>process.exit(0));process.once('SIGINT',stop);process.once('SIGTERM',stop);
}
