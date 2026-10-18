import test from 'node:test';
import assert from 'node:assert/strict';
import { brief } from './fixtures.mjs';
import { readJsonLimited } from '../../supabase/functions/_shared/domain.mjs';

test('Edge endpoint verifies Auth and forwards only the user token to SQL',async()=>{
  const oldDeno=globalThis.Deno,oldFetch=globalThis.fetch;
  let handler;const calls=[];
  const values={SUPABASE_URL:'https://fixture.supabase.co',SUPABASE_ANON_KEY:'fixture-publishable',ALLOWED_ORIGINS:'http://localhost:5173'};
  globalThis.Deno={env:{get:name=>values[name]},serve:fn=>{handler=fn;}};
  globalThis.fetch=async(url,options)=>{
    calls.push({url,options});
    return new Response(JSON.stringify(url.endsWith('/user')?{id:'11111111-1111-4111-8111-111111111111'}:{id:'saved-trip',current_revision:1}),{headers:{'Content-Type':'application/json'}});
  };
  try{
    await import('../../supabase/functions/trip-api/index.ts');
    const request=(body,headers={})=>new Request('https://fixture.supabase.co/functions/v1/trip-api',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer user-fixture-token',Origin:'http://localhost:5173',...headers},body:JSON.stringify(body)});
    const response=await handler(request({action:'save-brief',brief,expectedRevision:0}));
    assert.equal(response.status,200);assert.equal(calls.length,2);
    assert.equal(calls[1].options.headers.Authorization,'Bearer user-fixture-token');
    assert.equal(calls[1].options.headers.apikey,'fixture-publishable');
    assert.equal(JSON.parse(calls[1].options.body).p_brief.nights,2);
    assert.equal((await handler(request({}, {Origin:'https://unapproved.example'}))).status,403);
    assert.equal((await handler(request({}, {Authorization:''}))).status,401);
    assert.equal((await handler(request({action:'unknown'}))).status,400);
    globalThis.fetch=async()=>new Response('{}',{status:401});
    assert.equal((await handler(request({action:'save-brief',brief,expectedRevision:0}))).status,401);
  }finally{globalThis.Deno=oldDeno;globalThis.fetch=oldFetch;}
});
test('streamed body limit rejects payloads even without content-length',async()=>{
  const request=new Request('https://fixture.example',{method:'POST',body:JSON.stringify({large:'a'.repeat(21000)})});
  await assert.rejects(readJsonLimited(request),e=>e.code==='PAYLOAD_TOO_LARGE');
});
