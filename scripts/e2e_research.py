#!/usr/bin/env python3
"""E2E for the researcher pipeline (scripts/research/*).

Fully offline: collect.py runs on fixtures (Atom XML + tg JSON), so no
Reddit quota, no Telegram, no Apify spend. A scratch state server proves
the boardctl card-creation leg; a stub "researcher" role proves the
generic wakeup spawn (PM_ROLE_ID + PM_BRIEF_FILE over
server/acp-pm-wakeup.mjs).

Legs:

  1. collect  — fixtures -> items.jsonl + digest.md; scoring ranks the
     kanban post over the meme (PENALTY axis), comments attach;
  2. dedup    — same fixtures again -> 0 new items;
  3. rotate   — a 429-marker sub lands in failed_subs and is fetched
     FIRST on the next run (failures-first, the RSS-quota strategy);
  4. idea     — idea.py add appends "## Идея #N" to a scratch backlog,
     idea.py card creates a real card on the test board and links it
     back into the backlog;
  5. wakeup   — PM_ROLE_ID=researcher + PM_BRIEF_FILE -> the generic
     runner spawns the stub role, brief carries the digest path, ledger
     gains kind:'researcher' rows, report file is research-report.md.

Usage:
    ~/.hermes/tools-venv/bin/python scripts/e2e_research.py
"""

import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from _e2e_harness import serve_state, stop, wait_port

ROOT = Path(__file__).resolve().parent.parent
PY = sys.executable
COLLECT = ROOT / "scripts" / "research" / "collect.py"
IDEA = ROOT / "scripts" / "research" / "idea.py"
WAKEUP = ROOT / "server" / "acp-pm-wakeup.mjs"
CONFIG = ROOT / "scripts" / "research" / "sources.acp-ui.json"
WORK = ROOT / "tmp-research-test"
FIXTURES = WORK / "fixtures"
STATE_FILE = WORK / "state.json"
BACKLOG = WORK / "IDEA_BACKLOG.md"
BRIEF_TPL = WORK / "brief-template.md"
STUB = WORK / "stub_researcher.py"
STATE_PORT = 25944  # preferred; harness falls back when busy
STATE_URL = f"http://127.0.0.1:{STATE_PORT}"  # rebased in main()

results = []


def check(name, ok, extra=""):
    results.append((name, bool(ok), extra))
    print(f"{'PASS' if ok else 'FAIL'}  {name}"
          + (f"  ({extra})" if extra else ""))


def api(path, method="GET", body=None):
    req = urllib.request.Request(
        STATE_URL + "/api/state" + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=5) as res:
            return res.status, json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except ValueError:
            return e.code, {}


def get_doc(name):
    status, body = api(f"/{name}")
    if status == 200:
        return body.get("data"), body.get("rev", 0)
    return None, 0


def put(name, data):
    _, rev = get_doc(name)
    st, body = api(f"/{name}", "PUT", {"data": data, "rev": rev})
    assert st == 200, f"put {name} -> {st} {body}"


def collect(out_dir, extra=None):
    cmd = [PY, str(COLLECT), "--config", str(CONFIG),
           "--subs", "GoodSub,BadSub", "--comments", "rss",
           "--fixtures", str(FIXTURES), "--state", str(STATE_FILE),
           "--out", str(out_dir)]
    return subprocess.run(cmd + (extra or []), capture_output=True,
                          text=True, timeout=120, cwd=ROOT)


ATOM_HEAD = ('<?xml version="1.0" encoding="UTF-8"?>\n'
             '<feed xmlns="http://www.w3.org/2005/Atom">\n')
ATOM_TAIL = "</feed>\n"


def entry(pid, title, link_id, ts, author, body):
    return (f'<entry><id>{pid}</id><title>{title}</title>'
            f'<link href="https://www.reddit.com/r/GoodSub/comments/'
            f'{link_id}/x/"/><updated>{ts}</updated>'
            f'<author><name>/u/{author}</name></author>'
            f'<content type="html">&lt;p&gt;{body}&lt;/p&gt;</content>'
            f'</entry>\n')


def write_fixtures():
    (FIXTURES / "reddit").mkdir(parents=True)
    (FIXTURES / "comments").mkdir(parents=True)
    (FIXTURES / "tg").mkdir(parents=True)
    (FIXTURES / "reddit" / "GoodSub.xml").write_text(
        ATOM_HEAD
        + entry("t3_k1", "Kanban board for claude code agents — "
                "claim/lease, git worktrees per card", "k1",
                "2099-01-01T00:00:00+00:00", "orch",
                "Multi-agent dispatch, claim/lease per card, reviewer "
                "handoff.")
        + entry("t3_m1", "funny GPU meme", "m1",
                "2099-01-01T01:00:00+00:00", "meme", "shitpost lol")
        + ATOM_TAIL)
    (FIXTURES / "comments" / "k1.xml").write_text(
        ATOM_HEAD
        + entry("t1_c1", "c1", "k1", "2099-01-01T02:00:00+00:00",
                "comm1", "Cold reviewer context is the real feature.")
        + entry("t1_c2", "c2", "k1", "2099-01-01T02:05:00+00:00",
                "comm2", "Lease expiry returns cards to ready.")
        + ATOM_TAIL)
    (FIXTURES / "reddit" / "BadSub.xml").write_text(ATOM_HEAD + ATOM_TAIL)
    # the .429 marker simulates a rate-limited sub until leg 3 removes it
    (FIXTURES / "reddit" / "BadSub.xml.429").write_text("")
    (FIXTURES / "tg" / "ai-driven-chat.json").write_text(json.dumps([
        {"id": 1, "date": "2099-01-01 03:00:00", "sender": "@x",
         "chat": "AI-Driven",
         "text": "Новая free-tier модель qwen-coder, benchmarks ок",
         "reply_to": None, "views": 7},
    ]))


