import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {computed,ref} from 'vue';

const source=readFileSync(new URL('../src/stores/session.ts',import.meta.url),'utf8');
const match=source.match(/const anySession(?:Busy|Connecting) = computed\(\(\) =>([\s\S]*?)\n  \);/);
assert.ok(match,'Session-start gate must be defined');
function gate(tabs){const openTabs=ref(tabs);return {openTabs,blocked:new Function('computed','openTabs',`return computed(() => ${match[1]});`)(computed,openTabs)};}

test('an answering agent does not block a new session',()=>{const {blocked}=gate([{isLoading:true,isConnecting:false}]);assert.equal(blocked.value,false);});
test('a connection in flight blocks a duplicate start, then an answer does not',()=>{const {blocked,openTabs}=gate([{isLoading:true,isConnecting:true}]);assert.equal(blocked.value,true);openTabs.value[0].isConnecting=false;assert.equal(blocked.value,false);});
test('background answers and a failed connection do not block the plus',()=>{const {blocked,openTabs}=gate([{isLoading:true,isConnecting:false},{isLoading:false,isConnecting:true}]);assert.equal(blocked.value,true);openTabs.value[1].isConnecting=false;assert.equal(blocked.value,false);});
