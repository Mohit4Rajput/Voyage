import test from 'node:test';
import assert from 'node:assert/strict';
import { runResearch } from '../research.mjs';
import { Providers } from '../providers.mjs';
import { brief, sources, options, plan } from './fixtures.mjs';
import { optionTask, planTask, candidateTask, transportDiscoveryQueries, researchQueries, researchRules } from '../prompts.mjs';
import { normalizeBrief } from '../../supabase/functions/_shared/domain.mjs';

test('transport discovery precedes candidate generation and feeds sourced cross-state comparison',async()=>{
  const calls=[];let candidateInput;let saved;
  const p={model:'fixture:free',async search(query){calls.push('search');return sources.map(({id,...s})=>s);},async generate(system,input){calls.push('model');if(input.required_shape.candidates){candidateInput=input;return{candidates:[{destination:'Fixture town',region:'Fixture region',why:'Rest'}]};}return options();}};
  await runResearch({job:{kind:'options',brief_revision:1},brief,providers:p,save:async cp=>{saved=structuredClone(cp);}});
  assert.deepEqual(calls.slice(0,4),['search','search','search','model']);
  assert.equal(candidateInput.transport_evidence[0].id,'s1');
  assert.match(candidateInput.task,/Follow brief.travel_scope strictly/);
  assert.match(candidateInput.task,/outbound AND return/);
  assert.match(candidateInput.task,/no preferred country, carrier or transport mode/);
  assert.equal(saved.search_calls,6);
});

test('international honeymoon remains international without passport or visa information',()=>{
  const normalized=normalizeBrief({...brief,departure_location:'Ahmedabad',intent:'International honeymoon',entry_eligibility:'Domestic India only.'});
  assert.equal(normalized.travel_scope,'international');
  assert.equal(normalized.entry_eligibility,undefined);
  const queries=transportDiscoveryQueries(normalized);
  assert.ok(queries.every(q=>q.includes('international destinations outside the departure country')));
  assert.doesNotMatch(queries.join(' '),/Vande Bharat|interstate|other states/);
  assert.match(candidateTask(normalized).task,/do not substitute domestic destinations/);
  assert.match(researchRules,/must NEVER favor domestic destinations/);
});

test('travel scope defaults to either, respects explicit choices and rejects conflicting preferences',()=>{
  assert.equal(normalizeBrief(brief).travel_scope,'either');
  assert.equal(normalizeBrief({...brief,travel_scope:'international'}).travel_scope,'international');
  assert.equal(normalizeBrief({...brief,constraints:'Domestic-only'}).travel_scope,'domestic');
  assert.throws(()=>normalizeBrief({...brief,travel_scope:'international',constraints:'Domestic-only'}),/conflicts/);
  assert.throws(()=>normalizeBrief({...brief,travel_scope:'domestic',intent:'International honeymoon'}),/conflicts/);
  assert.throws(()=>normalizeBrief({...brief,travel_scope:'invalid'}));
  assert.match(transportDiscoveryQueries(normalizeBrief(brief)).join(' '),/domestic and international/);
  assert.match(researchQueries(normalizeBrief(brief),[{destination:'Test town',region:'Test country'}])[0],/flight rail bus ferry/);
});

test('transport discovery resumes without repeating completed searches',async()=>{
  let saved,calls=0;
  const first={model:'fixture:free',async search(){if(++calls===2)throw Error('interrupted');return sources.map(({id,...s})=>s);},async generate(){throw Error('must search first');}};
  await assert.rejects(runResearch({job:{kind:'options',brief_revision:1},brief,providers:first,save:async cp=>{saved=structuredClone(cp);}}),/interrupted/);
  assert.equal(saved.discovery_index,1);
  const resumed=provider([{candidates:[{destination:'Fixture town',region:'Fixture region',why:'Rest'}]},options()]);
  const out=await runResearch({job:{kind:'options',brief_revision:1},brief,checkpoint:saved,providers:resumed,save:async()=>{}});
  assert.equal(resumed.calls.search,5);
  assert.equal(out.result.usage.search_calls,7);
});

test('four candidates plus transport discovery stay inside the original search ceiling',async()=>{
  const p=provider([{candidates:['A','B','C','D'].map(destination=>({destination,region:'Fixture region',why:'Rest'}))},options()]);
  const out=await runResearch({job:{kind:'options',brief_revision:1},brief,providers:p,save:async()=>{}});
  assert.equal(p.calls.search,15);
  assert.equal(out.result.usage.search_calls,15);
});

