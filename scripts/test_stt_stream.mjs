import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

const source=readFileSync(new URL('../src/lib/stt.ts',import.meta.url),'utf8').replaceAll('import.meta.env','({})');
const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const {StreamingStt,createVoiceEvents,sttHealth}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
const voiceInputSource=readFileSync(new URL('../src/components/VoiceInput.vue',import.meta.url),'utf8');
const secureSource=readFileSync(new URL('../src/lib/host/secure.ts',import.meta.url),'utf8');
const secureJs=ts.transpileModule(secureSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const {securePortFor}=await import('data:text/javascript;base64,'+Buffer.from(secureJs).toString('base64'));

function parseWav(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  return {
    bytes,
    riff: new TextDecoder().decode(bytes.subarray(0,4)),
    wave: new TextDecoder().decode(bytes.subarray(8,12)),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    bitsPerSample: view.getUint16(34, true),
    payload: bytes.slice(44),
  };
}

test('finalizes the captured PCM as WAV via the transcription API',async()=>{
  const events=[];
  let request;
  globalThis.fetch=async(url,init)=>{
    request={url:String(url),init};
    return new Response('распозналось',{status:200,headers:{'content-type':'text/plain'}});
  };
  const client=new StreamingStt({onFinal:text=>events.push(['final',text]),onError:error=>events.push(['error',error]),onClose:final=>events.push(['close',final])},'http://transcriber.test');
  await client.open();
  client.push(new Int16Array([1,-2,0x1234]));
  await client.stop();
  assert.equal(request.url,'http://transcriber.test/v1/audio/transcriptions');
  assert.equal(request.init.method,'POST');
  const form=request.init.body;
  assert.equal(form.get('model'),'gigaam-v3');
  assert.equal(form.get('language'),'ru');
  assert.equal(form.get('response_format'),'text');
  const file=form.get('file');
  assert.equal(file.name,'recording.wav');
  const wav=parseWav(await file.arrayBuffer());
  assert.equal(wav.riff,'RIFF');
  assert.equal(wav.wave,'WAVE');
  assert.equal(wav.channels,1);
  assert.equal(wav.sampleRate,16000);
  assert.equal(wav.bitsPerSample,16);
  assert.deepEqual([...wav.payload],[1,0,254,255,52,18]);
  assert.deepEqual(events,[['final','распозналось'],['close',true]]);
});

test('surfaces API errors without emitting a successful final',async()=>{
  const events=[];
  globalThis.fetch=async()=>new Response('inference unavailable',{status:503});
  const client=new StreamingStt({onFinal:text=>events.push(['final',text]),onError:error=>events.push(['error',error]),onClose:final=>events.push(['close',final])},'http://transcriber.test');
  await client.open();
  client.push(new Int16Array([7]));
  await client.stop();
  assert.equal(events[0][0],'error');
  assert.match(events[0][1],/503/);
  assert.deepEqual(events.at(-1),['close',false]);
  assert.equal(events.filter(([kind])=>kind==='final').length,0);
});

test('keeps request timeout active while reading the transcription body',async(t)=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const originalFetch=globalThis.fetch;
  t.after(()=>{globalThis.fetch=originalFetch;t.mock.timers.reset();});
  let markBodyStarted;
  let abortBody;
  const bodyStarted=new Promise(resolve=>{markBodyStarted=resolve;});
  const errors=[];
  globalThis.fetch=async(_url,init)=>({
    ok:true,
    status:200,
    text:()=>{
      markBodyStarted();
      return new Promise((_resolve,reject)=>{
        abortBody=()=>reject(new DOMException('Aborted','AbortError'));
        init.signal.addEventListener('abort',abortBody,{once:true});
      });
    },
  });
  const client=new StreamingStt({onFinal:()=>{},onError:error=>errors.push(error)} ,'http://transcriber.test');
  await client.open();
  client.push(new Int16Array([1]));
  const stopping=client.stop();
  await bodyStarted;
  t.mock.timers.tick(300_000);
  await new Promise(setImmediate);
  if(errors.length===0){client.close();abortBody?.();}
  await stopping;
  assert.equal(errors.length,1);
  assert.match(errors[0],/timed out/i);
});

test('reports transcript callback errors separately from API failures',async()=>{
  const errors=[];
  const closes=[];
  globalThis.fetch=async()=>new Response('recognized',{status:200});
  const client=new StreamingStt({
    onFinal:()=>{throw new Error('render failed');},
    onError:error=>errors.push(error),
    onClose:hadFinal=>closes.push(hadFinal),
  },'http://transcriber.test');
  await client.open();
  client.push(new Int16Array([1]));
  await client.stop();
  assert.deepEqual(errors,['Transcript handler failed: render failed']);
  assert.deepEqual(closes,[true]);
});

test('deduplicates final and error events across request failure, close, and timeout',()=>{
  const finals=[];
  const errors=[];
  const events=createVoiceEvents(text=>finals.push(text),message=>errors.push(message));
  events.error('Transcription API returned 503');
  events.final('kept text');
  events.error('Transcription API timed out');
  events.final('');
  assert.deepEqual(finals,['kept text']);
  assert.deepEqual(errors,['Transcription API returned 503']);
});

test('resets final and error guards for the next recording',()=>{
  const finals=[];
  const errors=[];
  const events=createVoiceEvents(text=>finals.push(text),message=>errors.push(message));
  events.final('first');
  events.error('first error');
  events.reset();
  events.final('second');
  events.error('second error');
  assert.deepEqual(finals,['first','second']);
  assert.deepEqual(errors,['first error','second error']);
});

test('does not retain the retired GigaAM TLS port mapping',()=>{
  assert.equal(securePortFor(25905),25915);
});

test('keeps the OpenAPI health timeout active through JSON body consumption',async(t)=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const originalFetch=globalThis.fetch;
  t.after(()=>{globalThis.fetch=originalFetch;t.mock.timers.reset();});
  let markBodyStarted;
  const bodyStarted=new Promise(resolve=>{markBodyStarted=resolve;});
  let unblockBody;
  let abortSeen=false;
  let calls=0;
  globalThis.fetch=async(_url,init={})=>{
    calls++;
    if(init.mode==='no-cors') return new Response(null,{status:200});
    return {
      ok:true,
      json:()=>{
        markBodyStarted();
        return new Promise((resolve,reject)=>{
          unblockBody=()=>resolve({paths:{'/v1/audio/transcriptions':{post:{}}}});
          init.signal.addEventListener('abort',()=>{
            abortSeen=true;
            reject(new DOMException('Aborted','AbortError'));
          },{once:true});
        });
      },
    };
  };
  const probe=sttHealth();
  await bodyStarted;
  t.mock.timers.tick(60_000);
  await new Promise(setImmediate);
  if(!abortSeen) unblockBody?.();
  const result=await probe;
  assert.equal(abortSeen,true);
  assert.deepEqual(result,{ok:true,verified:false});
  assert.equal(calls,2);
});

test('sets the phase idle before synchronous STT close during teardown',()=>{
  const start=voiceInputSource.indexOf('function endSession(): void {');
  const end=voiceInputSource.indexOf('\n}',start);
  assert.ok(start>=0&&end>start,'endSession should exist');
  const body=voiceInputSource.slice(start,end);
  const idle=body.indexOf("setPhase('idle')");
  const close=body.indexOf('teardownStt()');
  assert.ok(idle>=0&&close>=0&&idle<close,'idle state must guard synchronous onClose before STT teardown');
});
