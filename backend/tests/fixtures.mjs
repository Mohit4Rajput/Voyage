export const brief = {
  departure_location: 'Bengaluru', start_date: '2026-11-08', end_date: '2026-11-10', number_of_days: 3,
  currency: 'INR', budget_per_person_minor: 2000000, adults: 2, child_ages: [], rooms: 1,
  moods: ['nature','rest','culture'], intent: 'Rest without exhausting detours', constraints: '',
};
export const sources = [{ id: 's1', title: 'Fixture property and transport reference', url: 'https://example.org/stay', content: 'TEST FIXTURE ONLY: Fixture stay, not a real property. Fixture whole-party component tariff: INR 100–120.', checked_at: '2026-10-15T10:00:00Z' }];
export const costLines = () => ['outbound','return','last_mile','stay','local_commute','meals','activities','taxes'].map(category => ({ category, label: category, status: 'estimate', source_ids: ['s1'], price_evidence: { source_id: 's1', quote: 'Fixture whole-party component tariff: INR 100–120.', currency: 'INR', unit_min_major: 100, unit_max_major: 120, quantity: 1, range_type: 'range' }, assumption: 'TEST FIXTURE: whole-party cost estimate, not real travel information.' }));
export const commute = () => ({ description: 'Fixture return-capable transport route', duration_note: 'Duration is a fixture', source_ids: ['s1'] });
export const stay = () => ({ name: 'Fixture stay', area: 'Base A', why: 'Quiet fixture setting', price_note: 'Fixture estimate only', lookup_url: sources[0].url, source_ids: ['s1'] });
export const candidates = [{ id: 'candidate_1', destination: 'Fixture town', region: 'Fixture region', why: 'Rest' }];
export function options() {
  return { options: [{ candidate_id: 'candidate_1', title: 'Fixture escape', why_it_fits: 'Nature, rest and culture', local_experiences: ['Fixture community walk'], tradeoffs: ['No actual availability known'], safety_notes: ['Verify local conditions'], source_ids: ['s1'], stays: [stay()], outbound: commute(), return: commute(), cost_lines: costLines() }], research_notes: 'Fixture sources only.' };
}
export function plan() {
  return { title: 'Fixture plan', bases: [{ name: 'Base A', nights: 2 }],
    days: ['2026-11-08','2026-11-09','2026-11-10'].map((date, i) => ({ date, overnight_base: i===2 ? null : 'Base A', morning: 'Slow start', afternoon: 'Walk and rest', evening: 'Dinner', transit: 'Allow buffers', source_ids: ['s1'], optional: [] })),
    stays: [{ ...stay(), base: 'Base A', selected: true }], outbound: commute(), return: commute(), cost_lines: costLines(), booking_checklist: ['Confirm availability'], safety_notes: ['Check conditions'], uncertainties: ['No live inventory'], disruption_fallback: 'Stay near the base in poor weather.' };
}
