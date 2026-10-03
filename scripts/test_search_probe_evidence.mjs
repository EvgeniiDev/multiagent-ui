import {test} from 'node:test'; import assert from 'node:assert/strict';
import {searchProbeEvidence} from './search_probe_evidence.mjs';
const completed={status:'completed',exit_code:0};
const trace=(result,id='call1')=>JSON.stringify({message:{role:'assistant',content:[{type:'toolCall',name:'web_search',id:'call1'}]}})+'\n'+JSON.stringify({message:{role:'toolResult',toolName:'web_search',toolCallId:id,content:[{type:'text',text:result}]}});
test('real paired public-source result after successful terminal run proves capability',()=>assert.equal(searchProbeEvidence(trace('1. [Debian Trixie](https://www.debian.org/releases/trixie/)\nDebian 13 release information.'),completed).capable,true));
test('stored responseId and URL in actual extension transport error do not prove search',()=>assert.equal(searchProbeEvidence(trace('Error: Proxy fetch to https://html.duckduckgo.com/html/?q=x returned no HTTP status\nResults stored as responseId abc'),completed).capable,false));
test('unmatched result and failed terminal run cannot prove capability',()=>{assert.equal(searchProbeEvidence(trace('Source: Debian (https://debian.org)','different-call'),completed).capable,false);assert.equal(searchProbeEvidence(trace('Source: Debian (https://debian.org)'),{status:'failed',exit_code:1}).capable,false);});