test('detailed plan treats previous-stage ideas as unverified and removes stale citation labels', () => {
  const task=planTask(brief,{sources},{destination:'Fixture town',local_experiences:['Visit a property (s30)'],tradeoffs:['Long route from s28']});
  assert.deepEqual(task.allowed_source_ids,['s1']);
  assert.doesNotMatch(JSON.stringify(task.selected_option),/\bs30\b|\bs28\b/);
  assert.match(task.task,/Earlier-stage citation IDs are invalid/);
  assert.match(task.task,/Never use a meal price as an activity price/);
});

test('missing stay prices recover as provisional options rather than rejecting all destinations', async () => {
  const provisional = options();
  const stayCost = provisional.options[0].cost_lines.find(c => c.category === 'stay');
  Object.assign(stayCost, { status: 'unknown', price_evidence: null, assumption: 'Named property found; date-specific room price is unavailable.' });
  const p = provider([{ candidates: [{ destination: 'Fixture town', region: 'Fixture region', why: 'Rest' }] }, { options: [], research_notes: 'No date-specific stay quote.' }, provisional]);
  let checkpoint;
  const out = await runResearch({ job: { kind: 'options', brief_revision: 1 }, brief, providers: p, save: async cp => { checkpoint = structuredClone(cp); } });
  assert.equal(p.calls.search, 7);
  assert.equal(out.result.options.length, 1);
  assert.equal(out.result.options[0].status, 'needs_research');
  assert.equal(out.result.options[0].budget.within_budget, null);
  assert.equal(checkpoint.stay_recovery_complete, true);
  const resumed = provider([]);
  await runResearch({ job: { kind: 'options', brief_revision: 1 }, brief, checkpoint, providers: resumed, save: async () => {} });
  assert.equal(resumed.calls.search, 0);
  assert.equal(resumed.calls.model, 0);
  assert.match(optionTask(brief, checkpoint).task, /date-specific quote is NOT required/);
});

test('accommodation recovery respects search ceiling and never invents missing properties', async () => {
  const empty = { options: [], research_notes: 'No real named properties found.' };
  const p = provider([empty, empty]);
  const out = await runResearch({ job: { kind: 'options', brief_revision: 1 }, brief, checkpoint: {
    candidates: [{ id: 'candidate_1', destination: 'Fixture town', region: 'Fixture region' }], queries: [], sources, search_calls: 16,
  }, providers: p, save: async () => {} });
  assert.equal(p.calls.search, 0);
  assert.equal(p.calls.model, 2);
  assert.equal(out.result.options.length, 1);
  assert.equal(out.result.options[0].status,'needs_research');
});

function provider(responses) {
  const calls = { model: 0, search: 0 };
  return { model: 'fixture:free', calls,
    async generate() { calls.model++; const response=responses.shift(); if (response instanceof Error) throw response; return response; },
    async search() { calls.search++; return sources.map(({ id, ...s }) => s); } };
}

