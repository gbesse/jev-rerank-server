import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createLimiter, scoreDocuments, createScoreCache, createSyntheticRerankProvider, createRerankServer } from '../src/index.mjs';
import { startServer, postJson } from './fake-jev.mjs';
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('queued cancellation removes every abandoned job without invoking it', { timeout: 3000 }, async () => {
  const limiter=createLimiter({concurrency:1}); const release=gate(),started=gate();
  const first=limiter.run(async()=>{started.resolve();await release.promise;return 'first';});await started.promise;
  const controller=new AbortController();let abandonedCalls=0;
  const rejected=Array.from({length:100},()=>assert.rejects(limiter.run(()=>{abandonedCalls++;},{signal:controller.signal}),{name:'AbortError'}));
  assert.equal(limiter.pending,100);controller.abort();assert.equal(limiter.pending,0);await Promise.all(rejected);
  const next=limiter.run(()=>'successor');release.resolve();assert.equal(await first,'first');assert.equal(await next,'successor');assert.equal(abandonedCalls,0);assert.equal(limiter.active,0);
});
test('cancelled rate-waiting work releases admission without waiting for its injected sleep', { timeout: 3000 }, async () => {
  let clock=0,calls=0;const sleeping=gate();const limiter=createLimiter({concurrency:1,requestsPerMinute:1,now:()=>clock,sleep:()=>{sleeping.resolve();return new Promise(()=>{});}});
  await limiter.run(()=>calls++);const controller=new AbortController();const rejected=assert.rejects(limiter.run(()=>calls++,{signal:controller.signal}),{name:'AbortError'});await sleeping.promise;controller.abort();await rejected;
  assert.equal(limiter.active,0);clock=60001;assert.equal(await limiter.run(()=>++calls),2);
});
for(const pack of [1,2])test(`abort rejects the whole rank and starts no later batch or cache write (pack ${pack})`,{timeout:3000},async()=>{
  const release=gate(),started=gate(),controller=new AbortController(),calls=[];const fake=createSyntheticRerankProvider();
  const provider=async request=>{calls.push(Object.values(request.state.passages??{p:request.state.passage}));if(calls.length===1){started.resolve();await release.promise;}return fake(request);};
  const limiter=createLimiter({concurrency:1}),cache=createScoreCache();
  const rejected=assert.rejects(scoreDocuments({provider,query:'q',texts:['abandoned-0','abandoned-1','abandoned-2','abandoned-3'],pack,limiter,cache,signal:controller.signal}),{name:'AbortError'});
  await started.promise;controller.abort();await rejected;assert.equal(limiter.pending,0);assert.equal(limiter.active,1); // An uncooperative running provider retains its slot.
  const successor=scoreDocuments({provider,query:'q',texts:['successor'],pack,limiter,cache});release.resolve();const result=await successor;
  assert.equal(result.scores.length,1);assert.equal(calls.length,2);assert.equal(cache.size,pack===1?1:0);
});
test('a pre-aborted cached request still rejects rather than returning success',async()=>{
 const controller=new AbortController();controller.abort();const provider=createSyntheticRerankProvider(),cache=createScoreCache();cache.set('q','known',0.5,provider);
 await assert.rejects(scoreDocuments({provider,query:'q',texts:['known'],cache,signal:controller.signal}),{name:'AbortError'});
});
test('uncancelled batches preserve every original index with the signal-aware limiter',async()=>{
 const limiter=createLimiter({concurrency:2});const result=await scoreDocuments({provider:createSyntheticRerankProvider(),query:'Paris',texts:['Paris','none','Paris','Paris France'],pack:2,limiter});
 assert.equal(result.scores.length,4);assert.equal(result.scores[0],result.scores[2]);assert.equal(result.usage.requests,2);
});
test('real HTTP disconnect removes queued scores and propagates AbortSignal to the running provider',{timeout:5000},async()=>{
 const started=gate(),release=gate(),aborted=gate(),calls=[],fake=createSyntheticRerankProvider();const limiter=createLimiter({concurrency:1});
 const provider=async r=>{calls.push(r.state.passage);if(calls.length===1){r.signal.addEventListener('abort',()=>aborted.resolve(),{once:true});started.resolve();await release.promise;}return fake(r);};
 const server=createRerankServer({provider,limiter,log:()=>{}}),app=await startServer(server);let client;
 try{
  client=httpRequest(app.url+'/v2/rerank',{method:'POST',headers:{'content-type':'application/json'}});client.on('error',()=>{});client.end(JSON.stringify({query:'q',documents:['abandoned-0','abandoned-1','abandoned-2']}));
  await started.promise;client.destroy();await aborted.promise;assert.equal(limiter.pending,0);
  const useful=postJson(app.url+'/v2/rerank',{query:'q',documents:['successor']});release.resolve();const result=await useful;
  assert.equal(result.status,200);assert.deepEqual(calls,['abandoned-0','successor']);
 }finally{release.resolve();client?.destroy();server.closeAllConnections();await app.close();}
});

test('provider failure cancels queued siblings before the limiter admits another batch',async()=>{
 let calls=0;const limiter=createLimiter({concurrency:1});
 const provider=async()=>{calls++;throw new Error('synthetic provider failure');};
 await assert.rejects(scoreDocuments({provider,query:'q',texts:['one','two','three'],limiter}),/synthetic provider failure/);
 assert.equal(calls,1);assert.equal(limiter.pending,0);assert.equal(limiter.active,0);
});
