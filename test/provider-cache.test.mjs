import test from 'node:test';
import assert from 'node:assert/strict';
import {createScoreCache,rerank} from '../src/index.mjs';
const body={query:'query',documents:['document']};
function model(score){let calls=0;const provider=async()=>{calls++;return {answers:{relevant:{type:'noul',noul:score}},usage:{input_tokens:10,output_tokens:0}};};provider.model='same-name';return {provider,get calls(){return calls;}};}
test('shared cache cannot carry scores between different provider functions with the same model name',async()=>{
 const cache=createScoreCache(),a=model(.9),b=model(.1);
 assert.equal((await rerank(body,{provider:a.provider,cache})).results[0].relevance_score,.9);
 assert.equal((await rerank(body,{provider:b.provider,cache})).results[0].relevance_score,.1);
 assert.equal((await rerank(body,{provider:a.provider,cache})).usage.cached_documents,1);
 assert.equal((await rerank(body,{provider:b.provider,cache})).usage.cached_documents,1);
 assert.equal(a.calls,1);assert.equal(b.calls,1);assert.equal(cache.size,2);
});
test('changed declared model on one provider invalidates its cache scope',async()=>{
 const cache=createScoreCache(),a=model(.7);
 await rerank(body,{provider:a.provider,cache});a.provider.model='changed-model';
 assert.equal((await rerank(body,{provider:a.provider,cache})).usage.cached_documents,0);
 assert.equal(a.calls,2);
});
test('manual unscoped scores do not silently warm provider-scoped reranking',async()=>{
 const cache=createScoreCache(),a=model(.8);cache.set('query','document',.01);
 assert.equal((await rerank(body,{provider:a.provider,cache})).results[0].relevance_score,.8);
 assert.equal(cache.get('query','document'),.01);assert.equal(cache.get('query','document',a.provider),.8);
});