test('an unsupported stay leaves the destination visible as a provisional idea',async()=>{
  const mixed=options();
  mixed.options.push({...structuredClone(mixed.options[0]),candidate_id:'candidate_2',stays:[{...mixed.options[0].stays[0],name:'Invented hotel'}]});
  const p=provider([{candidates:[{destination:'Fixture town',region:'Fixture region',why:'Rest'},{destination:'Second town',region:'Fixture region',why:'Culture'}]},mixed]);
  const out=await runResearch({job:{kind:'options',brief_revision:1},brief,providers:p,save:async()=>{}});
  assert.equal(out.result.options.length,2);
  assert.equal(out.result.options[0].destination,'Fixture town');
  assert.equal(out.result.options[1].status,'needs_research');
  assert.equal(out.result.options[1].stays.length,0);
  assert.equal(out.result.options[1].budget.within_budget,null);
  assert.match(out.result.research_notes,/retained as provisional/);
  assert.equal(p.calls.model,2);
});
test('stage one researches before synthesis and computes output', async () => {
  const p=provider([{ candidates: [{ destination: 'Fixture town', region: 'Fixture region', why: 'Rest' }] }, options()]);
  const states=[];
  const out=await runResearch({ job: { kind: 'options', brief_revision: 1 }, brief, providers:p, save:async(cp,s) => states.push(s) });
  assert.equal(p.calls.search,6); assert.equal(p.calls.model,2);
  assert.equal(out.result.options[0].budget.within_budget,true);
  assert.ok(states.includes('validating')); assert.equal(out.sources.length,1);
});
test('stage two produces full itinerary without regenerating candidates', async () => {
  const p=provider([plan()]);
  const out=await runResearch({ job:{kind:'itinerary',brief_revision:1},brief,selectedOption:{destination:'Fixture town',region:'Fixture region'},providers:p,save:async()=>{} });
  assert.equal(p.calls.search,7); assert.equal(p.calls.model,1); assert.equal(out.result.days.length,3);
});
test('saved search checkpoints avoid charging for completed searches on retry', async () => {
  let saved;
  const p=provider([{candidates:[{destination:'Fixture town',region:'Fixture region',why:'Rest'}]},new Error('Fixture interruption')]);
  await assert.rejects(runResearch({job:{kind:'options',brief_revision:1},brief,providers:p,save:async cp=>{saved=structuredClone(cp);}}));
  const resumed=provider([options()]);
  await runResearch({job:{kind:'options',brief_revision:1},brief,checkpoint:saved,providers:resumed,save:async()=>{}});
  assert.equal(resumed.calls.search,0); assert.equal(resumed.calls.model,1);
});
test('cancelled lease stops provider calls', async () => {
  const p=provider([]);
  await assert.rejects(runResearch({job:{kind:'options'},brief,providers:p,save:async()=>{},ensureActive:()=>{throw new Error('Lease lost');}}));
  assert.equal(p.calls.model,0); assert.equal(p.calls.search,0);
});
test('invalid citations retain the destination with unknown costs and no invented references', async () => {
  const bad=options();bad.options[0].source_ids=['invented'];
  const p=provider([{candidates:[{destination:'Fixture town',region:'Fixture region',why:'Rest'}]},bad]);
  const out=await runResearch({job:{kind:'options',brief_revision:1},brief,providers:p,save:async()=>{}});
  assert.equal(out.result.options.length,1);assert.equal(out.result.options[0].status,'needs_research');
  assert.deepEqual(out.result.options[0].source_ids,[]);assert.equal(out.result.options[0].budget.within_budget,null);
  assert.equal(p.calls.model,2);
});
test('malformed option structure preserves all three researched destinations',async()=>{
  const p=provider([{candidates:['A','B','C'].map(destination=>({destination,region:'Test region',why:'Potential cultural trip'}))},{unexpected:'missing options'}]);
  const out=await runResearch({job:{kind:'options',brief_revision:1},brief,providers:p,save:async()=>{}});
  assert.deepEqual(out.result.options.map(o=>o.destination),['A','B','C']);
  assert.ok(out.result.options.every(o=>o.status==='needs_research'&&o.stays.length===0&&o.budget.party_total_max_minor===null));
});

test('model price changes prevent completion calls and no paid fallback is attempted', async () => {
  const urls=[];
  const p=new Providers({OPENROUTER_MODEL:'test:free'}, {fetchImpl:async url=>{urls.push(url);return new Response(JSON.stringify({data:[{id:'test:free',pricing:{prompt:'0.01',completion:'0'},supported_parameters:['response_format']}]}));}});
  await assert.rejects(p.generate('system',{}),/no longer free/);
  assert.equal(urls.length,1);
});
test('checkpoint cannot be reused with a changed brief',async()=>{
  const p=provider([]);
  await assert.rejects(runResearch({job:{kind:'options'},brief,checkpoint:{input_hash:'not-the-same-brief'},providers:p,save:async()=>{}}),error=>error.code==='CHECKPOINT_INPUT_MISMATCH');
  assert.equal(p.calls.model,0);
});
test('provider disables optional reasoning and never enables paid search plugins',async()=>{
  let payload;
  const p=new Providers({OPENROUTER_MODEL:'fixture:free'}, {fetchImpl:async(url,options)=>{
    if(url.endsWith('/models'))return new Response(JSON.stringify({data:[{id:'fixture:free',pricing:{prompt:'0',completion:'0'},supported_parameters:['response_format','reasoning'],reasoning:{mandatory:false}}]}));
    payload=JSON.parse(options.body);return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]}));
  }});
  assert.deepEqual(await p.generate('system',{}),{ok:true});
  assert.equal(payload.reasoning.enabled,false);assert.equal(payload.plugins,undefined);assert.equal(payload.tools,undefined);
});
