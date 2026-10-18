import fs from 'node:fs/promises';
import path from 'node:path';
import { loadEnv, requireEnv, root } from './env.mjs';
import { Providers } from './providers.mjs';
import { AppError } from '../supabase/functions/_shared/domain.mjs';
try {
  const env=await loadEnv();requireEnv(env,['OPENROUTER_API_KEY','TAVILY_API_KEY']);
  const config=JSON.parse(await fs.readFile(path.join(root,'backend/model-config.json'),'utf8'));
  const p=new Providers(env,{model:config.model});
  await p.checkFreeModel();
  console.log('Pinned model is available with zero token pricing.');
  const sources=await p.search('Karnataka official tourism responsible travel Chikmagalur');
  if(!sources.length) throw new AppError('NO_SEARCH_RESULTS','Search returned no usable sources.');
  console.log(`Tavily returned ${sources.length} usable HTTPS sources.`);
  const output=await p.generate('Return JSON only. Do not invent sources or prices.',{
    task:'Return {"source_url": one exact supplied URL, "live_price_available": false}. Supplied search excerpts do not contain a date-specific confirmed booking quote.',
    sources,
  },1000);
  if(!sources.some(s=>s.url===output.source_url)||output.live_price_available!==false) throw new AppError('EVIDENCE_CHECK_FAILED','Provider did not preserve evidence limitations.');
  console.log('OpenRouter structured evidence check passed. No keys or raw responses were logged.');
} catch(error) {
  console.error(error instanceof AppError?`${error.code}: ${error.message}`:'Provider check failed. Check local credentials and connectivity.');
  process.exitCode=1;
}
