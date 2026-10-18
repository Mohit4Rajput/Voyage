import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBrief, validateOptions, validatePlan, calculateBudget, safeUrl } from '../../supabase/functions/_shared/domain.mjs';
import { brief, candidates, costLines, sources, options, plan } from './fixtures.mjs';

test('brief dates include both travel days; invalid dates, contradictions and occupancy rejected', () => {
  assert.equal(normalizeBrief(brief).nights, 2);
  for (const change of [{ end_date: '2026-11-07' }, { end_date:'2026-11-08' }, { end_date:'2026-11-23' }, { start_date: '2026-02-30' }, { adults: undefined }, { rooms: 3 }, { moods: ['rest','REST','nature'] }, { budget_scope: 'stays_only' }]) {
    assert.throws(() => normalizeBrief({ ...brief, ...change }));
  }
});

test('travel days are derived from dates without requiring or trusting a manual duration',()=>{
  const {number_of_days,...withoutDuration}=brief;
  assert.equal(normalizeBrief(withoutDuration).number_of_days,3);
  assert.equal(normalizeBrief({...brief,number_of_days:99,end_date:'2026-11-11'}).number_of_days,4);
  assert.equal(normalizeBrief({...withoutDuration,start_date:'2028-02-28',end_date:'2028-03-01'}).number_of_days,3);
  assert.equal(normalizeBrief({...withoutDuration,start_date:'2026-12-30',end_date:'2027-01-02'}).nights,3);
});
test('budget is calculated from whole-party lines with contingency and allocation', () => {
  const b = calculateBudget(costLines(), normalizeBrief(brief), new Set(['s1']), sources);
  assert.equal(b.party_total_max_minor, 110400);
  assert.equal(b.per_person_max_minor, 55200);
  assert.equal(b.within_budget, true);
  assert.equal(calculateBudget(costLines(), { ...normalizeBrief(brief), budget_per_person_minor: 100 }, new Set(['s1']), sources).within_budget, false);
});
test('unknown essentials never become zero-cost or within-budget promises', () => {
  const lines = costLines(); lines[0] = { ...lines[0], status: 'unknown', party_min_minor: null, party_max_minor: null, source_ids: [] };
  const b = calculateBudget(lines, normalizeBrief(brief), new Set(['s1']), sources);
  assert.equal(b.within_budget, null); assert.equal(b.party_total_max_minor, null);
  assert.ok(b.known_party_subtotal_max_minor > 0);
});
test('unknown source references and model-invented stay links rejected', () => {
  const o = options(); o.options[0].stays[0].lookup_url = 'https://invented.example/hotel';
  assert.throws(() => validateOptions(o, normalizeBrief(brief), sources, candidates));
  const bad = costLines(); bad[0].source_ids = ['invented'];
  assert.throws(() => calculateBudget(bad, normalizeBrief(brief), new Set(['s1'])));
  const inventedStay = options(); inventedStay.options[0].stays[0].name='Invented Paradise Lodge';
  assert.throws(() => validateOptions(inventedStay,normalizeBrief(brief),sources,candidates));
});
test('valid options remain explicitly indicative and unknown evidence changes status', () => {
  const raw = options(); raw.options[0].cost_lines[0].status = 'unknown';
  const out = validateOptions(raw, normalizeBrief(brief), sources, candidates);
  assert.equal(out.options[0].status, 'needs_research');
  assert.equal(out.options[0].stays[0].availability_status, 'check_with_provider');
});
test('itinerary nights, exact dates, stay selection and return are enforced', () => {
  assert.equal(validatePlan(plan(), normalizeBrief(brief), sources).reservation_status, 'not_booked');
  for (const mutate of [p => p.days.pop(), p => p.bases[0].nights=1, p => p.days[1].date='2026-11-12', p => p.stays[0].selected=false, p => p.days[2].overnight_base='Base A', p => p.return=null]) {
    const raw = plan(); mutate(raw); assert.throws(() => validatePlan(raw, normalizeBrief(brief), sources));
  }
});
test('links require safe HTTPS public destinations', () => {
  for (const url of ['javascript:alert(1)','http://example.com','https://127.0.0.1/test','https://user:pass@example.com','https://[::1]/']) assert.equal(safeUrl(url), null);
});
test('invented excerpts, unquoted prices and from-only rates cannot establish budget feasibility',()=>{
  for (const mutate of [e=>e.quote='Made up tariff INR 100–120.', e=>e.unit_min_major=10, e=>e.range_type='from_only', e=>e.currency='USD']) {
    const lines=costLines();mutate(lines[0].price_evidence);
    const budget=calculateBudget(lines,normalizeBrief(brief),new Set(['s1']),sources);
    assert.equal(budget.within_budget,null);assert.equal(budget.lines[0].status,'unknown');assert.equal(budget.lines[0].party_min_minor,null);
  }
});
test('code derives minor-unit totals and ignores model-supplied totals',()=>{
  const lines=costLines();lines[0].party_min_minor=1;lines[0].party_max_minor=1;lines[0].price_evidence.quantity=2;
  const budget=calculateBudget(lines,normalizeBrief(brief),new Set(['s1']),sources);
  assert.equal(budget.lines[0].party_min_minor,20000);assert.equal(budget.lines[0].party_max_minor,24000);
});
test('unsourced rest/planning days are explicitly unverified rather than given invented citations',()=>{
  const raw=plan();raw.days[1].source_ids=[];
  const checked=validatePlan(raw,normalizeBrief(brief),sources);
  assert.equal(checked.days[1].evidence_status,'unverified_planning_suggestion');
  assert.deepEqual(checked.days[1].source_ids,[]);
});
