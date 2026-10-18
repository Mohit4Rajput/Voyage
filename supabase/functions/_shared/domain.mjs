export class AppError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
export function ensure(condition, message, code = 'VALIDATION_ERROR', status = 400) {
  if (!condition) throw new AppError(code, message, status);
}
export function text(value, name, max = 500) {
  ensure(typeof value === 'string' && value.trim().length > 0 && value.length <= max, `${name} is required (max ${max} characters).`);
  return value.trim();
}
export function integer(value, name, min, max) {
  ensure(Number.isSafeInteger(value) && value >= min && value <= max, `${name} must be an integer between ${min} and ${max}.`);
  return value;
}
export function uuid(value, name = 'id') {
  ensure(typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value), `${name} must be a UUID.`);
  return value;
}
export function date(value) {
  ensure(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), 'Dates must use YYYY-MM-DD.');
  const ms = Date.parse(`${value}T00:00:00Z`);
  ensure(Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value, 'Invalid calendar date.');
  return ms;
}
export function normalizeBrief(input) {
  ensure(input && typeof input === 'object', 'A travel brief is required.');
  const start = date(input.start_date), end = date(input.end_date);
  const days = integer((end - start) / 86400000 + 1, 'Travel days calculated from dates', 2, 15);
  const currency = text(input.currency, 'currency', 3).toUpperCase();
  // Supported precision is explicit; adding currencies requires a minor-unit policy.
  ensure(['INR', 'USD', 'EUR', 'GBP'].includes(currency), 'Supported currencies: INR, USD, EUR, GBP.');
  const budget = integer(input.budget_per_person_minor, 'budget_per_person_minor', 100, 1000000000);
  const adults = integer(input.adults, 'adults', 1, 12);
  const childAges = input.child_ages ?? [];
  ensure(Array.isArray(childAges) && childAges.length <= 8, 'child_ages must be an array with at most 8 entries.');
  childAges.forEach(age => integer(age, 'child age', 0, 17));
  const rooms = integer(input.rooms, 'rooms', 1, adults);
  ensure(Array.isArray(input.moods) && input.moods.length === 3, 'Supply exactly three mood keywords in priority order.');
  const moods = input.moods.map(m => text(m, 'mood', 40));
  ensure(new Set(moods.map(m => m.toLowerCase())).size === 3, 'Mood keywords must be distinct.');
  ensure(input.budget_scope === undefined || input.budget_scope === 'all_in', 'This first release supports all_in budgets only.');
  let travelScope=input.travel_scope??'either';
  ensure(['domestic','international','either'].includes(travelScope),'Choose domestic, international or either for travel scope.');
  const preferences=`${input.intent??''} ${input.constraints??''}`;
  const international=/\b(international|abroad|overseas|outside\s+(?:india|the country))\b/i.test(preferences);
  const domestic=/\bdomestic[ -]only\b/i.test(preferences);
  if(travelScope==='either'){
    ensure(!(international&&domestic),'Travel preferences conflict: remove domestic-only or international from the brief.');
    if(international)travelScope='international';else if(domestic)travelScope='domestic';
  }
  ensure(!(travelScope==='international'&&domestic),'International travel conflicts with a domestic-only constraint. Update the constraint.');
  ensure(!(travelScope==='domestic'&&international),'Domestic travel conflicts with an international request. Update the travel scope.');
  return {
    departure_location: text(input.departure_location, 'departure_location', 160),travel_scope:travelScope,
    start_date: input.start_date, end_date: input.end_date, number_of_days: days, nights: days - 1,
    currency, budget_per_person_minor: budget, budget_scope: 'all_in',
    adults, child_ages: childAges, rooms, moods,
    intent: text(input.intent, 'intent', 1000),
    constraints: typeof input.constraints === 'string' ? input.constraints.trim().slice(0, 1500) : '',
  };
}
export function safeUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && u.hostname.includes('.') && !/^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[)/i.test(u.hostname) ? u.href : null;
  } catch { return null; }
}
export function sourceIds(ids, allowed, required = true) {
  ensure(Array.isArray(ids) && ids.length <= 20 && (!required || ids.length > 0), 'Missing or excessive evidence references.');
  ids.forEach(id => ensure(typeof id === 'string' && allowed.has(id), 'Output references evidence that was not retrieved.'));
  return [...new Set(ids)];
}
const categories = ['outbound', 'return', 'last_mile', 'stay', 'local_commute', 'meals', 'activities', 'taxes'];
function groundedPrice(line, brief, sources) {
  const e = line.price_evidence;
  if (!e || e.currency !== brief.currency || typeof e.quote !== 'string' || e.quote.length < 5 || e.quote.length > 500) return null;
  const source = sources.find(s => s.id === e.source_id && line.source_ids.includes(s.id));
  const compact = s => s.replace(/\s+/g, ' ').trim();
  if (!source || !compact(source.content).includes(compact(e.quote))) return null;
  if (line.status === 'included') {
    return /\b(included|complimentary|free of charge|no additional charge)\b/i.test(e.quote) ? { min: 0, max: 0, evidence: e } : null;
  }
  if (!['fixed','range'].includes(e.range_type)) return null; // “from” prices do not establish an upper bound.
  if (/\b(starting|starts at|from|onwards|as low as)\b/i.test(e.quote)) return null;
  const min = e.unit_min_major, max = e.unit_max_major, quantity = e.quantity;
  if (![min,max,quantity].every(Number.isFinite) || min < 0 || max < min || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 10000) return null;
  if (e.range_type === 'fixed' && min !== max) return null;
  const currencyMarkers = { INR: /₹|\bINR\b|\bRs\.?/i, USD: /US\$|\bUSD\b/i, EUR: /€|\bEUR\b/i, GBP: /£|\bGBP\b/i };
  if (!currencyMarkers[brief.currency].test(e.quote)) return null;
  const numbers = (e.quote.match(/\d[\d,]*(?:\.\d{1,2})?/g) ?? []).map(n => Number(n.replaceAll(',', '')));
  if (!numbers.includes(min) || !numbers.includes(max)) return null;
  const totalMin = Math.round(min * 100) * quantity, totalMax = Math.round(max * 100) * quantity;
  if (![totalMin,totalMax].every(Number.isSafeInteger) || totalMax > 100000000000) return null;
  return { min: totalMin, max: totalMax, evidence: { source_id: e.source_id, quote: e.quote, currency: brief.currency, range_type: e.range_type, unit_min_major: min, unit_max_major: max, quantity } };
}
export function calculateBudget(lines, brief, allowedSources, sources = []) {
  ensure(Array.isArray(lines) && lines.length >= 8 && lines.length <= 40, 'Supply all required cost categories.');
  const partySize = brief.adults + brief.child_ages.length;
  const normalized = lines.map(line => {
    ensure(categories.includes(line.category), 'Unknown cost category.');
    ensure(['estimate', 'included', 'unknown'].includes(line.status), 'Invalid cost evidence status.');
    const references = sourceIds(line.source_ids, allowedSources, line.status === 'estimate');
    const label = text(line.label, 'cost label', 300);
    let min = null, max = null, status = line.status, priceEvidence = null;
    if (line.status !== 'unknown') {
      const grounded = groundedPrice(line, brief, sources);
      if (grounded) { min = grounded.min; max = grounded.max; priceEvidence = grounded.evidence; }
      else status = 'unknown';
    }
    return { category: line.category, label, status, party_min_minor: min, party_max_minor: max, source_ids: references, price_evidence: priceEvidence,
      grounding_issue: status === 'unknown' ? 'No sufficient exact retrieved price/inclusion evidence; do not interpret as zero or an affordable confirmed cost.' : null,
      assumption: text(line.assumption, 'cost assumption', 700) };
  });
  categories.forEach(category => ensure(normalized.some(l => l.category === category), `Missing ${category} cost category.`));
  ensure(normalized.some(l => l.category === 'stay' && l.status !== 'included'), 'Stay cost must be explicit, not hidden in an inclusion.');
  const complete = normalized.every(l => l.status !== 'unknown');
  const subtotalMin = normalized.reduce((sum, l) => sum + (l.party_min_minor ?? 0), 0);
  const subtotalMax = normalized.reduce((sum, l) => sum + (l.party_max_minor ?? 0), 0);
  // Deliberately owned by code, never by a model-supplied total.
  const contingencyMin = Math.ceil(subtotalMin * 0.15), contingencyMax = Math.ceil(subtotalMax * 0.15);
  const totalMin = subtotalMin + contingencyMin, totalMax = subtotalMax + contingencyMax;
  return { lines: normalized, currency: brief.currency, allocation: 'equal share across all travelers; underlying quotes must account for actual child/room tariffs', party_size: partySize, complete,
    known_party_subtotal_min_minor: subtotalMin, known_party_subtotal_max_minor: subtotalMax,
    contingency_percent: 15, contingency_min_minor: contingencyMin, contingency_max_minor: contingencyMax,
    party_total_min_minor: complete ? totalMin : null, party_total_max_minor: complete ? totalMax : null,
    per_person_min_minor: complete ? Math.ceil(totalMin / partySize) : null,
    per_person_max_minor: complete ? Math.ceil(totalMax / partySize) : null,
    within_budget: complete ? Math.ceil(totalMax / partySize) <= brief.budget_per_person_minor : null };
}
export function normalizeCandidates(output) {
  ensure(Array.isArray(output.candidates) && output.candidates.length > 0 && output.candidates.length <= 4, 'Expected one to four research candidates.');
  return output.candidates.map((c, i) => ({ id: `candidate_${i + 1}`, destination: text(c.destination, 'destination', 120), region: text(c.region, 'region', 160), why: text(c.why, 'candidate reason', 800) }));
}
export function validateOptions(output, brief, sources, candidates) {
  const allowed = new Set(sources.map(s => s.id));
  ensure(Array.isArray(output.options) && output.options.length <= 3, 'Expected up to three options.');
  const seen = new Set();
  const options = output.options.map((o, index) => {
    const candidate = candidates.find(c => c.id === o.candidate_id);
    ensure(candidate && !seen.has(o.candidate_id), 'Options must refer to distinct researched candidates.'); seen.add(o.candidate_id);
    const budget = calculateBudget(o.cost_lines, brief, allowed, sources);
    const refs = sourceIds(o.source_ids, allowed);
    ensure(Array.isArray(o.stays) && o.stays.length > 0 && o.stays.length <= 3, 'Provide one to three sourced stay examples.');
    const stays = o.stays.map(stay => validateStay(stay, allowed, sources));
    ensure(o.outbound && o.return, 'Both travel directions are required.');
    return {
      id: `option_${index + 1}`, candidate_id: candidate.id, destination: candidate.destination, region: candidate.region,
      title: text(o.title, 'title', 160), why_it_fits: text(o.why_it_fits, 'why_it_fits', 1800),
      local_experiences: strings(o.local_experiences, 'local experiences', 6),
      tradeoffs: strings(o.tradeoffs, 'tradeoffs', 8), safety_notes: strings(o.safety_notes, 'safety notes', 8),
      source_ids: refs, stays,
      outbound: validateCommute(o.outbound, allowed), return: validateCommute(o.return, allowed),
      budget, status: budget.within_budget === true ? 'indicative_fit' : budget.within_budget === false ? 'over_budget' : 'needs_research',
      verification: 'Web research estimates only; dates, availability, entry eligibility and safety require confirmation.',
    };
  });
  return { options, research_notes: text(output.research_notes, 'research_notes', 2500), evidence_status: 'indicative_web_research' };
}
export function provisionalOption(candidate, brief, sources, raw, issue) {
  const allowed=new Set(sources.map(s=>s.id));
  const stays=[];
  for(const stay of Array.isArray(raw?.stays)?raw.stays.slice(0,3):[]){
    try{stays.push(validateStay(stay,allowed,sources));}catch(error){if(!(error instanceof AppError))throw error;}
  }
  const commute=(value,direction)=>{
    try{return validateCommute(value,allowed);}catch(error){if(!(error instanceof AppError))throw error;return{description:`${direction} route needs verification.`,duration_note:'Timings, operating days, fare and availability are unknown.',source_ids:[],evidence_status:'unverified'};}
  };
  return {
    candidate_id:candidate.id,destination:candidate.destination,region:candidate.region,
    title:`${candidate.destination} · provisional idea`,why_it_fits:`Unverified research hypothesis: ${candidate.why}`,
    local_experiences:[],tradeoffs:[`Research incomplete: ${issue}`, 'All-in affordability and booking availability are unconfirmed.',...(!stays.length?['Accommodation still needs research.']:[])],
    safety_notes:['Safety, seasonal access and practical feasibility still need verification.'],source_ids:[],stays,
    outbound:commute(raw?.outbound,'Outbound'),return:commute(raw?.return,'Return'),
    budget:calculateBudget(categories.map(category=>({category,label:category,status:'unknown',source_ids:[],price_evidence:null,assumption:'No reliable complete cost evidence available for this provisional option.'})),brief,allowed,sources),
    status:'needs_research',verification:'Provisional destination retained despite incomplete evidence or output structure. Unsupported properties, prices and citations are not displayed as verified facts.',
  };
}
function strings(items, name, max) {
  ensure(Array.isArray(items) && items.length <= max, `${name} must be an array (max ${max}).`);
  return items.map(i => text(i, name, 1200));
}
function validateCommute(c, allowed) {
  ensure(c && typeof c === 'object', 'Both outbound and return commute evidence are required.');
  return { description: text(c.description, 'commute description', 1800), duration_note: text(c.duration_note, 'duration note', 500), source_ids: sourceIds(c.source_ids, allowed), evidence_status: 'estimate' };
}
function validateStay(s, allowed, sources) {
  ensure(s && typeof s === 'object', 'Stay details must be an object.');
  const refs = sourceIds(s.source_ids, allowed);
  const url = safeUrl(s.lookup_url);
  ensure(url && sources.some(source => refs.includes(source.id) && source.url === url), 'Stay links must be exact retrieved source URLs.');
  const name = text(s.name, 'stay name', 180);
  const normalize = value => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9\p{L}]+/gu, ' ').trim();
  ensure(sources.some(source => refs.includes(source.id) && normalize(`${source.title} ${source.content}`).includes(normalize(name))), 'Stay name must occur in retrieved source evidence.');
  return { name, area: text(s.area, 'stay area', 180), why: text(s.why, 'stay reason', 1000),
    price_note: 'No date- and occupancy-specific quote verified. Check price and availability with the provider.', lookup_url: url, source_ids: refs,
    availability_status: 'check_with_provider', cancellation_note: typeof s.cancellation_note === 'string' ? s.cancellation_note.slice(0, 800) : 'Not verified.' };
}
export function validatePlan(output, brief, sources) {
  const allowed = new Set(sources.map(s => s.id));
  ensure(Array.isArray(output.days) && output.days.length === brief.number_of_days, 'The itinerary must include every calendar day.');
  ensure(Array.isArray(output.bases) && output.bases.length > 0 && output.bases.length <= brief.nights, 'Invalid base allocation.');
  const bases = output.bases.map(b => ({ name: text(b.name, 'base', 160), nights: integer(b.nights, 'base nights', 1, brief.nights) }));
  ensure(bases.reduce((s, b) => s + b.nights, 0) === brief.nights, 'Base nights must sum to brief nights.');
  ensure(new Set(bases.map(b => b.name)).size === bases.length, 'Base names must be distinct.');
  const days = output.days.map((day, i) => {
    const expectedDate = new Date(date(brief.start_date) + i * 86400000).toISOString().slice(0, 10);
    ensure(day.date === expectedDate, 'Plan dates must match the saved travel brief in order.');
    const overnightBase = day.overnight_base === null ? null : text(day.overnight_base, 'overnight base', 160);
    ensure(i === brief.number_of_days - 1 ? overnightBase === null : bases.some(b => b.name === overnightBase), 'Overnight base must match a declared base; departure day has no overnight.');
    const refs = sourceIds(day.source_ids, allowed, false);
    return { date: expectedDate, overnight_base: overnightBase, morning: text(day.morning, 'morning', 1500), afternoon: text(day.afternoon, 'afternoon', 1500), evening: text(day.evening, 'evening', 1500), transit: text(day.transit, 'transit', 1000), source_ids: refs,
      evidence_status: refs.length ? 'referenced_web_research' : 'unverified_planning_suggestion',
      optional: strings(day.optional ?? [], 'optional activities', 4) };
  });
  bases.forEach(b => ensure(days.filter(d => d.overnight_base === b.name).length === b.nights, 'Daily overnights do not match base allocation.'));
  ensure(Array.isArray(output.stays) && output.stays.length >= bases.length && output.stays.length <= bases.length * 3, 'Provide one to three stay alternatives per base.');
  const stays = output.stays.map(s => {
    ensure(bases.some(b => b.name === s.base), 'Stay references an unknown base.');
    return { ...validateStay(s, allowed, sources), base: s.base, selected: s.selected === true };
  });
  bases.forEach(b => ensure(stays.filter(s => s.base === b.name && s.selected).length === 1, 'Select exactly one priced stay per base.'));
  return { title: text(output.title, 'plan title', 180), bases, days, stays,
    outbound: validateCommute(output.outbound, allowed), return: validateCommute(output.return, allowed),
    budget: calculateBudget(output.cost_lines, brief, allowed, sources),
    booking_checklist: strings(output.booking_checklist, 'booking checklist', 15),
    safety_notes: strings(output.safety_notes, 'safety notes', 10),
    uncertainties: strings(output.uncertainties, 'uncertainties', 15),
    disruption_fallback: text(output.disruption_fallback, 'disruption fallback', 1500),
    evidence_status: 'indicative_web_research', reservation_status: 'not_booked' };
}

export async function readJsonLimited(request, maxBytes = 20000) {
  const declared = Number(request.headers.get('content-length'));
  ensure(!Number.isFinite(declared) || declared <= maxBytes, 'Request exceeds 20 KB.', 'PAYLOAD_TOO_LARGE', 413);
  const reader = request.body?.getReader();
  ensure(reader, 'Expected JSON input.', 'INVALID_JSON');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new AppError('PAYLOAD_TOO_LARGE', 'Request exceeds 20 KB.', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const buffer = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(buffer)); }
  catch { throw new AppError('INVALID_JSON', 'Expected JSON input.'); }
}
export function newShareToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
}
export async function hashShareToken(token) {
  ensure(typeof token === 'string' && /^[0-9a-f]{64}$/.test(token), 'Invalid invitation or share token.');
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
