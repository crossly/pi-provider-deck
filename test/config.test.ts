import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createHubService } from '../service.ts';
import type { Channel, HubService } from '../contracts.ts';

test('editing a channel preserves configured metadata and atomic config rejects invalid replacement', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-hub-config-'));
  const server = createServer((_req, res) => {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ data: [{id:'reasoner'}, {id:'plain'}] }));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address(); assert.ok(address && typeof address !== 'string');
  const configPath=join(dir,'omp-channels.json');
  const channel: Channel = {
    id:'metadata',baseUrl:`http://127.0.0.1:${address.port}/v1`,api:'openai-completions',apiKey:'not-secret',
    defaults:{contextWindow:16384,maxTokens:2048,reasoning:false,input:['text']},
    modelOverrides:{reasoner:{contextWindow:65536,maxTokens:8192,reasoning:true,input:['text','image'],cost:{input:2,output:4}}},
  };
  await writeFile(configPath,JSON.stringify({channels:[channel]}));
  const holder:{service?:HubService;ctx?:ExtensionContext}={};
  const settingsManager=SettingsManager.inMemory({});
  const resourceLoader=new DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,
    extensionFactories:[pi=>{
      holder.service=createHubService(pi,configPath);
      pi.on('session_start',async(_event,ctx)=>{holder.ctx=ctx;await holder.service?.sync(ctx);});
    }],
  });
  let session: AgentSession | undefined;
  try {
    await resourceLoader.reload();
    const modelRuntime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:join(dir,'models.json'),modelsStorePath:join(dir,'store.json'),refreshOnCreate:false,allowModelNetwork:false});
    const created=await createAgentSession({cwd:dir,agentDir:dir,resourceLoader,modelRuntime,settingsManager,sessionManager:SessionManager.inMemory(dir)});
    session=created.session;
    await session.bindExtensions({});
    assert.ok(holder.ctx && holder.service);
    const {ctx,service}=holder;
    await service.refresh(ctx,['metadata']);
    const row=service.snapshot(ctx).find(row=>row.id==='metadata');assert.ok(row);
    const reasoner=row.models.find(model=>model.id==='reasoner');assert.ok(reasoner);
    assert.equal(reasoner.contextWindow,65536);
    assert.equal(reasoner.maxTokens,8192,JSON.stringify({configured: service.channels()[0].modelOverrides, actual: reasoner}));
    assert.deepEqual(reasoner.input,['text','image']);
    assert.equal(reasoner.reasoning,true);
    assert.equal(reasoner.cost.output,4);
    await service.upsert({...channel,name:'Renamed gateway'},ctx);
    await service.refresh(ctx,['metadata']);
    assert.equal(service.snapshot(ctx).find(row=>row.id==='metadata')?.models.find(model=>model.id==='reasoner')?.contextWindow,65536);
    const before=await readFile(configPath,'utf8');
    await assert.rejects(service.upsert({...channel,baseUrl:'not a URL'},ctx));
    assert.equal(await readFile(configPath,'utf8'),before);
    assert.equal(service.channels()[0].name,'Renamed gateway');
  } finally {
    holder.service?.dispose();session?.dispose();
    await session?.modelRuntime.refresh({ allowNetwork: false });
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
    await rm(dir,{recursive:true,force:true});
  }
});
