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
  client.push(new Int16Array([2000]));
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
  client.push(new Int16Array([2000]));
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
  client.push(new Int16Array([2000]));
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

const pcm=(seconds,value=2000)=>new Int16Array(Math.round(seconds*16000)).fill(value);
const flush=()=>new Promise(setImmediate);

test('recognizes paused phrases before Stop and appends in capture order without replacing earlier text',async()=>{
  const partials=[],finals=[],requests=[];
  let release;
  globalThis.fetch=async(_url,init)=>{requests.push(init.body);if(requests.length===1)await new Promise(r=>release=r);return new Response(requests.length===1?'Первая фраза':'Вторая фраза');};
  const client=new StreamingStt({onPartial:p=>partials.push(p),onFinal:t=>finals.push(t)},'http://transcriber.test');
  await client.open();client.push(pcm(1));client.push(pcm(.8,0));
  assert.equal(requests.length,1,'recognition must start during recording, before Stop');
  client.push(pcm(1,4000));client.push(pcm(.8,0));
  assert.equal(requests.length,1,'only one request may run at a time');
  release();await flush();await flush();
  assert.deepEqual(partials.map(p=>p.committed),['Первая фраза','Первая фраза Вторая фраза']);
  assert.equal(client.isOpen,true);
  await client.stop();assert.deepEqual(finals,['Первая фраза Вторая фраза']);
  assert.equal(requests.length,2,'Stop must not re-decode the whole recording');
  const payloads=await Promise.all(requests.map(async f=>parseWav(await f.get('file').arrayBuffer()).payload));
  for(let i=0;i<payloads.length;i++){const values=new Int16Array(payloads[i].buffer,payloads[i].byteOffset,payloads[i].byteLength/2);assert.equal([...values].filter(v=>v===2000).length,i===0?16000:0);assert.equal([...values].filter(v=>v===4000).length,i===1?16000:0);}
});

test('shows a replaceable live hypothesis and ignores its late result once the phrase is sealed',async()=>{
  const partials=[],bodies=[];let release;
  globalThis.fetch=async(_url,init)=>{bodies.push(init.body);if(bodies.length===1){await new Promise(r=>release=r);return new Response('устаревший черновик');}return new Response('Окончательная фраза');};
  const client=new StreamingStt({onPartial:p=>partials.push(p)},'http://transcriber.test');
  await client.open();client.push(pcm(3.2));assert.equal(bodies.length,1,'continuous speech gets an early hypothesis');
  client.push(pcm(.8,0));const stopped=client.stop();release();await stopped;
  assert(!partials.some(p=>p.volatile.includes('устаревший')),'a stale hypothesis must never overwrite a sealed phrase');
  assert.equal(partials.at(-1).committed,'Окончательная фраза');
});

test('publishes hypotheses while the microphone stays open and finalizes only once',async()=>{
  const partials=[],finals=[];let calls=0;
  globalThis.fetch=async()=>new Response(++calls===1?'промежуточный текст':'готовый текст');
  const client=new StreamingStt({onPartial:p=>partials.push(p),onFinal:t=>finals.push(t)},'http://transcriber.test');
  await client.open();client.push(pcm(3.2));await flush();
  assert.deepEqual(partials.at(-1),{committed:'',volatile:'промежуточный текст'});assert(client.isOpen);assert.deepEqual(finals,[]);
  const a=client.stop(),b=client.stop();await Promise.all([a,b]);assert.deepEqual(finals,['готовый текст']);
});

test('silence sends nothing; reset and close ignore late results from an old recording',async()=>{
  const partials=[],finals=[];let release;
  globalThis.fetch=async()=>{await new Promise(r=>release=r);return new Response('устаревший текст');};
  const client=new StreamingStt({onPartial:p=>partials.push(p),onFinal:t=>finals.push(t)},'http://transcriber.test');
  await client.open();client.push(pcm(30,0));assert.equal(release,undefined);
  client.push(pcm(1));client.push(pcm(.8,0));client.reset();release();await flush();assert.deepEqual(partials,[{committed:'',volatile:''}]);
  await client.stop();assert.deepEqual(finals,['']);
});

