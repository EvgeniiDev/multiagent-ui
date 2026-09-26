"""E2E: the token meter — opencode plugin (exact) + ws-bridge estimator
(approximate) + the dashboard's two-layer rendering.

Five acts, each with its own fixture:

  a) plugin: drive deploy/opencode/plugins/acp-token-meter.js in a bare node
     process with a canned SDK client (two assistant messages with known
     token counts), fire `session.idle` twice -> exactly one usage row lands
     in the test state server, tagged source:"agent", with the summed totals
     and the message's providerID/modelID pair.
  b) bridge: spawn the repo's acp-ws-bridge.mjs over a fake NDJSON ACP agent
     and push session/prompt + agent_message_chunk traffic through a real
     WebSocket -> usage rows tagged source:"estimate" appear, `used` grows
     monotonically, agentName is the --agent-name label, and `model` is
     whatever the agent announced on session/new (three shapes are driven:
     a configOptions model select, a models.currentModelId block plus a
     mid-session session/set_model switch, and no announcement at all ->
     honest 'unknown').
  c) dedup: identical plugin idle and an unchanged bridge session add no rows.
  d) dashboard: seed localStorage with agent + estimate rows (some with
     model/provider, one legacy row without) -> the summary and by-agent
     table mark the estimate ("~"), the by-model table groups per announced
     model with 'unknown' for legacy rows, and the day chart draws a stacked
     estimate segment.
  e) panel writer: a WS mock agent announces models.currentModelId on
     session/new and emits usage_update on the prompt -> the usage row the
     panel itself writes carries the announced model + provider 'unknown'.

Usage: npm run build:web && ~/.hermes/tools-venv/bin/python scripts/e2e_token_meter.py
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from _e2e_harness import (
    DIST, ROOT, port_free, serve_state, serve_web, stop, wait_port,
)

REPO = ROOT
PLUGIN = REPO / "deploy" / "opencode" / "plugins" / "acp-token-meter.js"
BRIDGE = REPO / "server" / "acp-ws-bridge.mjs"
NODE_PATH = subprocess.run(
    ["npm", "root", "-g"], capture_output=True, text=True
).stdout.strip()

checks: list[tuple[bool, str, str]] = []
page_errors: list[str] = []


def check(name, ok, detail=""):
    checks.append((bool(ok), name, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail else ""))


def state_get(port: int, name: str) -> dict:
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/api/state/{name}", timeout=5
        ) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return {}
        raise


def usage_rows(port: int) -> list[dict]:
    doc = state_get(port, "activity.json")
    data = doc.get("data") or {}
    return data.get("usage") or []


def wait_rows(port: int, pred, timeout: float = 8.0, what: str = "rows") -> list[dict]:
    """Poll usage[] until `pred(rows)` is truthy; returns the last rows seen."""
    deadline = time.time() + timeout
    rows: list[dict] = []
    while time.time() < deadline:
        rows = usage_rows(port)
        if pred(rows):
            return rows
        time.sleep(0.2)
    check(f"{what} appeared in time", False, f"last rows: {rows!r}")
    return rows


# ---------------------------------------------------------------------------
# (a) + (c) plugin: exact OpenCode numbers via session.idle
# ---------------------------------------------------------------------------

PLUGIN_RUNNER = r"""
import { AcpTokenMeter } from 'PLUGIN_URL';

const messages = [
  { info: { role: 'user', id: 'u1' }, parts: [] },
  { info: {
      role: 'assistant', id: 'a1', providerID: 'prov', modelID: 'mod',
      cost: 0.01,
      tokens: { input: 100, output: 40, reasoning: 10, cache: { read: 5, write: 2 } },
  }, parts: [] },
  { info: {
      role: 'assistant', id: 'a2', providerID: 'prov', modelID: 'mod',
      cost: 0.02,
      tokens: { input: 200, output: 80, reasoning: 20, cache: { read: 0, write: 0 } },
  }, parts: [] },
];
// used = 100+40+10+5+2 + 200+80+20 = 457; cost = 0.03

const client = {
  session: {
    messages: async () => ({ data: messages }),
    get: async () => ({ data: { directory: '/tmp/oc-project' } }),
  },
  provider: {
    list: async () => ({ data: { all: [{ id: 'prov', models: { mod: { limit: { context: 128000 } } } }] } }),
  },
  app: { log: async () => {} },
};

