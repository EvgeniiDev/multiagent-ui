#!/usr/bin/env python3
"""collect.py — researcher source collector.

One run = one harvest over a project's sources (per sources.<project>.json):

  1. Reddit — public Atom feeds ``/r/<sub>/new/.rss?limit=N``. Sequential,
     ``pause_sec`` between requests, exponential retry on 429, failures-first
     ordering across runs (see skill research/reddit-rss-digest — the ~1 req/min
     per-IP pool is shared by posts AND comments, so never run two collectors
     at once).
  2. Telegram — ``tg-read history <chat> --since <ts> --json`` per channel
     (the tool itself enforces the anti-flood gap; we honour FloodWait and
     never retry through it).
  3. Dedup against ``state.json`` (``seen`` ids), score by the config's
     interest axes, fetch comments for the top-K reddit posts:
     Apify actor batch when a token has budget, else the RSS
     ``/comments/<id>/.rss`` endpoint (same shared pool).
  4. Emit ``items.jsonl`` + ``digest.md`` under the run dir; update state.

No LLM here — this script only gathers and scores. The researcher role reads
the digest and decides what becomes an idea / a card.

Usage:
  collect.py --config scripts/research/sources.acp-ui.json
  collect.py --config ... --subs LocalLLaMA,mcp --comments off   # cheap probe
  collect.py --config ... --fixtures tmp-fixtures                # offline (e2e)
  collect.py --config ... --print-new-count                      # for wakeup.sh

Run with the tools venv (stdlib only, system python works too):
  ~/.hermes/tools-venv/bin/python scripts/research/collect.py --config ...
"""

import argparse
import datetime
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
UA = ("Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 "
      "Firefox/128.0")
APIFY_API = "https://api.apify.com/v2"
APIFY_ACTOR = "fatihtahta~reddit-scraper-search-fast"
ATOM = "{http://www.w3.org/2005/Atom}"
SEEN_CAP = 20000  # bound the seen-set so state.json stays small

# ---------------------------------------------------------------------------
# state
# ---------------------------------------------------------------------------


def load_state(path):
    if path.exists():
        try:
            return json.loads(path.read_text())
        except (OSError, ValueError):
            pass
    return {"version": 1, "seen": {}, "failed_subs": [], "dead_subs": [],
            "last_run": 0, "last_tg": {}}


def save_state(path, state):
    path.parent.mkdir(parents=True, exist_ok=True)
    seen = state.get("seen", {})
    if len(seen) > SEEN_CAP:  # oldest ids drop first
        keep = sorted(seen.items(), key=lambda kv: kv[1])[-SEEN_CAP:]
        state["seen"] = dict(keep)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=1))
    tmp.replace(path)


# ---------------------------------------------------------------------------
# throttled fetch — the RSS quota is ~1 success/min per IP, shared across
# posts and comments; sequential + pause + bounded backoff is the whole game.
# ---------------------------------------------------------------------------


class Fetcher:
    def __init__(self, pause=20.0, retries=5, base_delay=30.0,
                 max_delay=240.0, quiet=False):
        self.pause = pause
        self.retries = retries
        self.base_delay = base_delay
        self.max_delay = max_delay
        self.quiet = quiet
        self._last = 0.0

    def _log(self, msg):
        if not self.quiet:
            print(f"  [fetch] {msg}", file=sys.stderr)

    def fetch(self, url):
        """GET url -> (status, body_bytes). status 0 = gave up retrying."""
        if self._last:
            gap = time.time() - self._last
            if gap < self.pause:
                time.sleep(self.pause - gap)
        delay = self.base_delay
        for attempt in range(self.retries):
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            try:
                with urllib.request.urlopen(req, timeout=45) as r:
                    self._last = time.time()
                    return r.status, r.read()
            except urllib.error.HTTPError as e:
                self._last = time.time()
                if e.code == 429 and attempt + 1 < self.retries:
                    reset = e.headers.get("x-ratelimit-reset")
                    try:
                        wait = max(delay, float(reset or 0) + 2)
                    except ValueError:
                        wait = delay
                    wait = min(wait, self.max_delay)
                    self._log(f"429 on {url} — sleep {wait:.0f}s "
                              f"(try {attempt + 1}/{self.retries})")
                    time.sleep(wait)
                    delay = min(delay * 2, self.max_delay)
                    continue
                return e.code, b""
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                if attempt + 1 < self.retries:
                    self._log(f"{e} — sleep {delay:.0f}s")
                    time.sleep(delay)
                    delay = min(delay * 2, self.max_delay)
                    continue
                return 0, b""
        return 0, b""