test('continuous audio is bounded and finalized samples do not overlap across requests',async()=>{
  const files=[];
  globalThis.fetch=async(_url,init)=>{files.push(init.body.get('file'));return new Response('да');};
  const finals=[];const client=new StreamingStt({onFinal:t=>finals.push(t)},'http://transcriber.test');await client.open();client.push(pcm(42));await client.stop();
  // Preview snapshots are allowed to repeat the current phrase, final phrase WAVs are not.
  const durations=await Promise.all(files.map(async f=>(await f.arrayBuffer()).byteLength/2-22));
  assert(durations.every(n=>n<=20*16000),'every inference WAV stays bounded');
  assert.equal(durations[0],3*16000);assert.equal(durations.slice(1).reduce((a,b)=>a+b,0),42*16000,'every final audio sample is submitted once');
  assert.deepEqual(finals,['да да да'],'intentional repetitions must not be deduplicated');
});


test('transport packet boundaries do not split, duplicate or lose speech samples',async()=>{
  const data=new Int16Array(16000*3);data.fill(2000,0,16000);data.fill(4000,16000*2,16000*3);
  const outputs=[];
  for(const size of [1,713,1600,data.length]){
    const payloads=[];globalThis.fetch=async(_url,init)=>{payloads.push(init.body.get('file').arrayBuffer());return new Response('фраза');};
    const client=new StreamingStt({},'http://transcriber.test');await client.open();for(let i=0;i<data.length;i+=size)client.push(data.subarray(i,i+size));await client.stop();
    outputs.push((await Promise.all(payloads)).map(b=>Buffer.from(b).toString('base64')));
  }
  assert(outputs.every(result=>JSON.stringify(result)===JSON.stringify(outputs[0])));
  assert.equal(outputs[0].length,2);
});

test('an unavailable final chunk closes with the earlier committed words intact',async()=>{
  const events=[];let calls=0;
  globalThis.fetch=async()=>++calls===1?new Response('Первая фраза'):new Response('unavailable',{status:503});
  const client=new StreamingStt({onPartial:p=>events.push(['partial',p]),onFinal:t=>events.push(['final',t]),onError:e=>events.push(['error',e]),onClose:f=>events.push(['close',f])},'http://transcriber.test');
  await client.open();client.push(pcm(1));client.push(pcm(.8,0));await flush();client.push(pcm(1));await client.stop();
  assert.deepEqual(events[0],['partial',{committed:'Первая фраза',volatile:''}]);
  assert.match(events[1][1],/503/);assert.deepEqual(events[2],['close',false]);assert.equal(events.filter(e=>e[0]==='final').length,0);
});

test('closing an in-flight recording never publishes late partials or final text',async()=>{
  const events=[];let release;
  globalThis.fetch=async()=>{await new Promise(r=>release=r);return new Response('late');};
  const client=new StreamingStt({onPartial:p=>events.push(p),onFinal:t=>events.push(t)},'http://transcriber.test');await client.open();client.push(pcm(1));client.push(pcm(.8,0));client.close();release();await flush();assert.deepEqual(events,[]);
});

test('sealing a phrase cancels its obsolete preview instead of blocking final text',async()=>{
  let calls=0,aborted=false;const finals=[];
  globalThis.fetch=async(_url,init)=>{
    calls++;
    if(calls===1)return new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>{aborted=true;reject(new DOMException('Aborted','AbortError'));},{once:true}));
    return new Response('готовая фраза');
  };
  const client=new StreamingStt({onFinal:t=>finals.push(t)},'http://transcriber.test');await client.open();client.push(pcm(3.2));client.push(pcm(.8,0));await client.stop();
  assert.equal(aborted,true);assert.equal(calls,2);assert.deepEqual(finals,['готовая фраза']);
});

test('unprocessed audio backlog is bounded and stops with an explicit error',async()=>{
  const errors=[],closes=[];let release;
  globalThis.fetch=async()=>{await new Promise(r=>release=r);return new Response('late');};
  const client=new StreamingStt({onError:e=>errors.push(e),onClose:f=>closes.push(f)},'http://transcriber.test');await client.open();client.push(pcm(630));
  assert.equal(client.isOpen,false);assert.match(errors[0],/fell too far behind/);assert.deepEqual(closes,[false]);release();await flush();
});
