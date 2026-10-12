import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { discoverChannelModels } from '../discovery.ts';
import type { Channel } from '../contracts.ts';

test('Ollama and Gemini catalogs normalize IDs without guessing reasoning or images', async () => {
  const seen: string[] = [];
  let geminiKey: string | string[] | undefined;
  const server = createServer((req, res) => {
    seen.push(req.url ?? '');
    if (req.url?.startsWith('/gemini/')) geminiKey = req.headers['x-goog-api-key'];
    res.writeHead(200, {'Content-Type':'application/json'});
    if (req.url === '/ollama/api/tags') {
      res.end(JSON.stringify({models:[{name:'qwen:latest'},{name:'qwen:latest'},{name:'small'}]}));
    } else if (req.url === '/gemini/v1beta/models') {
      res.end(JSON.stringify({models:[{name:'models/gemini-a'}],nextPageToken:'second-page'}));
    } else if (req.url === '/gemini/v1beta/models?pageToken=second-page') {
      res.end(JSON.stringify({models:[{name:'models/gemini-b'}]}));
    } else {
      res.end(JSON.stringify({data:[{id:'vision-reasoner-name-only'}]}));
    }
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const root=`http://127.0.0.1:${address.port}`;
  const common: Channel={id:'adapter',baseUrl:root,api:'openai-completions',apiKey:'probe',defaults:{contextWindow:8192,maxTokens:1024}};
  try {
    const ollama=await discoverChannelModels({...common,baseUrl:`${root}/ollama/v1`,discovery:{type:'ollama'}},{apiKey:'probe'});
    assert.deepEqual(ollama.models.map(model=>model.id),['qwen:latest','small']);
    const gemini=await discoverChannelModels({...common,baseUrl:`${root}/gemini/v1beta`,discovery:{type:'gemini'}},{apiKey:'probe'});
    assert.deepEqual(gemini.models.map(model=>model.id),['gemini-a','gemini-b']);
    const openai=await discoverChannelModels({...common,baseUrl:`${root}/openai`},{apiKey:'probe'});
    assert.deepEqual(seen,['/ollama/api/tags','/gemini/v1beta/models','/gemini/v1beta/models?pageToken=second-page','/openai/v1/models']);
    assert.equal(geminiKey, 'probe');
    assert.equal(openai.models[0].reasoning,false);
    assert.deepEqual(openai.models[0].input,['text']);
  } finally {
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});

test('keyless discovery sends no bearer and errors never disclose query credentials or body', async()=>{
  let auth: string|undefined;
  const server=createServer((req,res)=>{
    auth=req.headers.authorization;
    if (req.url?.includes('/broken')) {res.writeHead(403,{'Content-Type':'application/json'}).end('{"error":"body-secret"}');}
    else res.writeHead(200,{'Content-Type':'application/json'}).end('{"data":[{"id":"local-model"}]}');
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const channel:Channel={id:'local',baseUrl:`http://127.0.0.1:${address.port}/v1`,api:'openai-completions',apiKey:'',authHeader:false};
  try {
    const result=await discoverChannelModels(channel);
    assert.deepEqual(result.models.map(model=>model.id),['local-model']);
    assert.equal(auth,undefined);
    await assert.rejects(discoverChannelModels({...channel,discovery:{type:'openai',url:`http://127.0.0.1:${address.port}/broken?api_key=query-secret`}}),error=>{
      assert.ok(error instanceof Error);
      assert.match(error.message,/403/);
      assert.ok(!error.message.includes('query-secret'));
      assert.ok(!error.message.includes('body-secret'));
      return true;
    });
  } finally {
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});