# ---------------------------------------------------------------------------
# Atom parsing (posts feed + comments feed share the shape)
# ---------------------------------------------------------------------------


def _text(el):
    return (el.text or "").strip() if el is not None else ""


def parse_atom(body, source):
    """Atom feed -> [{id, title, url, ts, text}]. Post id falls back to the
    /comments/<id>/ slug inside the link when <id> is absent."""
    try:
        root = ET.fromstring(body)
    except ET.ParseError:
        return []
    out = []
    for ent in root.findall(f"{ATOM}entry"):
        link = ""
        for l in ent.findall(f"{ATOM}link"):
            if l.get("href"):
                link = l.get("href")
                break
        pid = _text(ent.find(f"{ATOM}id"))
        if not pid and link:
            m = re.search(r"/comments/([a-z0-9]+)/", link)
            pid = f"t3_{m.group(1)}" if m else link
        # content html is escaped; strip tags for the text field
        raw = _text(ent.find(f"{ATOM}content"))
        text = re.sub(r"<[^>]+>", " ", raw)
        text = re.sub(r"\s+", " ", text).strip()
        ts = _text(ent.find(f"{ATOM}updated")) or _text(ent.find(f"{ATOM}published"))
        author = ""
        a = ent.find(f"{ATOM}author/{ATOM}name")
        if a is not None:
            author = _text(a)
        out.append({"id": pid, "title": _text(ent.find(f"{ATOM}title")),
                    "url": link, "ts": _iso_to_epoch(ts), "text": text,
                    "author": author, "source": source})
    return out


def _iso_to_epoch(s):
    if not s:
        return 0
    try:
        dt = datetime.datetime.fromisoformat(s.replace("Z", "+00:00"))
        return int(dt.timestamp())
    except ValueError:
        return 0


def _epoch_to_iso(ts):
    return datetime.datetime.fromtimestamp(
        ts, datetime.timezone.utc).strftime("%Y-%m-%d %H:%M")


# ---------------------------------------------------------------------------
# sources
# ---------------------------------------------------------------------------


def fetch_reddit_posts(subs, state, fetcher, since, limit, fixtures):
    """/r/<sub>/new/.rss — failures-first order, dead subs skipped."""
    items, failed, dead = [], [], list(state.get("dead_subs") or [])
    failed_prev = [s for s in state.get("failed_subs") or [] if s in subs]
    ordered = failed_prev + [s for s in subs
                             if s not in failed_prev and s not in dead]
    for sub in ordered:
        if fixtures is not None:
            f = fixtures / "reddit" / f"{sub}.xml"
            if (fixtures / "reddit" / f"{sub}.xml.429").exists():
                status, body = 429, None      # marker file simulates a 429
            else:
                body = f.read_bytes() if f.exists() else None
                status = 200 if body else 404
        else:
            status, body = fetcher.fetch(
                f"https://www.reddit.com/r/{sub}/new/.rss?limit={limit}")
        if status != 200 or not body:
            if status in (403, 404):
                dead.append(sub)
                print(f"  r/{sub}: {status} — marked dead", file=sys.stderr)
            else:
                failed.append(sub)
                print(f"  r/{sub}: fetch failed ({status}) — "
                      "goes first next run", file=sys.stderr)
            continue
        posts = parse_atom(body, f"r/{sub}")
        fresh = [p for p in posts if not since or p["ts"] >= since]
        items.extend(fresh)
        print(f"  r/{sub}: {len(posts)} posts, {len(fresh)} fresh",
              file=sys.stderr)
    state["failed_subs"] = failed
    state["dead_subs"] = sorted(set(dead))
    return items


