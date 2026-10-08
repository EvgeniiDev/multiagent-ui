import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

const source=readFileSync(new URL('../src/lib/stt.ts',import.meta.url),'utf8').replaceAll('import.meta.env','({})');
const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const {StreamingStt}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
class Socket extends EventTarget {
 static OPEN=1;static last;
 readyState=0;sent=[];
 constructor(){super();Socket.last=this;queueMicrotask(()=>{this.readyState=1;this.dispatchEvent(new Event('open'));});}
 send(data){this.sent.push(typeof data==='string'?data:ArrayBuffer.isView(data)?new Uint8Array(data.buffer,data.byteOffset,data.byteLength).slice():new Uint8Array(data).slice());}
 close(){this.readyState=3;queueMicrotask(()=>this.dispatchEvent(new Event('close')));}
 message(data){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(data)}));}
}
globalThis.WebSocket=Socket;
async function stream(){const events=[];const client=new StreamingStt({onPartial:p=>events.push(['partial',p]),onFinal:t=>events.push(['final',t]),onClose:final=>events.push(['close',final])},'ws://test');await client.open();return {client,socket:Socket.last,events};}
test('final is terminal: duplicate final and later partials cannot replace it',async()=>{const {client,socket,events}=await stream();socket.message({type:'partial',committed:'Один',volatile:'два'});socket.message({type:'final',text:'Один два'});socket.message({type:'final',text:'Один два'});socket.message({type:'partial',committed:'Старый',volatile:'хвост'});client.close();await Promise.resolve();assert.deepEqual(events,[['partial',{committed:'Один',volatile:'два'}],['final','Один два'],['close',true]]);});
test('queued messages after teardown never reach the composer',async()=>{const {client,socket,events}=await stream();client.close();socket.message({type:'partial',committed:'Старая',volatile:'запись'});socket.message({type:'final',text:'Старая запись'});await Promise.resolve();assert.deepEqual(events,[['close',false]]);});
test('PCM subarray sends only its own samples, not the surrounding buffer',async()=>{const {client,socket}=await stream();client.push(new Int16Array([111,222,333,444]).subarray(1,3));assert.deepEqual([...new Int16Array(socket.sent[0].buffer)],[222,333]);client.close();});
test('partials are complete snapshots, not fragments to append',async()=>{const {client,socket,events}=await stream();socket.message({type:'partial',committed:'',volatile:'первый вариант'});socket.message({type:'partial',committed:'первый',volatile:'исправленный хвост'});assert.deepEqual(events.filter(e=>e[0]==='partial').map(e=>e[1]),[{committed:'',volatile:'первый вариант'},{committed:'первый',volatile:'исправленный хвост'}]);client.close();});
