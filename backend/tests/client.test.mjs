import test from 'node:test';
import assert from 'node:assert/strict';
import { createTravelApi } from '../../frontend/api-client.mjs';

test('frontend commands preserve explicit user choice and caller retry key',async()=>{
  const calls=[];
  const api=createTravelApi({functions:{invoke:async(name,{body})=>{calls.push({name,body});return{data:{data:{id:'fixture'},error:null},error:null};}}});
  const requestId=crypto.randomUUID();
  await api.researchOptions('trip',2,requestId);
  await api.selectOption('trip',2,'user-chosen-option');
  await api.buildItinerary('trip',2,requestId);
  assert.deepEqual(calls.map(c=>c.body.action),['research-options','select-option','build-itinerary']);
  assert.equal(calls[0].body.requestId,requestId);
  assert.equal(calls[1].body.optionId,'user-chosen-option');
});
test('frontend propagates API errors instead of displaying placeholder data',async()=>{
  const api=createTravelApi({functions:{invoke:async()=>({data:{error:{code:'CONFLICT',message:'Brief changed'}},error:null})}});
  await assert.rejects(api.saveBrief({}),error=>error.code==='CONFLICT');
});
test('SDK HTTP errors preserve the backend conflict code',async()=>{
  const api=createTravelApi({functions:{invoke:async()=>({data:null,error:{context:new Response(JSON.stringify({error:{code:'CONFLICT',message:'Brief changed'}}),{status:409})}})}});
  await assert.rejects(api.saveBrief({}),error=>error.code==='CONFLICT');
});