def fetch_telegram(channels, state, since, limit, fixtures, tg_read):
    """tg-read history <id> --since --json per channel."""
    items = []
    for ch in channels:
        cid, name = str(ch["id"]), ch.get("name") or str(ch["id"])
        ch_since = since
        last_id = (state.get("last_tg") or {}).get(cid)
        if fixtures is not None:
            f = fixtures / "tg" / f"{name}.json"
            msgs = json.loads(f.read_text()) if f.exists() else []
        else:
            cmd = [tg_read, "history", cid, "--limit", str(limit), "--json"]
            if ch_since:
                # tg-read accepts YYYY-MM-DD only; per-channel last_tg ids
                # give the precise dedup, the date is just a coarse floor.
                cmd += ["--since", _epoch_to_iso(ch_since).split()[0]]
            try:
                r = subprocess.run(cmd, capture_output=True, text=True,
                                   timeout=120)
            except (OSError, subprocess.TimeoutExpired) as e:
                print(f"  tg {name}: spawn failed ({e}) — skip",
                      file=sys.stderr)
                continue
            if r.returncode != 0:
                # FloodWait or transport — never hammer through it.
                print(f"  tg {name}: tg-read rc={r.returncode} "
                      f"{r.stderr.strip()[:160]} — skip", file=sys.stderr)
                continue
            try:
                msgs = json.loads(r.stdout or "[]")
            except ValueError:
                msgs = []
        max_id = last_id or 0
        fresh = []
        for m in msgs:
            mid = int(m.get("id") or 0)
            if last_id and mid <= last_id:
                continue
            max_id = max(max_id, mid)
            ts = 0
            d = str(m.get("date") or "")
            try:
                ts = int(datetime.datetime.strptime(
                    d, "%Y-%m-%d %H:%M:%S").replace(
                        tzinfo=datetime.timezone.utc).timestamp())
            except ValueError:
                pass
            if ch_since and ts and ts < ch_since:
                continue
            fresh.append({
                "id": f"tg:{cid}:{mid}",
                "title": (m.get("text") or "").splitlines()[0][:140]
                         if m.get("text") else "",
                "url": "", "ts": ts, "text": m.get("text") or "",
                "author": m.get("sender") or "", "source": f"tg:{name}",
                "views": m.get("views"),
            })
        state.setdefault("last_tg", {})[cid] = max_id
        items.extend(fresh)
        print(f"  tg {name}: {len(msgs)} msgs, {len(fresh)} fresh",
              file=sys.stderr)
    return items


# ---------------------------------------------------------------------------
# comments — Apify batch first (one actor run, urls[] + scrapeComments), then
# RSS /comments/<id>/.rss through the same shared pool as a fallback.
# ---------------------------------------------------------------------------


def _apify_tokens():
    env = {}
    envfile = Path.home() / ".hermes" / ".env"
    if envfile.exists():
        for line in envfile.read_text().splitlines():
            line = line.strip()
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    out, seen = [], set()
    for src in (os.environ.get("APIFY_TOKENS"), env.get("APIFY_TOKENS")):
        for t in (src or "").split(","):
            t = t.strip()
            if t and t not in seen:
                seen.add(t)
                out.append(t)
    for name in ["APIFY_TOKEN"] + [f"APIFY_TOKEN_{i}" for i in range(2, 9)]:
        t = os.environ.get(name) or env.get(name)
        if t and t not in seen:
            seen.add(t)
            out.append(t)
    return out


