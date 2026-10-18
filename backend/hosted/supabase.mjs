import {AppError} from '../../supabase/functions/_shared/domain.mjs';
import {mapDatabaseError} from '../../supabase/functions/_shared/commands.mjs';

export class HostedSupabase {
  constructor(env,fetchImpl=fetch){this.env=env;this.fetch=fetchImpl;this.url=env.SUPABASE_URL.replace(/\/$/,'');}
  async call(path,{token,body,method=body?'POST':'GET',auth=false}={}){
    const r=await this.fetch(this.url+path,{method,headers:{apikey:this.env.SUPABASE_ANON_KEY,...(token?{Authorization:`Bearer ${token}`} :{}),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
    const data=await r.json().catch(()=>null);
    if(!r.ok){if(auth)throw new AppError('AUTH_FAILED','Authentication failed or expired. Check the code and try again.',401);throw mapDatabaseError(data?.message??'DATABASE_ERROR');}
    return data;
  }
  rpc(name,args,token){return this.call('/rest/v1/rpc/'+name,{token,body:args});}
  rows(table,query,token){return this.call('/rest/v1/'+table+'?'+query,{token});}
  async state(token,tripId){
    const trips=await this.rows('trips','select=*&order=created_at.desc',token);
    const trip=tripId?trips.find(t=>t.id===tripId):trips[0];
    if(tripId&&!trip)throw new AppError('NOT_FOUND','Trip not found.',404);
    if(!trip)return{trips,trip:null,brief:null,jobs:[],options:[],plans:[],sources:[]};
    const filter='trip_id=eq.'+trip.id;
    const results=await Promise.allSettled([
      this.rows('trip_brief_revisions',`${filter}&revision=eq.${trip.current_revision}&select=brief`,token),
      this.rows('research_jobs',`${filter}&select=*&order=created_at.desc`,token),
      this.rows('trip_options',`${filter}&brief_revision=eq.${trip.current_revision}&select=*&order=rank`,token),
      this.rows('itinerary_versions',`${filter}&select=*&order=created_at.desc`,token),
    ]);
    for(const r of results)if(r.status==='rejected')throw r.reason;
    const [briefs,jobs,options,plans]=results.map(r=>r.value);
    const sources=jobs.length?await this.rows('research_sources',`job_id=in.(${jobs.map(j=>j.id).join(',')})&select=*`,token):[];
    return{trips,trip,brief:briefs[0]?.brief,jobs:jobs.map(j=>({...j,mode:'live'})),options,plans,sources};
  }
}
