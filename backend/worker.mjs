import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadEnv, root, requireEnv } from './env.mjs';
import { Providers } from './providers.mjs';
import { SupabaseAdmin } from './supabase-rest.mjs';
import { runResearch } from './research.mjs';
import { AppError, uuid } from '../supabase/functions/_shared/domain.mjs';

async function main() {
  const env = await loadEnv();
  requireEnv(env, ['SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','OPENROUTER_API_KEY','TAVILY_API_KEY']);
  const config = JSON.parse(await fs.readFile(path.join(root, 'backend/model-config.json'), 'utf8'));
  const db = new SupabaseAdmin(env), providers = new Providers(env, { model: config.model, beforeCall:async kind=>{
    if(!await db.rpc('reserve_provider_call',{p_kind:kind}))throw new AppError('GLOBAL_BUDGET_EXHAUSTED','Global API allowance exhausted. Try again after the UTC period resets.',429);
  } });
  const onlyJob = env.ONLY_JOB_ID ? uuid(env.ONLY_JOB_ID) : null;
  const once = process.argv.includes('--once');
  const pollMs = Math.min(60000, Math.max(2000, Number(env.WORKER_POLL_MS) || 5000));
  // Fail before claiming/charging work if the configured model has changed price.
  await providers.checkFreeModel();
  console.log(`Worker ready. Pinned free model: ${providers.model}. Paid fallback disabled.`);
  let stopping = false;
  process.once('SIGINT', () => { stopping = true; });
  process.once('SIGTERM', () => { stopping = true; });
  do {
    const claim = await db.rpc('worker_claim', { p_only_job: onlyJob });
    if (!claim) {
      if (once) { console.log('No eligible jobs.'); break; }
      await delay(pollMs); continue;
    }
    const { job, lease_token: leaseToken } = claim;
    let active = true, heartbeatBusy = false;
    const ensureActive = () => { if (!active) throw new AppError('LEASE_LOST', 'Job cancelled or lease lost.'); };
    const timer = setInterval(async () => {
      if (heartbeatBusy || !active) return;
      heartbeatBusy = true;
      try { active = await db.rpc('worker_heartbeat', { p_job_id: job.id, p_lease_token: leaseToken }); }
      catch { active = false; }
      finally { heartbeatBusy = false; }
    }, 30000);
    try {
      console.log(`Research job ${job.id}: ${job.kind}.`);
      const { result, sources } = await runResearch({ job, brief: claim.brief, selectedOption: claim.selected_option, checkpoint: claim.checkpoint, providers, ensureActive,
        save: async (checkpoint, status, progress) => {
          ensureActive();
          const saved = await db.rpc('worker_checkpoint', { p_job_id: job.id, p_lease_token: leaseToken, p_checkpoint: checkpoint, p_status: status, p_progress: progress });
          if (!saved) { active = false; ensureActive(); }
        },
      });
      ensureActive();
      const complete = await db.rpc('worker_complete', { p_job_id: job.id, p_lease_token: leaseToken, p_result: result, p_sources: sources });
      console.log(`Job ${job.id}: ${complete ? 'completed' : 'discarded (inputs changed or lease lost)'}.`);
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'WORKER_ERROR';
      // No raw HTTP bodies, prompts, briefs or credentials in logs.
      console.error(`Job ${job.id}: ${code}.`);
      if (active) {
        try { await db.rpc('worker_fail', { p_job_id: job.id, p_lease_token: leaseToken, p_code: code, p_retry: error.retryable === true || code === 'DATABASE_UNAVAILABLE' }); }
        catch { console.error('Could not record failure; expired lease will allow recovery.'); }
      }
    } finally { active = false; clearInterval(timer); }
    if (once) break;
  } while (!stopping);
}
main().catch(error => {
  console.error(error instanceof AppError ? `${error.code}: ${error.message}` : 'Worker startup failed. Check server configuration and network access.');
  process.exitCode = 1;
});
