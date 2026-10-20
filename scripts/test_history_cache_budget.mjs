import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import ts from 'typescript';
const source=readFileSync(new URL('../src/lib/historyCache.ts',import.meta.url),'utf8');const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;const cache=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));const values=new Map();globalThis.localStorage={get length(){return values.size},key:i=>[...values.keys()][i],getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
test('large tool output cannot evict the newest history tail on next open',()=>{values.clear();const messages=Array.from({length:120},(_,i)=>({id:String(i),role:i%2?'assistant':'user',content:`Turn ${i}`,timestamp:i,...(i%2?{toolCalls:[{toolCallId:`tc${i}`,title:'Run',kind:'execute',status:'completed',rawOutput:'x'.repeat(100000)}]}:{})}));cache.writeHistoryCache('A','long',messages);const raw=values.get(cache.historyCacheKey('A','long'));assert.ok(raw.length<=512*1024,'cache must fit its per-session budget');cache.evictHistoryCaches();const entry=cache.readHistoryCache('A','long');assert.ok(entry,'newest session cache survives eviction');assert.equal(entry.messages.at(-1).content,'Turn 119');assert.equal(entry.userTurnBase+entry.messages.filter(m=>m.role==='user').length,60);assert.equal(messages[119].toolCalls[0].rawOutput.length,100000,'live transcript stays intact');});
test('attachment bytes are excluded but identity and latest text survive',()=>{values.clear();cache.writeHistoryCache('A','files',[{id:'x',role:'user',content:'Newest',timestamp:1,attachments:[{name:'a.png',kind:'image',mimeType:'image/png',size:10,previewUrl:'data:huge',body:'huge',cachePath:'local:a'}]}]);const e=cache.readHistoryCache('A','files');assert.equal(e.messages[0].content,'Newest');assert.equal(e.messages[0].attachments[0].cachePath,'local:a');assert.equal(e.messages[0].attachments[0].previewUrl,undefined);});

test('budget trimming serializes the transcript once instead of once per dropped message', () => {
  values.clear();
  const messages = Array.from({length:100}, (_,i) => ({id:String(i),role:i%2?'assistant':'user',content:'x'.repeat(16000),timestamp:i}));
  const stringify = JSON.stringify;
  let fullTranscripts = 0;
  JSON.stringify = function(value, ...rest) {
    if (value?.version === 1 && Array.isArray(value.messages)) fullTranscripts++;
    return stringify(value, ...rest);
  };
  let entry;
  try { entry = cache.writeHistoryCache('A','bounded-work',messages); }
  finally { JSON.stringify = stringify; }
  assert.ok(entry && stringify(entry).length <= 512*1024);
  assert.equal(entry.messages.at(-1).id,'99');
  assert.equal(entry.userTurnBase+entry.messages.filter(m=>m.role==='user').length,50);
  assert.ok(fullTranscripts <= 2, `serialized entire transcript ${fullTranscripts} times`);
});

test('repeated suffix-only cache writes retain the omitted user-turn offset', () => {
  values.clear();
  const messages = Array.from({length:124}, (_,i) => ({id:String(i),role:i%2?'assistant':'user',content:`Turn ${i}`,timestamp:i}));
  let entry = cache.writeHistoryCache('A', 'resume-offset', messages, {seq:124,hh:'chain'});
  for (let i=0; i<3; i++) {
    entry = cache.writeHistoryCache('A', 'resume-offset', entry.messages, undefined, entry.userTurnBase);
    assert.equal(entry.userTurnBase, 12);
    assert.equal(entry.replaySeq, 124);
    assert.equal(entry.messages.at(-1).content, 'Turn 123');
  }
});
