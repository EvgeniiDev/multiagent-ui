"""E2E: the token meter — opencode plugin (exact) + ws-bridge estimator
(approximate) + the dashboard's two-layer rendering.

Four acts, each with its own fixture:

  a) plugin: drive deploy/opencode/plugins/acp-token-meter.js in a bare node
     process with a canned SDK client (two assistant messages with known
     token counts), fire `session.idle` twice -> exactly one usage row lands
     in the test state server, tagged source:"agent", with the summed totals.
  b) bridge: spawn the repo's acp-ws-bridge.mjs over a fake NDJSON ACP agent
     and push session/prompt + agent_message_chunk traffic through a real
     WebSocket -> usage rows tagged source:"estimate" appear, `used` grows
     monotonically, agentName is the --agent-name label.
  c) dedup: identical plugin idle and an unchanged bridge session add no rows.
  d) dashboard: seed localStorage with one agent row + one estimate row ->
     the summary and by-agent table mark the estimate ("~"), the legend is
     present, and the day chart draws a stacked estimate segment.

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


# ---------------------------------------------------------------------------
# (b) bridge estimator: Devin/Pi traffic -> source:"estimate" running totals
# ---------------------------------------------------------------------------

FAKE_AGENT = r"""
// Minimal NDJSON ACP agent: answers session/new and session/prompt, emitting
// agent_message_chunk notifications between the request and its response.
let sessionCounter = 0;
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: `fake-${++sessionCounter}` } });
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
const { WebSocket } = require('ws');
const url = process.argv[2];
const ws = new WebSocket(url);
let id = 0;
let sessionId = null;
const send = (method, params) =>
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }));
ws.on('open', () => send('session/new', { cwd: '/tmp/fake-proj', mcpServers: [] }));
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
  if (msg.id === 2 && msg.result) {    // turn 1 done -> turn 2
    send('session/prompt', {           // id=3: +40 in + 60 out = +100 chars
      sessionId,
      prompt: [{ type: 'text', text: 'q'.repeat(40) }],
      chunkLen: 60, chunks: 1,
    });
  }
  if (msg.id === 3 && msg.result) {
    console.log('done sessionId=' + sessionId);
    ws.close();
    process.exit(0);
  }
});
ws.on('error', (e) => { console.error('ws error:', e.message); process.exit(1); });
setTimeout(() => { console.error('timeout'); process.exit(1); }, 15000);
"""


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
        proc = subprocess.run(
            ["node", str(client_file), f"ws://127.0.0.1:{bridge_port}"],
            capture_output=True, text=True, timeout=20, env=env,
        )
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

        # (c) dedup: no new traffic -> no new rows after settling.
        n0 = len(est)
        time.sleep(0.8)
        n1 = len([u for u in usage_rows(state_port)
                  if u.get("sessionId") == "fake-1" and u.get("source") == "estimate"])
        check("idle session writes nothing new", n1 == n0, f"{n0} -> {n1}")
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
         "cost": 0.10, "currency": "USD"},
        {"at": ms(now - timedelta(hours=1)), "agentName": "Devin",
         "sessionId": "s-est", "cwd": "/p/two", "used": 4000, "size": 0,
         "source": "estimate"},
    ]
    entries = [
        {"id": "e1", "at": usage[0]["at"], "kind": "turn-end",
         "agentName": "Hermes Agent", "sessionId": "s-fact", "cwd": "/p/one"},
        {"id": "e2", "at": usage[1]["at"], "kind": "turn-end",
         "agentName": "Devin", "sessionId": "s-est", "cwd": "/p/two"},
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

            # Summary mixes the layers: 10,000 exact + ~4,000 estimated.
            tokens = page.locator('[data-testid="sum-tokens"]').inner_text().strip()
            check("summary marks the estimated part", "10,000" in tokens
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

            check("zero pageerrors", page_errors == [], repr(page_errors[:2]))
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

    passed = sum(1 for ok, _, _ in checks if ok)
    print(f"\n{passed}/{len(checks)} assertions passed")
    return 0 if passed == len(checks) else 1


if __name__ == "__main__":
    sys.exit(main())
