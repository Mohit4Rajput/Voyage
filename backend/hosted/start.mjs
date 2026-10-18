import {spawn} from 'node:child_process';
import {startHostedApp} from './server.mjs';
import {loadEnv,requireEnv} from '../env.mjs';
import {SupabaseAdmin} from '../supabase-rest.mjs';
const env=await loadEnv();
requireEnv(env,['SUPABASE_SERVICE_ROLE_KEY','OPENROUTER_API_KEY','TAVILY_API_KEY']);
if(!await new SupabaseAdmin(env).rpc('hosting_ready',{}))throw Error('Apply migrations and enable hosting limits before starting hosted mode.');
const app=await startHostedApp({env});
const worker=spawn(process.execPath,['backend/worker.mjs'],{env:{...env,HOSTED_MODE:'true'},stdio:'inherit'});
let closing=false;
async function stop(code=0){if(closing)return;closing=true;worker.kill('SIGTERM');await app.close();process.exit(code);}
worker.once('exit',()=>{if(!closing){console.error('Worker stopped; restarting service is required.');stop(1);}});
process.once('SIGTERM',()=>stop());process.once('SIGINT',()=>stop());
