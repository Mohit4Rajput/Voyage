import PDFDocument from 'pdfkit';
import path from 'node:path';
import { root } from './env.mjs';

// All text is rendered as text. No remote assets, HTML or user-controlled paths.
export async function itineraryPdf(row, sources=[]) {
  const p=row.content;
  const doc=new PDFDocument({size:'A4',margins:{top:52,bottom:55,left:48,right:48},bufferPages:true,info:{Title:'Voyage itinerary',Author:'Voyage'}});
  doc.registerFont('Body',path.join(root,'node_modules/@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff'));
  doc.registerFont('Bold',path.join(root,'node_modules/@fontsource/noto-sans/files/noto-sans-latin-700-normal.woff'));
  const chunks=[];
  const done=new Promise((resolve,reject)=>{doc.on('data',c=>chunks.push(c));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);});
  const clean=v=>String(v??'Not available').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').replace(/₹/g,'INR ').slice(0,12000);
  const room=h=>{if(doc.y+h>doc.page.height-65)doc.addPage();};
  const para=(value,opts={})=>{doc.font('Body').fontSize(10).fillColor('#293133').text(clean(value),{lineGap:3,...opts});doc.moveDown(.55);};
  const heading=value=>{room(65);doc.moveDown(.6).font('Bold').fontSize(15).fillColor('#954f36').text(clean(value));doc.moveDown(.45);};
  const bullet=value=>para(`- ${clean(value)}`);
  const money=n=>n===null||n===undefined?'Unknown':`${p.budget.currency} ${(n/100).toLocaleString('en-US',{maximumFractionDigits:2})}`;
  doc.font('Bold').fontSize(12).fillColor('#954f36').text('VOYAGE  /  YOUR TRAVEL PLAN');doc.moveDown();
  doc.font('Bold').fontSize(24).fillColor('#202c2a').text(clean(p.title));doc.moveDown(.6);
  para(`${p.days?.[0]?.date??''} to ${p.days?.at(-1)?.date??''} | ${p.days?.length??0} days | Brief revision ${row.brief_revision??'?'} | ${row.status==='locked'?'Locked version':'Draft version'}`);
  para(`Plan reference: ${row.id??'preview'}`);
  if(row.is_current===false)para('EARLIER VERSION: this plan belongs to a previous brief or destination selection.');
  if(p.execution_mode==='fixture')para('SYNTHETIC TEST PLAN. Places, transport and prices in this test document are not travel recommendations.');
  para('Research estimates only. Verify availability, fares, schedules, entry requirements and local conditions before booking.');
  heading('Budget overview');
  para(p.budget.complete?`Estimated per person: ${money(p.budget.per_person_min_minor)} - ${money(p.budget.per_person_max_minor)}`:'Budget unresolved: some required costs are unknown. This plan is not confirmed affordable.');
  para('Shown estimates include the configured contingency. Unknown amounts are not zero.');
  heading('Your itinerary');
  for(const day of p.days??[]){
    room(110);doc.font('Bold').fontSize(12).fillColor('#202c2a').text(clean(`${day.date} | ${day.overnight_base??'Return home'}`));doc.moveDown(.4);
    for(const key of ['morning','afternoon','evening','transit'])para(`${key[0].toUpperCase()+key.slice(1)}: ${day[key]??'Needs research'}`);
    for(const item of day.optional??[])bullet(`Optional: ${item}`);
    if(day.evidence_status==='unverified_planning_suggestion')para('Unverified planning suggestion.');
  }
  heading('Stay suggestions');
  if(!p.stays?.length)para('Accommodation still needs research.');
  for(const stay of p.stays??[]){room(90);doc.font('Bold').fontSize(11).fillColor('#202c2a').text(clean(`${stay.name}${stay.selected?' (selected)':''}`));doc.moveDown(.3);para(`${stay.base??stay.area??''}: ${stay.why??''}`);para(stay.price_note);para(`Cancellation: ${stay.cancellation_note??'Not verified'}`);}
  heading('Getting there and back');
  for(const key of ['outbound','return']){para(`${key==='outbound'?'Outbound':'Return'}: ${p[key]?.description??'Needs research'}`);para(p[key]?.duration_note??'Timing not verified');}
  heading('Cost breakdown - whole party');
  for(const line of p.budget.lines??[]){room(62);doc.font('Bold').fontSize(10).fillColor('#202c2a').text(clean(`${line.label}: ${line.status==='unknown'?'Unknown':`${money(line.party_min_minor)} - ${money(line.party_max_minor)}`}`));doc.moveDown(.2);para(line.status==='unknown'?(line.grounding_issue??line.assumption??'No sufficient price evidence'):line.assumption);}
  heading('Before booking');for(const item of p.booking_checklist??[])bullet(item);
  heading('Safety and unresolved details');for(const item of [...p.safety_notes??[],...p.uncertainties??[]])bullet(item);
  para(`Fallback: ${p.disruption_fallback??'Confirm alternatives before travel.'}`);
  heading('Sources and further details');
  for(const source of sources){room(60);para(`${source.source_key??source.id}: ${source.title}`);let url;try{const parsed=new URL(source.url);if(parsed.protocol==='https:')url=parsed.href;}catch{}
    if(url)para(url,{link:url,underline:true});if(source.checked_at)para(`Checked: ${source.checked_at}`);
  }
  const pages=doc.bufferedPageRange();
  for(let i=0;i<pages.count;i++){doc.switchToPage(i);const bottom=doc.page.margins.bottom;doc.page.margins.bottom=0;doc.font('Body').fontSize(8).fillColor('#687470').text(`Voyage | Estimates require confirmation                                      ${i+1} / ${pages.count}`,48,doc.page.height-32,{lineBreak:false});doc.page.margins.bottom=bottom;}
  doc.end();return done;
}