const hooks = await AcpTokenMeter({ client });
const idle = { type: 'session.idle', properties: { sessionID: 'oc-sess-1' } };
await hooks.event({ event: idle });
await hooks.event({ event: idle }); // dedup: same totals -> no second write
console.log('plugin-done');
"""


def run_plugin(state_port: int, tmp: Path):
    # .mjs so node treats the plugin as ESM regardless of package.json —
    # opencode itself loads the .js via Bun and doesn't care.
    plugin_mjs = tmp / "acp-token-meter.mjs"
    plugin_mjs.write_text(PLUGIN.read_text())
    runner = PLUGIN_RUNNER.replace("PLUGIN_URL", plugin_mjs.as_uri())
    env = {**os.environ, "ACP_STATE_URL": f"http://127.0.0.1:{state_port}"}
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", runner],
        capture_output=True, text=True, timeout=30, env=env,
    )
    check("plugin runner completed", proc.returncode == 0 and "plugin-done" in proc.stdout,
          f"rc={proc.returncode} stderr={proc.stderr.strip()[:300]}")

    rows = wait_rows(
        state_port,
        lambda r: any(u.get("source") == "agent" and u.get("sessionId") == "oc-sess-1" for u in r),
        what="plugin sample",
    )
    mine = [u for u in rows if u.get("sessionId") == "oc-sess-1"]
    check("plugin wrote exactly one agent sample (dedup held)", len(mine) == 1,
          f"rows={len(mine)}")
    if mine:
        u = mine[0]
        check("plugin sample is exact + tagged", u.get("source") == "agent" and u.get("used") == 457,
              f"row={u}")
        check("plugin sample carries size/cost/cwd", u.get("size") == 128000 and
              abs(u.get("cost", 0) - 0.03) < 1e-9 and u.get("cwd") == "/tmp/oc-project",
              f"row={u}")
        check("plugin sample carries provider/model from the message",
              u.get("provider") == "prov" and u.get("model") == "mod", f"row={u}")


# ---------------------------------------------------------------------------
# (b) bridge estimator: Devin/Pi traffic -> source:"estimate" running totals
# ---------------------------------------------------------------------------

FAKE_AGENT = r"""
// Minimal NDJSON ACP agent: answers session/new and session/prompt, emitting
// agent_message_chunk notifications between the request and its response.
// session/new echoes the model announcement style the client asked for via
// params.modelMode: 'config' -> a configOptions model select (OpenCode/Devin
// shape), 'models' -> a models.currentModelId block (Hermes/Pi shape),
// anything else -> no model announcement at all.
let sessionCounter = 0;
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  if (msg.method === 'session/new') {
    const result = { sessionId: `fake-${++sessionCounter}` };
    const mode = msg.params?.modelMode;
    if (mode === 'config') {
      result.configOptions = [
        { id: 'model', name: 'Model', category: 'model', type: 'select',
          currentValue: 'cfg/fake-model-2',
          options: [{ value: 'cfg/fake-model-2', name: 'Fake 2' }] },
      ];
    } else if (mode === 'models') {
      result.models = {
        currentModelId: 'wire/fake-model-1',
        availableModels: [{ modelId: 'wire/fake-model-1', name: 'Fake 1' }],
      };
    }
    send({ jsonrpc: '2.0', id: msg.id, result });
  } else if (msg.method === 'session/prompt') {
    const sid = msg.params.sessionId;
    const chunks = (msg.params.chunks || 2);
    const text = 'x'.repeat(msg.params.chunkLen || 40);
    let i = 0;
    const tick = () => {
      if (i++ < chunks) {
        send({ jsonrpc: '2.0', method: 'session/update',
               params: { sessionId: sid,
                         update: { sessionUpdate: 'agent_message_chunk',
                                   content: { type: 'text', text } } } });
        setTimeout(tick, 120);
      } else {
        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      }
    };
    tick();
  } else if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  }
});
"""

WS_CLIENT = r"""
// Drive the bridge like a panel would: session/new, then two session/prompt
// turns on the SAME session — the running total must grow monotonically.
//   argv[2] ws url · argv[3] modelMode echoed in session/new params
//   argv[4] optional modelId -> a session/set_model request between the turns
const { WebSocket } = require('ws');
const url = process.argv[2];
const modelMode = process.argv[3] || 'none';
const switchTo = process.argv[4] || '';
const ws = new WebSocket(url);
let id = 0;
let sessionId = null;
const send = (method, params) =>
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }));
const prompt2 = () => send('session/prompt', {  // +40 in + 60 out = +100 chars
  sessionId,
  prompt: [{ type: 'text', text: 'q'.repeat(40) }],
  chunkLen: 60, chunks: 1,
});
ws.on('open', () =>
  send('session/new', { cwd: '/tmp/fake-proj', mcpServers: [], modelMode }));
