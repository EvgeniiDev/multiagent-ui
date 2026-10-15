import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {ref,watch,nextTick} from 'vue';

const textJs=ts.transpileModule(readFileSync(new URL('../src/lib/dictationText.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const {insertDictation}=await import('data:text/javascript;base64,'+Buffer.from(textJs).toString('base64'));
const errJs=ts.transpileModule(readFileSync(new URL('../src/lib/promptError.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const {promptRecorded,markPromptRecorded}=await import('data:text/javascript;base64,'+Buffer.from(errJs).toString('base64'));
const source=readFileSync(new URL('../src/components/ChatView.vue',import.meta.url),'utf8');
function extract(name,content=source){const source=content;const start=source.indexOf('function '+name+'(');assert.ok(start>=0);let depth=0,body=source.indexOf('{',start),end=body;for(;end<source.length;end++){if(source[end]==='{')depth++;if(source[end]==='}'&&--depth===0)break;}return source.slice(start,end+1);}
const js=ts.transpileModule('async '+extract('handleSend')+'\n'+extract('onVoiceFinal'),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
function harness(){const calls=[];let finish;const env={insertDictation,promptRecorded,inputText:{value:'Typed'},attachments:{value:[]},attachError:{value:null},followBottom:{value:false},preparingSend:{value:false},voiceActive:{value:false},voiceError:{value:null},voiceAt:{value:5},composerEl:{value:null},nextTick:async fn=>fn?.(),isLoading:{value:false},rt:{sendPrompt:async(text,files)=>calls.push({text,files}),steer:async(text,files)=>calls.push({text,files})}};
const make=Function(...Object.keys(env),'voiceInputRef',js+';return {handleSend,onVoiceFinal};');
const voiceInputRef={value:{stop:()=>{},finish:()=>new Promise(resolve=>{finish=resolve;})}};
const handlers=make(...Object.values(env),voiceInputRef);return {env,calls,...handlers,finalize(text){handlers.onVoiceFinal(text);env.voiceActive.value=false;finish?.();}};}
test('send during dictation waits for the final transcript and leaves the field empty',async()=>{const h=harness();h.env.voiceActive.value=true;const send=h.handleSend();await Promise.resolve();assert.equal(h.calls.length,0,'must not send before the voice final');h.finalize('spoken words');await send;assert.equal(h.calls[0].text,'Typed spoken words');assert.equal(h.env.inputText.value,'');assert.equal(h.env.preparingSend.value,false);});
test('voice follow-up during model work waits for transcription and uses steer',async()=>{const h=harness();h.env.isLoading.value=true;h.env.voiceActive.value=true;h.env.rt.sendPrompt=async()=>assert.fail('busy follow-up must use steer');const calls=[];h.env.rt.steer=async(text,files)=>calls.push({text,files});const send=h.handleSend();await Promise.resolve();assert.equal(calls.length,0,'voice final must arrive before steering');h.finalize('voice follow-up');await send;assert.equal(calls.length,1);assert.equal(calls[0].text,'Typed voice follow-up');assert.equal(h.env.inputText.value,'');});
test('two send taps during dictation produce one prompt',async()=>{const h=harness();h.env.voiceActive.value=true;const a=h.handleSend(),b=h.handleSend();h.finalize('spoken words');await Promise.all([a,b]);assert.equal(h.calls.length,1);assert.equal(h.env.inputText.value,'');});
test('normal sends clear immediately; an old error does not replace a new draft',async()=>{const h=harness();let reject;h.env.rt.sendPrompt=()=>new Promise((_,r)=>{reject=r;});const send=h.handleSend();await Promise.resolve();assert.equal(h.env.inputText.value,'');h.env.inputText.value='New draft';reject(new Error('Turn failed'));await send;assert.equal(h.env.inputText.value,'New draft');assert.match(h.env.rt.error,/Turn failed/);});
test('a failed turn keeps the sent text in the feed, not in the field',async()=>{const h=harness();let reject;h.env.rt.sendPrompt=()=>new Promise((_,r)=>{reject=r;});const send=h.handleSend();await Promise.resolve();assert.equal(h.env.inputText.value,'');reject(markPromptRecorded(new Error('Turn failed')));await send;assert.equal(h.env.inputText.value,'','recorded prompt must not refill the composer');assert.match(h.env.rt.error,/Turn failed/);});
test('a send that never reached the transcript still restores the draft',async()=>{const h=harness();let reject;h.env.rt.sendPrompt=()=>new Promise((_,r)=>{reject=r;});const send=h.handleSend();await Promise.resolve();reject(new Error('Not connected'));await send;assert.equal(h.env.inputText.value,'Typed');});

test('VoiceInput finish resolves after the asynchronous final text has been emitted',async()=>{
  const voiceSource=readFileSync(new URL('../src/components/VoiceInput.vue',import.meta.url),'utf8');
  const finishJs=ts.transpileModule('async '+extract('finish',voiceSource),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const phase=ref('listening');let final='';
  const stopListening=()=>{phase.value='stopping';queueMicrotask(()=>{phase.value='idle';final='Final spoken words';});};
  const finish=Function('phase','watch','nextTick','stopListening',finishJs+';return finish;')(phase,watch,nextTick,stopListening);
  await finish();assert.equal(final,'Final spoken words');
});

test('a failed final chunk keeps recognized text for review instead of sending an incomplete dictation',async()=>{const h=harness();h.env.voiceActive.value=true;const sending=h.handleSend();h.env.voiceError.value='Transcription API returned 503';h.finalize('known partial');await sending;assert.equal(h.calls.length,0);assert.equal(h.env.inputText.value,'Typed known partial');assert.equal(h.env.preparingSend.value,false);});
