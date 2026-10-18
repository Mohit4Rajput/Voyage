// Explicit opt-in live workflow test. Uses a fixture brief, never a real user account.
// Costs at most 16 basic Tavily searches and five model calls per stage/attempt history.
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadEnv, requireEnv, root } from './env.mjs';
import { Providers } from './providers.mjs';
import { runResearch } from './research.mjs';
import { AppError } from '../supabase/functions/_shared/domain.mjs';
try {
  const env=await loadEnv();requireEnv(env,['OPENROUTER_API_KEY','TAVILY_API_KEY']);
  const config=JSON.parse(await fs.readFile(path.join(root,'backend/model-config.json'),'utf8'));
  const brief=JSON.parse(await fs.readFile(path.join(root,'backend/examples/brief.json'),'utf8'));
  const p=new Providers(env,{model:config.model});await p.checkFreeModel();
  const directory=path.join(root,'backend/local-research');await fs.mkdir(directory,{recursive:true});
  const stage=process.argv.includes('--itinerary')?'itinerary':'options';
  let selectedOption=null;
  if(stage==='itinerary') {
    const saved=JSON.parse(await fs.readFile(path.join(directory,'options.json'),'utf8'));
    selectedOption=saved.result.options[0];
    if(!selectedOption) throw new AppError('NO_OPTIONS','No researched options are available for the itinerary smoke test.');
  }
  let checkpoint={};
  try{checkpoint=JSON.parse(await fs.readFile(path.join(directory,`${stage}-checkpoint.json`),'utf8'));}
  catch(e){if(e.code!=='ENOENT')throw e;}
  const out=await runResearch({job:{kind:stage,brief_revision:1},brief,selectedOption,checkpoint,providers:p,
    save:async(cp,status,progress)=>{
      await fs.writeFile(path.join(directory,`${stage}-checkpoint.json`),JSON.stringify(cp));
      console.log(`${status}: ${progress}`);
    }});
  await fs.writeFile(path.join(directory,`${stage}.json`),JSON.stringify(out,null,2)+'\n');
  console.log(`Validated ${stage} result saved locally (ignored by Git). ${out.sources.length} sources. ${out.result.options?.length ?? out.result.days?.length} ${stage==='options'?'options':'days'}.`);
} catch(error) {
  console.error(error instanceof AppError?`${error.code}: ${error.message}`:'Live smoke test failed; local checkpoints are preserved.');
  process.exitCode=1;
}
