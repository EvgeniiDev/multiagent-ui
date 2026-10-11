import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import ts from 'typescript';
const source=readFileSync(new URL('../src/lib/flowchart.ts',import.meta.url),'utf8');const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const {renderFlowchart}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));

const diagram=`flowchart TD
    B[Binance WS и REST] --> C[Collector]
    C --> K[Kafka: md.spot / md.usdm]
    K --> Calc[Calc: стаканы и метрики]
    Calc --> PG[Postgres: состояние, offsets, история баров]
    PG --> OB[Существующий outbox баров]
    OB --> Bars[Kafka: bars.binance.market]
    Bars --> T[Trader: стратегии и исполнение]
    Calc --> S[Снапшот каждой готовой пары раз в 30 минут]
    S --> K
    K --> A[Archiver]
    A --> P[Локальный Parquet]
    P --> S3[S3 после проверки загрузки]`;

test('the binance pipeline renders every node label and edge',()=>{
  const svg=renderFlowchart(diagram);
  assert.ok(svg?.startsWith('<div class="flowchart"><svg'),'svg wrapper emitted');
  for(const label of['Binance WS и REST','Collector','Kafka: md.spot / md.usdm','Calc: стаканы и метрики','Postgres: состояние, offsets, история баров','Существующий outbox баров','Kafka: bars.binance.market','Trader: стратегии и исполнение','Снапшот каждой готовой пары раз в 30 минут','Archiver','Локальный Parquet','S3 после проверки загрузки'])
    assert.ok(svg.includes(`>${label}<`),`missing label: ${label}`);
  assert.equal((svg.match(/class="fc-edge"/g)||[]).length,12,'13 edges minus the S-->K cycle back-edge? all 12 listed edges drawn');
});

test('non-flowchart input and broken input return null',()=>{
  assert.equal(renderFlowchart('const x = 1;'),null);
  assert.equal(renderFlowchart('sequenceDiagram\n  A->>B: hi'),null);
  assert.equal(renderFlowchart('flowchart LR\n  just one node'),null);
});

test('chains, fan-out, labels, quotes and br-breaks parse',()=>{
  const svg=renderFlowchart('graph LR\n  A & B --> C["big &amp; long"] -- on the way --> D((end))\n  C -->|yes| E{d?}\n  E --> F[one<br>two]');
  assert.ok(svg);
  assert.equal((svg.match(/class="fc-edge"/g)||[]).length,5);
  for(const label of['big &amp;amp; long','on the way','yes','d?','end','one','two'])
    assert.ok(svg.includes(label),`missing ${label}`);
  assert.ok(svg.includes('<polygon'),'diamond shape');
  assert.ok(svg.includes('<circle'),'circle shape');
});

test('labels are escaped before entering the svg',()=>{
  const svg=renderFlowchart('flowchart TD\n  A["<img src=x>"] --> B');
  assert.ok(svg);
  assert.ok(svg.includes('&lt;img src=x&gt;'));
  assert.ok(!svg.includes('<img'));
});