def _apify_alive(tok):
    """Cheap preflight: is this token under its monthly usage cap?"""
    try:
        req = urllib.request.Request(
            f"{APIFY_API}/users/me/limits?token={tok}")
        with urllib.request.urlopen(req, timeout=20) as r:
            d = json.load(r)["data"]
        lim = d.get("limits", {}).get("maxMonthlyUsageUsd")
        cur = d.get("current", {}).get("monthlyUsageUsd")
        return lim is not None and cur is not None and cur < lim
    except Exception:
        return False


def fetch_comments_apify(urls, max_comments, quiet=False):
    """One actor run for many post urls -> {post_url: [comments]}.

    Rotates tokens on quota errors (402/403 platform-feature-disabled/429).
    Returns None when no token is usable — caller falls back to RSS.
    """
    tokens = _apify_tokens()
    for idx, tok in enumerate(tokens):
        if not _apify_alive(tok):
            if not quiet:
                print(f"  [apify] token #{idx + 1} over budget — skip",
                      file=sys.stderr)
            continue
        payload = {"urls": urls, "scrapeComments": True,
                   "maxComments": max_comments}
        req = urllib.request.Request(
            f"{APIFY_API}/acts/{APIFY_ACTOR}/runs?token={tok}&timeout=300",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                run = json.load(r).get("data", {})
        except urllib.error.HTTPError as e:
            body = b""
            try:
                body = e.read()
            except Exception:
                pass
            if e.code in (402, 429) or (
                    e.code == 403 and b"platform-feature-disabled" in body):
                continue  # quota-dead token
            return None  # real error — caller decides
        rid = run.get("id")
        if not rid:
            continue
        ds_id, dead = None, False
        for _ in range(60):
            with urllib.request.urlopen(
                    f"{APIFY_API}/actor-runs/{rid}?token={tok}",
                    timeout=30) as r:
                d = json.load(r)["data"]
            st = d.get("status")
            if st == "SUCCEEDED":
                ds_id = d.get("defaultDatasetId")
                break
            if st in ("FAILED", "ABORTED", "TIMED-OUT"):
                dead = True
                break
            time.sleep(5)
        if not ds_id:
            if dead and idx + 1 < len(tokens):
                continue
            return None
        lim = len(urls) * (1 + max_comments)
        with urllib.request.urlopen(
                f"{APIFY_API}/datasets/{ds_id}/items?token={tok}&limit={lim}",
                timeout=60) as r:
            items = json.load(r)
        # Group comment items under their post's url.
        out = {}
        post_url_by_id = {}
        for it in items:
            if (it.get("title") or "").strip():
                u = it.get("permalink") or it.get("url") or ""
                pid = str(it.get("id") or it.get("postId") or "")
                if u and pid:
                    post_url_by_id[pid] = u
                    out.setdefault(u, [])
        for it in items:
            if (it.get("title") or "").strip():
                continue
            pid = str(it.get("postId") or it.get("parentId") or "")
            u = post_url_by_id.get(pid)
            if u is None:
                continue
            body = (it.get("body") or it.get("selftext") or "").strip()
            if body:
                out.setdefault(u, []).append(
                    {"author": it.get("author") or "?",
                     "score": it.get("score"), "text": body})
        return out
    return None


def _comment_id(url):
    m = re.search(r"/comments/([a-z0-9]+)/", url or "")
    return m.group(1) if m else ""


def fetch_comments_rss(posts, max_comments, fetcher, fixtures):
    """/comments/<id>/.rss per post — every call costs one pool slot."""
    for p in posts:
        pid = _comment_id(p.get("url")) or p.get("id", "").removeprefix("t3_")
        if not pid:
            continue
        if fixtures is not None:
            f = fixtures / "comments" / f"{pid}.xml"
            body = f.read_bytes() if f.exists() else None
            status = 200 if body else 404
        else:
            status, body = fetcher.fetch(
                f"https://www.reddit.com/comments/{pid}/.rss"
                f"?limit={max_comments}&depth=1&sort=top")
        if status != 200 or not body:
            print(f"  comments {pid}: {status}", file=sys.stderr)
            continue
        comms = parse_atom(body, f"comments:{pid}")
        p["comments"] = [{"author": c["author"], "score": None,
                          "text": c["text"]} for c in comms[:max_comments]]


# ---------------------------------------------------------------------------
# scoring — axes straight from the reddit-rss-digest skill, config-tunable
# ---------------------------------------------------------------------------


def score_items(items, interests, penalties):
    for it in items:
        hay = f"{it.get('title', '')}\n{it.get('text', '')[:400]}".lower()
        score, hits = 0.0, []
        for axis, spec in (interests or {}).items():
            w = spec.get("weight", 1.0)
            for pat in spec.get("patterns", []):
                if re.search(pat, hay, re.IGNORECASE):
                    score += w
                    hits.append(axis)
                    break
        for pat in (penalties or {}).get("patterns", []):
            if re.search(pat, hay, re.IGNORECASE):
                score += penalties.get("weight", -1.5)
                hits.append("PENALTY")
                break
        nc = it.get("num_comments")
        if isinstance(nc, int) and nc >= 20:
            score += 0.5  # busy discussion nudge
        it["score"] = round(score, 2)
        it["axes"] = sorted(set(hits))
    items.sort(key=lambda x: (-x["score"], -x.get("ts") or 0))
    return items


# ---------------------------------------------------------------------------
# digest
# ---------------------------------------------------------------------------


def write_digest(items, path, max_items):
    lines = ["# Research digest", "",
             f"новых элементов: {len(items)} · верхние {max_items} по скору",
             ""]
    for it in items[:max_items]:
        head = f"- **{it['title'] or '(без заголовка)'}** · {it['source']}"
        head += f" · score {it['score']}"
        if it.get("axes"):
            head += f" [{','.join(it['axes'])}]"
        if it.get("ts"):
            head += f" · {_epoch_to_iso(it['ts'])}"
        if it.get("url"):
            head += f"\n  {it['url']}"
        lines.append(head)
        if it.get("text"):
            lines.append(f"  > {it['text'][:300]}")
        for c in (it.get("comments") or [])[:5]:
            who = re.sub(r"^/?u/", "", c.get("author") or "?")
            lines.append(f"  💬 u/{who}: {(c.get('text') or '')[:240]}")
        lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--config", required=True)
    ap.add_argument("--out", default=None,
                    help="run dir (default .acp/research/runs/<ts>)")
    ap.add_argument("--state", default=None,
                    help="state file (default .acp/research/state.json)")
    ap.add_argument("--since", default=None,
                    help="ISO ts; default = hours_lookback from config")
    ap.add_argument("--subs", default=None, help="only these subreddits")
    ap.add_argument("--comments", default=None,
                    choices=["auto", "apify", "rss", "off"])
    ap.add_argument("--max-comments", type=int, default=None)
    ap.add_argument("--top-comments", type=int, default=None,
                    help="how many top posts get comments")
    ap.add_argument("--pause", type=float, default=None)
    ap.add_argument("--fixtures", default=None,
                    help="offline dir: reddit/<sub>.xml, comments/<id>.xml, "
                         "tg/<name>.json")
    ap.add_argument("--print-new-count", action="store_true")
    ap.add_argument("--dry-run", action="store_true",
                    help="collect + score but write nothing (no state)")
    ap.add_argument("--tg-read", default="tg-read")
    args = ap.parse_args()

    cfg = json.loads(Path(args.config).read_text())
    limits = cfg.get("limits", {})
    hours = limits.get("hours_lookback", 30)
    since = (int(datetime.datetime.fromisoformat(
        args.since).timestamp()) if args.since
        else int(time.time()) - hours * 3600)
    state_path = Path(args.state) if args.state else \
        ROOT / ".acp" / "research" / "state.json"
    run_dir = Path(args.out) if args.out else \
        ROOT / ".acp" / "research" / "runs" / \
        datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    state = load_state(state_path)
    fixtures = Path(args.fixtures) if args.fixtures else None
    pause = args.pause if args.pause is not None else (
        0.0 if fixtures else limits.get("pause_sec", 20))
    fetcher = Fetcher(pause=pause,
                      retries=1 if fixtures else limits.get("retries", 5),
                      base_delay=limits.get("retry_base", 30),
                      max_delay=limits.get("retry_cap", 240))

    subs = [s["name"] if isinstance(s, dict) else s
            for s in cfg.get("subreddits", [])]
    if args.subs:  # explicit list replaces the config's
        subs = [s.strip() for s in args.subs.split(",") if s.strip()]

    print(f"collect: {len(subs)} subs, "
          f"{len(cfg.get('telegram', []))} tg channels, since "
          f"{_epoch_to_iso(since)} UTC", file=sys.stderr)

    posts = fetch_reddit_posts(subs, state, fetcher, since,
                               limits.get("rss_limit", 50), fixtures)
    tgs = fetch_telegram(cfg.get("telegram", []), state, since,
                         limits.get("tg_limit", 50), fixtures, args.tg_read)
    items = posts + tgs

    # dedup against the seen-set (and within the batch)
    seen = state.setdefault("seen", {})
    fresh, dup = [], 0
    for it in items:
        if not it["id"] or it["id"] in seen:
            dup += 1
            continue
        seen[it["id"]] = int(time.time())
        it["kind"] = "tg" if it["id"].startswith("tg:") else "reddit"
        fresh.append(it)
    print(f"collect: {len(items)} fetched, {len(fresh)} new, {dup} dup",
          file=sys.stderr)

    score_items(fresh, cfg.get("interests", {}), cfg.get("penalties", {}))

    # comments on the top-K reddit posts — the idea often lives in the thread
    comments_mode = args.comments or limits.get("comments", "auto")
    top_k = args.top_comments if args.top_comments is not None else \
        limits.get("top_comments", 6)
    want = [p for p in fresh
            if p.get("kind") == "reddit" and p["score"] > 0][:top_k]
    if comments_mode != "off" and want:
        urls = [p["url"] for p in want if p.get("url")]
        got = None
        if comments_mode in ("auto", "apify") and fixtures is None and urls:
            print(f"comments: trying apify batch on {len(urls)} posts",
                  file=sys.stderr)
            got = fetch_comments_apify(
                urls, args.max_comments or limits.get("max_comments", 15))
        if got:
            for p in want:
                p["comments"] = got.get(p["url"]) or []
            print(f"comments: apify ok ({sum(len(v) for v in got.values())} "
                  "comments)", file=sys.stderr)
        elif comments_mode in ("auto", "rss"):
            # fetch_comments_rss reads fixture files when fixtures is set
            print(f"comments: rss fallback on {len(want)} posts",
                  file=sys.stderr)
            fetch_comments_rss(want, args.max_comments
                               or limits.get("max_comments", 15),
                               fetcher, fixtures)

    if not args.dry_run:
        run_dir.mkdir(parents=True, exist_ok=True)
        (run_dir / "items.jsonl").write_text(
            "".join(json.dumps(it, ensure_ascii=False) + "\n"
                    for it in fresh), encoding="utf-8")
        write_digest(fresh, run_dir / "digest.md",
                     limits.get("digest_items", 30))
        state["last_run"] = int(time.time())
        save_state(state_path, state)
        print(f"collect: run dir {run_dir}", file=sys.stderr)

    if args.print_new_count:
        print(len(fresh))
    else:
        top = [f"{i['score']:>5} [{i['source']}] {i['title'][:90]}"
               for i in fresh[:15]]
        print("\n".join(top) if top else "(nothing new)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