STUB_SRC = '''#!/usr/bin/env python3
"""Stub researcher CLI: reads the brief file, writes the named report."""
import os
import sys
from pathlib import Path

args = sys.argv[1:]
pf = args[args.index("--prompt-file") + 1] if "--prompt-file" in args else ""
brief = Path(pf).read_text(encoding="utf-8") if pf else ""
digest = [l for l in brief.splitlines() if "дайджест" in l or "digest" in l]
print("stub-researcher: brief", len(brief), "bytes;",
      digest[0].strip()[:120] if digest else "no digest line")
run_dir = Path(os.environ["PM_WAKEUP_RUN_DIR"])
run_dir.mkdir(parents=True, exist_ok=True)
(run_dir / "research-report.md").write_text(
    "# research report\\n\\nSTATUS: DONE\\n", encoding="utf-8")
return_code = 0
sys.exit(return_code)
'''


def leg_collect():
    out = WORK / "run1"
    r = collect(out)
    check("collect: exit 0", r.returncode == 0,
          (r.stderr or "")[-160:])
    items = [json.loads(l) for l in
             (out / "items.jsonl").read_text().splitlines() if l.strip()]
    check("collect: 3 items (2 reddit + 1 tg)", len(items) == 3,
          f"{len(items)}")
    by_id = {i["id"]: i for i in items}
    k1 = by_id.get("t3_k1") or {}
    check("collect: scoring — kanban post outranks the meme",
          k1.get("score", 0) > (by_id.get("t3_m1") or {}).get("score", 0)
          and k1.get("score", 0) > 0,
          f"scores {k1.get('score')} vs "
          f"{(by_id.get('t3_m1') or {}).get('score')}")
    check("collect: PENALTY axis hit on the meme",
          "PENALTY" in (by_id.get("t3_m1") or {}).get("axes", []))
    check("collect: comments attached to the top post",
          len(k1.get("comments") or []) == 2,
          f"{len(k1.get('comments') or [])} comments")
    dig = (out / "digest.md").read_text()
    check("collect: digest lists sources + comments",
          "r/GoodSub" in dig and "tg:ai-driven-chat" in dig
          and "Cold reviewer context" in dig)


def leg_dedup():
    out = WORK / "run2"
    r = collect(out, extra=["--print-new-count"])
    n = r.stdout.strip().splitlines()[-1] if r.stdout.strip() else "?"
    check("dedup: second run finds 0 new", n == "0", f"new={n}")
    st = json.loads(STATE_FILE.read_text())
    check("dedup: seen-set persisted",
          len(st.get("seen", {})) >= 3, f"{len(st.get('seen', {}))} seen")
    check("rotate: 429-marker sub recorded as failed",
          "BadSub" in st.get("failed_subs", []),
          json.dumps(st.get("failed_subs")))
    # stderr fetch order on this same run proves failures-first ordering
    lines = [l for l in r.stderr.splitlines()
             if "r/GoodSub" in l or "r/BadSub" in l]
    check("rotate: failed sub fetched first next run",
          lines and "BadSub" in lines[0],
          lines[0].strip()[:80] if lines else "no fetch lines")


def leg_failures_first():
    # Marker removed -> the previously-failed sub recovers, list clears.
    (FIXTURES / "reddit" / "BadSub.xml.429").unlink()
    r = collect(WORK / "run3")
    st = json.loads(STATE_FILE.read_text())
    check("rotate: recovered sub clears the failed list",
          "BadSub" not in st.get("failed_subs", []),
          json.dumps(st.get("failed_subs")))
    lines = [l for l in r.stderr.splitlines() if "r/BadSub" in l]
    check("rotate: recovered sub fetched (first, as failed-first)",
          lines and "0 posts" in lines[0],
          lines[0].strip()[:80] if lines else "none")


