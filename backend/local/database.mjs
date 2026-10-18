import fs from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { root } from '../env.mjs';
import { mapDatabaseError } from '../../supabase/functions/_shared/commands.mjs';
import { AppError } from '../../supabase/functions/_shared/domain.mjs';

export async function createLocalDatabase(dataDir, { dailyResearchLimit = 20 } = {}) {
  if(!Number.isInteger(dailyResearchLimit)||dailyResearchLimit<1||dailyResearchLimit>100)throw new Error('Local daily research limit must be an integer from 1 to 100.');
  if(dataDir)await fs.mkdir(dataDir,{recursive:true});
  const db=new PGlite(dataDir||undefined);
  await db.exec(`create table if not exists public.local_migrations(name text primary key);
    do $$begin
      if not exists(select 1 from pg_roles where rolname='authenticated')then
        create role anon;create role authenticated;create role service_role bypassrls;
      end if;
    end$$;
    create schema if not exists auth;
    create table if not exists auth.users(id uuid primary key);
    create or replace function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to anon,authenticated,service_role;`);
  for(const file of (await fs.readdir(path.join(root,'supabase/migrations'))).filter(f=>f.endsWith('.sql')).sort()){
    const applied=await db.query('select 1 from public.local_migrations where name=$1',[file]);
    if(!applied.rows.length){
      await db.exec('begin');
      try{await db.exec(await fs.readFile(path.join(root,'supabase/migrations',file),'utf8'));await db.query('insert into public.local_migrations values($1)',[file]);await db.exec('commit');}
      catch(e){await db.exec('rollback');throw e;}
    }
  }
  await db.exec(`create table if not exists private.local_sessions(token_hash text primary key,user_id uuid not null references auth.users(id),created_at timestamptz default now());
    create table if not exists private.local_job_modes(job_id uuid primary key references public.research_jobs(id) on delete cascade,mode text not null check(mode in ('fixture','live')));`);
  // Local workbench override only. Hosted Supabase retains its migration policy.
  const quotaFunction=await fs.readFile(path.join(root,'supabase/migrations/202610150003_stage_quotas.sql'),'utf8');
  const quotaClause=">= 3 then raise exception 'RATE_LIMITED'";
  if(!quotaFunction.includes(quotaClause))throw new Error('Local quota override no longer matches the database function.');
  await db.exec(quotaFunction.replace(quotaClause,`>= ${dailyResearchLimit} then raise exception 'RATE_LIMITED'`));
  let pending=Promise.resolve();
  const exclusive=fn=>{const result=pending.then(fn,fn);pending=result.catch(()=>{});return result;};
  const admin=(sql,args=[])=>exclusive(()=>db.query(sql,args));
  async function asUser(uid,fn){
    return exclusive(async()=>{
      await db.exec('begin;set local role authenticated;');
      try{await db.query("select set_config('request.jwt.claim.sub',$1,true)",[uid]);const result=await fn(db);await db.exec('commit');return result;}
      catch(e){await db.exec('rollback');throw e instanceof AppError?e:mapDatabaseError(e.message);}
    });
  }
  async function rpc(uid,name,args){
    if(!/^[a-z_]+$/.test(name))throw Error('Invalid RPC name');
    const values=Object.values(args),placeholders=values.map((_,i)=>`$${i+1}`).join(',');
    const invoke=async conn=>(await conn.query(`select to_jsonb(public.${name}(${placeholders})) as value`,values)).rows[0]?.value;
    return uid?asUser(uid,invoke):exclusive(()=>invoke(db));
  }
  return{admin,asUser,rpc,close:()=>exclusive(()=>db.close())};
}
