import { AppError, normalizeBrief, normalizeCandidates, validateOptions, validatePlan, provisionalOption } from '../supabase/functions/_shared/domain.mjs';
import { createHash } from 'node:crypto';
import { candidateTask, optionTask, planTask, researchQueries, researchRules, accommodationRecoveryQueries, transportDiscoveryQueries } from './prompts.mjs';

export async function runResearch({ job, brief: rawBrief, selectedOption, checkpoint = {}, providers, save, ensureActive = () => {} }) {
  const brief = normalizeBrief(rawBrief);
  const cp = structuredClone(checkpoint);
  const inputHash = createHash('sha256').update(JSON.stringify({ kind: job.kind, brief, selectedOption })).digest('hex');
  if (cp.input_hash && cp.input_hash !== inputHash) throw new AppError('CHECKPOINT_INPUT_MISMATCH', 'Checkpoint belongs to a different brief or selection.');
  cp.input_hash = inputHash;
  cp.prompt_version ??= '2026-10-16.2';
  cp.sources ??= []; cp.search_index ??= 0; cp.search_calls ??= 0; cp.model_calls ??= 0;
  const persist = async (status, progress) => { ensureActive(); await save(cp, status, progress); };
  const model = async (task, tokens = 6500) => {
    if (cp.model_calls >= 5) throw new AppError('MODEL_BUDGET_EXHAUSTED', 'Research exceeded its model-call allowance.');
    cp.model_calls++;
    await persist('synthesizing', 'Synthesizing researched evidence');
    return providers.generate(researchRules, task, tokens);
  };
  if (job.kind === 'options' && !cp.candidates) {
    cp.discovery_queries ??= transportDiscoveryQueries(brief);
    cp.discovery_index ??= 0;
    while(cp.discovery_index < cp.discovery_queries.length){
      ensureActive();
      if(cp.search_calls>=16)throw new AppError('SEARCH_BUDGET_EXHAUSTED','Research exceeded its search allowance.');
      cp.search_calls++;
      await persist('researching',`Comparing transport connections ${cp.discovery_index+1} of ${cp.discovery_queries.length}`);
      const found=await providers.search(cp.discovery_queries[cp.discovery_index]);
      for(const source of found){
        const existing=cp.sources.find(s=>s.url===source.url);
        if(!existing)cp.sources.push({...source,id:`s${cp.sources.length+1}`});
        else if(!existing.content.includes(source.content))existing.content=`${existing.content}\n${source.content}`.slice(-6000);
      }
      cp.discovery_index++;
      await persist('researching','Transport discovery evidence saved');
    }
    cp.candidates = normalizeCandidates(await model(candidateTask(brief, cp.excluded_destinations ?? [], cp.sources), 2600));
    await persist('researching', 'Candidate hypotheses prepared');
  }
  if (job.kind === 'itinerary' && !selectedOption) throw new AppError('MISSING_SELECTION', 'Select a destination first.');
  cp.queries ??= researchQueries(brief, cp.candidates, selectedOption);
  for (; cp.search_index < cp.queries.length;) {
    ensureActive();
    if (cp.search_calls >= 16) throw new AppError('SEARCH_BUDGET_EXHAUSTED', 'Research exceeded its search allowance.');
    cp.search_calls++;
    await persist('researching', `Searching ${cp.search_index + 1} of ${cp.queries.length}`);
    const found = await providers.search(cp.queries[cp.search_index]);
    // Preserve independent IDs for evidence even when sources are reused by searches.
    for (const source of found) {
      if (!cp.sources.some(s => s.url === source.url)) cp.sources.push({ ...source, id: `s${cp.sources.length + 1}` });
    }
    cp.search_index++;
    await persist('researching', `Retrieved evidence ${cp.search_index} of ${cp.queries.length}`);
  }
  if (!cp.sources.length && job.kind !== 'options') throw new AppError('NO_RESEARCH_EVIDENCE', 'No usable sources were retrieved.');
  let task = job.kind === 'options' ? optionTask(brief, cp) : planTask(brief, cp, selectedOption);
  if (!cp.raw_output) {
    cp.raw_output = await model(task, job.kind === 'options' ? 7000 : 12000);
    await persist('validating', 'Checking costs, dates, sources and plan structure');
  }
  // A missing date-specific quote must not turn otherwise useful research into
  // a dead end. Broaden property discovery once, within the existing quota.
  // Checkpoint the index before each request so retries retain the hard ceiling.
  if (job.kind === 'options' && Array.isArray(cp.raw_output?.options) && cp.raw_output.options.length === 0 && !cp.stay_recovery_complete) {
    cp.stay_recovery_index ??= 0;
    const queries = accommodationRecoveryQueries(brief, cp.candidates);
    while (cp.stay_recovery_index < queries.length && cp.search_calls < 16) {
      ensureActive();
      cp.search_calls++;
      const query = queries[cp.stay_recovery_index++];
      await persist('researching', 'Looking for named accommodation beyond date-specific price searches');
      const found = await providers.search(query);
      for (const source of found) {
        const existing = cp.sources.find(s => s.url === source.url);
        if (!existing) cp.sources.push({ ...source, id: `s${cp.sources.length + 1}` });
        else if (!existing.content.includes(source.content)) existing.content = `${existing.content}\n${source.content}`.slice(-6000);
      }
      await persist('researching', 'Accommodation discovery saved');
    }
    task = optionTask(brief, cp);
    const recovered = await model({ ...task, recovery_instruction: 'Reassess named properties in all evidence. Return provisional options with unknown stay costs when prices are missing. Do not claim the budget is verified. Return zero only if real named stays or route evidence are still absent.' }, 7000);
    cp.raw_output = recovered;
    cp.stay_recovery_complete = true;
    await persist('validating', 'Checking provisional options after accommodation discovery');
  }
  const validate = raw => {
    if(job.kind !== 'options') return validatePlan(raw, brief, cp.sources);
    const suggested=Array.isArray(raw?.options)?raw.options:[];
    const chosen=cp.candidates.filter(c=>suggested.some(o=>o?.candidate_id===c.id)).slice(0,3);
    for(const c of cp.candidates){if(chosen.length>=3)break;if(!chosen.some(x=>x.id===c.id))chosen.push(c);}
    let incomplete=0;
    const options=chosen.map((candidate,index)=>{
      const option=suggested.find(o=>o?.candidate_id===candidate.id);
      let result;
      try{
        if(!option||typeof option!=='object')throw new AppError('VALIDATION_ERROR','Structured details were not supplied.');
        result=validateOptions({options:[option],research_notes:'Research validation'},brief,cp.sources,[candidate]).options[0];
      }
      catch(error){if(!(error instanceof AppError))throw error;incomplete++;result=provisionalOption(candidate,brief,cp.sources,option,error.message);}
      return{...result,id:`option_${index+1}`};
    });
    return {options,research_notes:incomplete?`${incomplete} destination(s) retained as provisional ideas because evidence or structured details are incomplete. Prices, availability and feasibility remain unconfirmed; unsupported specifics are omitted.`:String(raw?.research_notes??'Research complete.').slice(0,2500),evidence_status:'indicative_web_research'};
  };
  let result;
  try { result = validate(cp.raw_output); }
  catch (error) {
    if (!(error instanceof AppError) || cp.repair_attempted) throw error;
    cp.repair_attempted = true;
    cp.raw_output = await model({ ...task, repair_instruction: `Correct your previous output. Validation failure: ${error.message}. Preserve evidence; do not invent data to satisfy validation.`, previous_output: cp.raw_output }, job.kind === 'options' ? 7000 : 12000);
    await persist('validating', 'Rechecking corrected output');
    result = validate(cp.raw_output);
  }
  return { result: { ...result, brief_revision: job.brief_revision, generated_at: new Date().toISOString(), model: providers.model, prompt_version: cp.prompt_version, usage: { search_calls: cp.search_calls, model_calls: cp.model_calls } }, sources: cp.sources };
}