def leg_idea():
    env = dict(os.environ)
    env["IDEA_BACKLOG"] = str(BACKLOG)
    BACKLOG.write_text("# Журнал идей на ресёрч (Idea Backlog)\n\n")
    r = subprocess.run(
        [PY, str(IDEA), "add", "--title", "Kanban claim/lease для агентов",
         "--context", "r/GoodSub: worktrees per card, lease returns to ready",
         "--notes", "e2e fixture", "--source",
         "https://www.reddit.com/r/GoodSub/comments/k1/x/"],
        capture_output=True, text=True, env=env)
    n = r.stdout.strip()
    check("idea: add returns a number", n.isdigit(), f"n={n} {r.stderr[:100]}")
    text = BACKLOG.read_text()
    check("idea: backlog block written",
          f"## Идея #{n}" in text and "**Статус:** NEW" in text
          and "reddit.com" in text)

    env["BOARD_URL"] = STATE_URL
    env["BOARDCTL"] = str(ROOT / "scripts" / "boardctl")
    r = subprocess.run(
        [PY, str(IDEA), "card", "--num", n, "--project", "acp-ui",
         "--stage", "backlog"],
        capture_output=True, text=True, env=env, cwd=ROOT)
    cid = r.stdout.strip().splitlines()[-1] if r.stdout.strip() else ""
    check("idea: card created on the test board", bool(cid),
          f"rc={r.returncode} out={r.stdout.strip()[:120]}")
    doc, _ = get_doc("board.json")
    cards = (doc or {}).get("cards", [])
    mine = [c for c in cards if c.get("id", "").startswith(cid[:8])]
    check("idea: card visible via api, backlog stage, project acp-ui",
          len(mine) == 1 and mine[0].get("stage") == "backlog"
          and mine[0].get("project") == "acp-ui",
          json.dumps(mine[0])[:160] if mine else "none")
    check("idea: idea linked back to the card id",
          cid[:8] in BACKLOG.read_text())


def leg_wakeup():
    BRIEF_TPL.write_text(
        "# researcher {{session}}\n\n- скоуп {{scope}}\n"
        "- свежий дайджест: {{digest}}\n- отчёт: {{reportPath}}\n",
        encoding="utf-8")
    STUB.write_text(STUB_SRC)
    put("roles.json", {"version": 1, "roles": [{
        "id": "researcher", "label": "Researcher (stub)",
        "cli": sys.executable, "args": [str(STUB)],
        "promptFile": str(ROOT / ".acp" / "roles" / "researcher.md"),
        "timeoutMin": 5}], "stageRoles": {}})
    put("board.json", {"version": 2, "cards": [
        {"id": "rs-a", "title": "x", "project": "acp-ui", "stage": "backlog",
         "status": "", "createdAt": 1, "updatedAt": 1, "order": 1}]})
    env = dict(os.environ)
    env.update({
        "STATE_URL": STATE_URL,
        "PM_ROLE_ID": "researcher",
        "PM_KIND": "researcher",
        "PM_WAKEUP_DIR": str(WORK / "wakeup"),
        "PM_WAKEUP_DOC": "researcher-wakeup.json",
        "PM_SESSION_PREFIX": "reswake",
        "PM_REPORT_NAME": "research-report.md",
        "PM_BRIEF_FILE": str(BRIEF_TPL),
        "PM_DIGEST_PATH": str(WORK / "run1"),
        "PM_SCOPE": "acp-ui",
        "PM_QUIET_MIN": "0",
    })
    r = subprocess.run(["node", str(WAKEUP), "--force"],
                       capture_output=True, text=True, timeout=120,
                       cwd=ROOT, env=env)
    last = (r.stdout.strip().splitlines() or [""])[-1]
    check("wakeup: spawn exits 0", r.returncode == 0,
          f"rc={r.returncode} out={last[:120]} err={r.stderr[:120]}")
    doc, _ = get_doc("researcher-wakeup.json")
    sess = (doc or {}).get("lastSession") or ""
    check("wakeup: researcher session recorded",
          sess.startswith("reswake-"), sess)
    run_dir = WORK / "wakeup" / sess
    brief = (run_dir / "brief.md").read_text() if run_dir.exists() else ""
    check("wakeup: brief from template carries digest path",
          str(WORK / "run1") in brief and "acp-ui" in brief,
          brief[:120])
    check("wakeup: report file is research-report.md",
          (run_dir / "research-report.md").is_file())
    acts = ((get_doc("activity.json")[0] or {}).get("entries") or [])
    check("wakeup: ledger rows carry kind researcher / role researcher",
          any(e.get("kind") == "researcher" and e.get("role") == "researcher"
              for e in acts),
          json.dumps([e.get("kind") for e in acts][-5:]))


def main():
    global STATE_PORT, STATE_URL
    if WORK.exists():
        shutil.rmtree(WORK)
    write_fixtures()
    state, STATE_PORT = serve_state(STATE_PORT, WORK / "state-server")
    STATE_URL = f"http://127.0.0.1:{STATE_PORT}"
    try:
        check("state server up", wait_port(STATE_PORT, 10))
        leg_collect()
        leg_dedup()
        leg_failures_first()
        leg_idea()
        leg_wakeup()
    finally:
        stop(state)
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} assertions passed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