ws.on('message', (d) => {
  const msg = JSON.parse(d.toString());
  if (msg.result?.sessionId) {
    sessionId = msg.result.sessionId;
    send('session/prompt', {           // id=2: 80 in + 3*60 out = 260 chars
      sessionId,
      prompt: [{ type: 'text', text: 'p'.repeat(80) }],
      chunkLen: 60, chunks: 3,
    });
  }
  if (msg.id === 2 && msg.result) {    // turn 1 done
    if (switchTo) send('session/set_model', { sessionId, modelId: switchTo });
    else prompt2();                    // id=3
  }
  if (msg.id === 3 && msg.result) {
    if (switchTo) prompt2();           // id=4 after the set_model ack
    else { console.log('done sessionId=' + sessionId); ws.close(); process.exit(0); }
  }
  if (msg.id === 4 && msg.result) {
    console.log('done sessionId=' + sessionId);
    ws.close();
    process.exit(0);
  }
});
ws.on('error', (e) => { console.error('ws error:', e.message); process.exit(1); });
setTimeout(() => { console.error('timeout'); process.exit(1); }, 15000);
"""


def run_client(client_file: Path, bridge_port: int, env: dict,
               model_mode: str, switch_to: str = ""):
    return subprocess.run(
        ["node", str(client_file), f"ws://127.0.0.1:{bridge_port}",
         model_mode, switch_to],
        capture_output=True, text=True, timeout=20, env=env,
    )


def est_rows(state_port: int, session_id: str) -> list[dict]:
    return [u for u in usage_rows(state_port)
            if u.get("sessionId") == session_id and u.get("source") == "estimate"]


def run_bridge(state_port: int, tmp: Path):
    agent_file = tmp / "fake-agent.cjs"
    agent_file.write_text(FAKE_AGENT)
    client_file = tmp / "ws-client.cjs"
    client_file.write_text(WS_CLIENT)

    env = {
        **os.environ,
        "NODE_PATH": NODE_PATH,
        "ACP_STATE_URL": f"http://127.0.0.1:{state_port}",
        "ACP_TOKEN_METER_INTERVAL_MS": "50",
    }
    bridge_port = state_port + 60
    while not port_free(bridge_port):
        bridge_port += 1
    bridge = subprocess.Popen(
        ["node", str(BRIDGE), "--port", str(bridge_port),
         "--cmd", f"node {agent_file}", "--agent-name", "Devin"],
        env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    try:
        if not wait_port(bridge_port, 10):
            check("bridge listening", False, "port never came up")
            return

        # fake-1: model announced as a configOptions select (OpenCode/Devin).
        proc = run_client(client_file, bridge_port, env, "config")
        check("ws client drove two prompt turns", proc.returncode == 0,
              f"rc={proc.returncode} out={proc.stdout.strip()} err={proc.stderr.strip()[:200]}")

        # turn 1: 80 prompt + 3x60 chunk = 260 chars -> 65 tokens
        # turn 2: +40 prompt + 60 chunk   = 360 chars -> 90 tokens
        rows = wait_rows(
            state_port,
            lambda r: any(u.get("source") == "estimate" and u.get("sessionId") == "fake-1"
                          and u.get("used") == 90 for u in r),
            what="grown estimate",
        )
        est = [u for u in rows if u.get("sessionId") == "fake-1" and u.get("source") == "estimate"]
        uses = [u.get("used") for u in est]
        check("bridge estimate samples written", len(est) >= 1, f"rows={len(est)}")
        check("estimate is chars/4 running total, monotonic per session",
              len(uses) >= 2 and uses[-1] == 90 and uses == sorted(uses),
              f"used series={uses}")
        if est:
            u = est[-1]
            check("estimate tagged source+size:0+agentName",
                  u.get("source") == "estimate" and u.get("size") == 0
                  and u.get("agentName") == "Devin" and u.get("cwd") == "/tmp/fake-proj",
                  f"row={u}")
            check("estimate picked up the configOptions model, provider unknown",
                  u.get("model") == "cfg/fake-model-2" and u.get("provider") == "unknown",
                  f"row={u}")

        # (c) dedup: no new traffic -> no new rows after settling.
        n0 = len(est)
        time.sleep(0.8)
        n1 = len(est_rows(state_port, "fake-1"))
        check("idle session writes nothing new", n1 == n0, f"{n0} -> {n1}")

        # fake-2: models.currentModelId announced, then switched mid-session
        # via session/set_model — the later rows must carry the new id.
        proc = run_client(client_file, bridge_port, env, "models",
                          "switched/fake-model-9")
        check("ws client drove the models+set_model session", proc.returncode == 0,
              f"rc={proc.returncode} out={proc.stdout.strip()} err={proc.stderr.strip()[:200]}")
        rows = wait_rows(
            state_port,
            lambda r: any(u.get("sessionId") == "fake-2" and u.get("source") == "estimate"
                          and u.get("used") == 90 for u in r),
            what="fake-2 estimates",
        )
        est2 = [u for u in rows if u.get("sessionId") == "fake-2" and u.get("source") == "estimate"]
        check("models.currentModelId lands on estimate rows",
              bool(est2) and est2[0].get("model") == "wire/fake-model-1",
              f"first={est2[0] if est2 else None}")
        check("set_model mid-session rewrites the estimate model",
              bool(est2) and est2[-1].get("model") == "switched/fake-model-9",
              f"last={est2[-1] if est2 else None}")

        # fake-3: no model announcement at all -> honest 'unknown'.
        proc = run_client(client_file, bridge_port, env, "none")
        check("ws client drove the unannounced session", proc.returncode == 0,
              f"rc={proc.returncode} err={proc.stderr.strip()[:200]}")
        rows = wait_rows(
            state_port,
            lambda r: any(u.get("sessionId") == "fake-3" and u.get("source") == "estimate"
                          and u.get("used") == 90 for u in r),
            what="fake-3 estimates",
        )
        est3 = [u for u in rows if u.get("sessionId") == "fake-3" and u.get("source") == "estimate"]
        check("no announcement -> model/provider 'unknown'",
              bool(est3) and est3[-1].get("model") == "unknown"
              and est3[-1].get("provider") == "unknown",
              f"last={est3[-1] if est3 else None}")
    finally:
        stop(bridge)


# ---------------------------------------------------------------------------
# (d) dashboard renders both layers honestly
# ---------------------------------------------------------------------------

def run_dashboard():
    from playwright.sync_api import sync_playwright

    now = datetime.now(timezone.utc).replace(microsecond=0)
    ms = lambda d: int(d.timestamp() * 1000)
    usage = [
        {"at": ms(now - timedelta(hours=2)), "agentName": "Hermes Agent",
         "sessionId": "s-fact", "cwd": "/p/one", "used": 10000, "size": 200000,
         "cost": 0.10, "currency": "USD",
         "model": "openrouter:anthropic/claude-fable-5.1", "provider": "unknown"},
        {"at": ms(now - timedelta(hours=1)), "agentName": "Devin",
         "sessionId": "s-est", "cwd": "/p/two", "used": 4000, "size": 0,
         "source": "estimate", "model": "swe-2-high", "provider": "unknown"},
        # Legacy row, written before model/provider existed: must read as
        # 'unknown', not vanish or break the grouping.
        {"at": ms(now - timedelta(minutes=30)), "agentName": "OpenCode",
         "sessionId": "s-legacy", "cwd": "/p/three", "used": 1500, "size": 0,
         "cost": 0.02, "currency": "USD"},
    ]
    entries = [
        {"id": "e1", "at": usage[0]["at"], "kind": "turn-end",
         "agentName": "Hermes Agent", "sessionId": "s-fact", "cwd": "/p/one"},
        {"id": "e2", "at": usage[1]["at"], "kind": "turn-end",
         "agentName": "Devin", "sessionId": "s-est", "cwd": "/p/two"},
        {"id": "e3", "at": usage[2]["at"], "kind": "turn-end",
         "agentName": "OpenCode", "sessionId": "s-legacy", "cwd": "/p/three"},
    ]
    fixture = json.dumps({"entries": entries, "usage": usage})
    agents = {"agents": {"Hermes Agent": {"transport": "websocket", "url": "ws://127.0.0.1:1/"},
                         "Devin": {"transport": "websocket", "url": "ws://127.0.0.1:1/"}}}
    prefs = {"telemetryEnabled": False, "activeView": "dashboard"}

    proc, base = serve_web(25997, DIST)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            ctx = browser.new_context(viewport={"width": 1440, "height": 900})
            for key, val in (("acp-ui:agents", agents),
                             ("acp-ui:preferences.json", prefs),
                             ("acp-ui:activity.json", json.loads(fixture))):
                ctx.add_init_script(
                    f"localStorage.setItem({json.dumps(key)}, {json.dumps(json.dumps(val))});")
            page = ctx.new_page()
            page.route(re.compile(r":25900/"), lambda r: r.abort())
            page.on("pageerror", lambda e: page_errors.append(str(e)))
            page.goto(base, wait_until="load")
            page.wait_for_selector(".view-rail", timeout=10000)
            page.click('button[aria-label="Dashboard"]')
            page.wait_for_selector('[data-testid="dashboard"]', timeout=8000)
            page.wait_for_timeout(500)

            # Summary mixes the layers: 10,000 + 1,500 exact + ~4,000 estimated.
            tokens = page.locator('[data-testid="sum-tokens"]').inner_text().strip()
            check("summary marks the estimated part", "11,500" in tokens
                  and "~4,000" in tokens, f"sum-tokens={tokens!r}")
            check("legend explains the layers",
                  page.locator('[data-testid="usage-legend"]').count() == 1
                  and "estimate" in page.locator('[data-testid="usage-legend"]').inner_text(),
                  "usage-legend")

            devin = page.locator('[data-testid="by-agent-row"][data-agent="Devin"]')
            check("by-agent row flags Devin as estimated",
                  devin.count() == 1 and devin.get_attribute("data-est") == "true",
                  f"rows={devin.count()}")
            if devin.count():
                cell = devin.locator('td[data-label="Tokens"]').inner_text().strip()
                check("all-estimate agent shows ~N", cell.startswith("~"), f"cell={cell!r}")
            hermes = page.locator('[data-testid="by-agent-row"][data-agent="Hermes Agent"]')
            check("agent-reported row stays plain",
                  hermes.count() == 1 and hermes.get_attribute("data-est") == "false",
                  f"attr={hermes.get_attribute('data-est') if hermes.count() else 'missing'}")

            est_bars = page.locator('[data-testid="day-bar-est"]')
            check("day chart draws the estimate segment", est_bars.count() >= 1,
                  f"est bars={est_bars.count()}")

            # By-model grouping: one row per announced model + 'unknown' for
            # the legacy sample; the estimate row keeps its ~ mark.
            model_rows = page.locator('[data-testid="by-model-row"]')
            check("by-model table renders one row per model",
                  model_rows.count() == 3,
                  f"rows={model_rows.count()}")
            m_hermes = page.locator('[data-testid="by-model-row"][data-model="openrouter:anthropic/claude-fable-5.1"]')
            check("agent row groups under its announced model",
                  m_hermes.count() == 1
                  and "10,000" in m_hermes.locator('td[data-label="Tokens"]').inner_text()
                  and "unknown" in m_hermes.locator('td[data-label="Provider"]').inner_text(),
                  f"row={m_hermes.inner_text() if m_hermes.count() else 'missing'}")
            m_est = page.locator('[data-testid="by-model-row"][data-model="swe-2-high"]')
            check("estimate model row keeps the ~ mark",
                  m_est.count() == 1 and m_est.get_attribute("data-est") == "true"
                  and "~" in m_est.locator('td[data-label="Tokens"]').inner_text(),
                  f"row={m_est.inner_text() if m_est.count() else 'missing'}")
            m_unk = page.locator('[data-testid="by-model-row"][data-model="unknown"]')
            check("legacy sample without fields groups as unknown",
                  m_unk.count() == 1
                  and "1,500" in m_unk.locator('td[data-label="Tokens"]').inner_text(),
                  f"row={m_unk.inner_text() if m_unk.count() else 'missing'}")

            check("zero pageerrors", page_errors == [], repr(page_errors[:2]))
            browser.close()
    finally:
        stop(proc)


# ---------------------------------------------------------------------------
# (e) panel writer: usage_update recorded with the announced session model
# ---------------------------------------------------------------------------

def run_panel_writer():
    """The panel itself is the third writer: handleSessionUpdate must stamp
    the session's announced model onto the usage row it records. A mocked
    WS agent (playwright route_web_socket, like e2e_live_stream) announces
    models.currentModelId on session/new and emits a usage_update during the
    first prompt; the persisted localStorage ledger must carry the pair."""
    from playwright.sync_api import sync_playwright

    def acp_ws(ws):
        def on_message(message):
            for line in str(message).split("\n"):
                line = line.strip()
                if not line:
                    continue
                try:
                    req = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(req, dict) or "method" not in req:
                    continue
                method, rid = req["method"], req.get("id")
                sid = "panel-sess-1"
                if method == "initialize":
                    ws.send(json.dumps({"jsonrpc": "2.0", "id": rid, "result": {
                        "protocolVersion": 1, "agentCapabilities": {},
                        "authMethods": [],
                        "agentInfo": {"name": "e2e-mock", "version": "0"}}}))
                elif method == "session/new":
                    ws.send(json.dumps({"jsonrpc": "2.0", "id": rid, "result": {
                        "sessionId": sid,
                        "models": {
                            "currentModelId": "panel/fake-model-7",
                            "availableModels": [
                                {"modelId": "panel/fake-model-7", "name": "Fake 7"}],
                        }}}))
                elif method == "session/prompt":
                    ws.send(json.dumps({"jsonrpc": "2.0", "method": "session/update",
                        "params": {"sessionId": sid, "update": {
                            "sessionUpdate": "usage_update",
                            "used": 777, "size": 131072,
                            "cost": {"amount": 0.005, "currency": "USD"}}}}))
                    ws.send(json.dumps({"jsonrpc": "2.0", "id": rid,
                                        "result": {"stopReason": "end_turn"}}))
                elif rid is not None:
                    ws.send(json.dumps({"jsonrpc": "2.0", "id": rid, "result": {}}))
        ws.on_message(on_message)

    def fs_api(route):
        body = ({"root": "/home/hermes"} if "/api/fs/root" in route.request.url else
                {"path": "/home/hermes", "parent": "/home", "root": "/home/hermes",
                 "dirs": [{"name": "projects", "path": "/home/hermes/projects"}]})
        route.fulfill(status=200, content_type="application/json", body=json.dumps(body))

    proc, base = serve_web(25998, DIST)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            ctx = browser.new_context(viewport={"width": 1440, "height": 900})
            agents = {"agents": {"E2E Mock": {"transport": "websocket",
                                              "url": "ws://127.0.0.1:25990/"}}}
            prefs = {"telemetryEnabled": False, "lastCwd": "/home/hermes/projects"}
            for key, val in (("acp-ui:agents", agents),
                             ("acp-ui:preferences.json", prefs)):
                ctx.add_init_script(
                    f"localStorage.setItem({json.dumps(key)}, {json.dumps(json.dumps(val))});")
            page = ctx.new_page()
            page.route(re.compile(r"/api/fs/"), fs_api)
            page.route(re.compile(r":25900/"), lambda r: r.abort())
            page.route_web_socket(re.compile(r"^wss?://"), acp_ws)
            page.on("pageerror", lambda e: page_errors.append(str(e)))
            page.goto(base, wait_until="load")
            page.wait_for_selector(".list-new-session:not([disabled])", timeout=15000)
            page.click(".list-new-session")
            page.wait_for_selector(".composer-box textarea", timeout=15000)
            page.fill(".composer-box textarea", "hi")
            page.click(".send-btn")
            page.wait_for_function(
                "() => JSON.parse(localStorage.getItem('acp-ui:activity.json') || '{}')"
                ".usage?.length > 0",
                timeout=10000)
            doc = json.loads(page.evaluate(
                "localStorage.getItem('acp-ui:activity.json')") or "{}")
            rows = doc.get("usage") or []
            u = next((r for r in rows if r.get("sessionId") == "panel-sess-1"), None)
            check("panel recorded the usage_update", u is not None,
                  f"usage={rows!r}")
            if u:
                check("panel row carries the announced model + provider unknown",
                      u.get("model") == "panel/fake-model-7"
                      and u.get("provider") == "unknown"
                      and u.get("source") == "agent" and u.get("used") == 777,
                      f"row={u}")
            check("panel leg: zero pageerrors", page_errors == [], repr(page_errors[:2]))
            browser.close()
    finally:
        stop(proc)


def main() -> int:
    if not DIST.is_dir():
        print(f"FAIL  {DIST} missing — run `npm run build:web` first")
        return 1
    with tempfile.TemporaryDirectory(prefix="token-meter-e2e-") as td:
        state_dir = Path(td) / "state"
        state_dir.mkdir()
        state_proc, state_port = serve_state(25940, state_dir)
        try:
            run_plugin(state_port, Path(td))
            run_bridge(state_port, Path(td))
        finally:
            stop(state_proc)
    run_dashboard()
    run_panel_writer()

    passed = sum(1 for ok, _, _ in checks if ok)
    print(f"\n{passed}/{len(checks)} assertions passed")
    return 0 if passed == len(checks) else 1


if __name__ == "__main__":
    sys.exit(main())
