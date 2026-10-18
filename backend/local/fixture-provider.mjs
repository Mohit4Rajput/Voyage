// All responses are synthetic and never represent actual travel inventory.
export function createFixtureProvider(brief){
  const baseRate=Math.max(1,Math.floor(brief.budget_per_person_minor/100/40));
  const upper=baseRate+Math.max(1,Math.floor(baseRate/10));
  const quote=`SYNTHETIC TEST tariff ${brief.currency} ${baseRate}–${upper} per component.`;
  const source={url:'https://example.org/local-test-evidence',title:'Synthetic local test evidence — not travel information',content:`${quote} Test Stay A. Test Stay B. Test Stay C. No real property or quote is represented.`,checked_at:new Date().toISOString()};
  const costLines=()=>['outbound','return','last_mile','stay','local_commute','meals','activities','taxes'].map(category=>({category,label:`Test ${category.replaceAll('_',' ')}`,status:'estimate',source_ids:['s1'],price_evidence:{source_id:'s1',quote,currency:brief.currency,unit_min_major:baseRate,unit_max_major:upper,quantity:brief.adults+brief.child_ages.length,range_type:'range'},assumption:'Synthetic whole-party fixture used to test arithmetic. Not a real quote.'}));
  const commute=direction=>({description:`Synthetic ${direction} route from ${brief.departure_location}; verify live mode for actual routes.`,duration_note:'Test duration only, not researched.',source_ids:['s1']});
  const stay=letter=>({name:`Test Stay ${letter}`,area:`Test Base ${letter}`,why:`Synthetic accommodation for the ${brief.moods[0]} mood.`,price_note:'Synthetic data',lookup_url:source.url,source_ids:['s1']});
  return{model:'local-fixture (synthetic)',
    async search(){await new Promise(r=>setTimeout(r,35));return[source];},
    async generate(system,input){
      await new Promise(r=>setTimeout(r,75));
      if(input.required_shape?.candidates)return{candidates:['A','B','C'].map(letter=>({destination:`Test Region ${letter}`,region:'Synthetic scenario',why:`Tests ${brief.moods.join(', ')} from ${brief.departure_location}`}))};
      if(input.required_shape?.options)return{options:['A','B','C'].map((letter,i)=>({candidate_id:`candidate_${i+1}`,title:`${brief.moods[i]} · test concept ${letter}`,why_it_fits:`Synthetic example built from your intent: ${brief.intent}. Departure: ${brief.departure_location}.`,local_experiences:[`Test ${brief.moods[i]} experience`,`Test ${brief.moods[(i+1)%3]} experience`],tradeoffs:['Synthetic fixture, not a real destination recommendation.'],safety_notes:['Safety has not been researched in fixture mode.'],source_ids:['s1'],stays:[stay(letter)],outbound:commute('outbound'),return:commute('return'),cost_lines:costLines()})),research_notes:'Synthetic mode. Tests features without network calls; switch to live research for actual options.'};
      const letter=input.selected_option?.destination?.slice(-1)||'A';
      return{title:`${brief.moods[0]} test plan from ${brief.departure_location}`,bases:[{name:`Test Base ${letter}`,nights:brief.nights}],
        days:Array.from({length:brief.number_of_days},(_,i)=>({date:new Date(Date.parse(`${brief.start_date}T00:00:00Z`)+i*86400000).toISOString().slice(0,10),overnight_base:i===brief.number_of_days-1?null:`Test Base ${letter}`,morning:i===0?'Test outbound travel':`Test ${brief.moods[0]} experience`,afternoon:`Test ${brief.moods[1]} experience and rest`,evening:i===brief.number_of_days-1?'Test return home':`Test ${brief.moods[2]} experience`,transit:'Synthetic transit with buffer; no real schedule.',source_ids:['s1'],optional:[]})),
        stays:[{...stay(letter),base:`Test Base ${letter}`,selected:true}],outbound:commute('outbound'),return:commute('return'),cost_lines:costLines(),booking_checklist:['Synthetic mode: do not book from this fixture.'],safety_notes:['No actual safety assessment in fixture mode.'],uncertainties:['All places, stays, transport and prices in this fixture are synthetic.'],disruption_fallback:'Test changing activities to rest at the base.'};
    }};
}
