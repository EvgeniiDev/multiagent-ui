#!/usr/bin/env python3
"""idea.py — deterministic writer for IDEA_BACKLOG.md and pilot cards.

The researcher role reasons over the digest; this tool owns the boring,
format-sensitive part so two runs can't corrupt the file or disagree on
numbering:

  idea.py add --title "..." --context "..." [--notes "..."] [--status NEW]
      appends "## Идея #N" (N = max existing + 1) to the backlog and prints
      the new number.

  idea.py card --num N --project acp-ui [--title "..."] [--stage backlog]
      reads idea N from the backlog, creates a boardctl card (title +
      context + sources go into --description, sources list appended as
      Источники:), prints the card id, and notes the id back on the idea's
      Заметки line as "→ card <id>".

Backlog path: $IDEA_BACKLOG or ~/.hermes/IDEA_BACKLOG.md.
Board: $BOARD_URL (boardctl's own default is the live :25900).
"""

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

BACKLOG = Path(os.environ.get(
    "IDEA_BACKLOG", str(Path.home() / ".hermes" / "IDEA_BACKLOG.md")))


def next_num(text):
    nums = [int(m) for m in re.findall(r"^## Идея #(\d+)", text, re.M)]
    return (max(nums) + 1) if nums else 1


def cmd_add(a):
    text = BACKLOG.read_text(encoding="utf-8") if BACKLOG.exists() else ""
    n = next_num(text)
    block = (
        f"\n---\n\n## Идея #{n}\n"
        f"- **Тема:** {a.title}\n"
        f"- **Контекст:** {a.context or ''}\n"
        f"- **Статус:** {a.status}\n"
        f"- **Заметки по ресёрчу:** {a.notes or ''}\n"
    )
    if a.source:
        src = "\n".join(f"  - {s}" for s in a.source)
        block += f"- **Источники:**\n{src}\n"
    with BACKLOG.open("a", encoding="utf-8") as f:
        f.write(block)
    print(n)
    return 0


def read_idea(text, num):
    m = re.search(rf"^## Идея #{num}\n(.*?)(?=^## Идея #|\Z)",
                  text, re.M | re.S)
    if not m:
        return None
    body = m.group(1)
    def field(name):
        f = re.search(rf"^- \*\*{name}:\*\*\s*(.+?)$", body, re.M)
        return f.group(1).strip() if f else ""
    srcs = re.findall(r"^  - (\S+.*?)$",
                      body.split("**Источники:**")[-1] if "**Источники:**"
                      in body else "", re.M)
    return {"title": field("Тема"), "context": field("Контекст"),
            "status": field("Статус"), "notes": field("Заметки по ресёрчу"),
            "sources": srcs, "body": body}


def cmd_card(a):
    text = BACKLOG.read_text(encoding="utf-8")
    idea = read_idea(text, a.num)
    if not idea:
        print(f"idea #{a.num} not found in {BACKLOG}", file=sys.stderr)
        return 2
    title = a.title or idea["title"][:120]
    desc = idea["context"]
    if idea["sources"]:
        desc += "\n\nИсточники:\n" + "\n".join(
            f"- {s}" for s in idea["sources"][:8])
    cmd = [a.boardctl, "add", "--title", title, "--project", a.project,
           "--stage", a.stage, "--description", desc,
           "--json"]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print(f"boardctl add failed: {r.stderr.strip()[:200]}",
              file=sys.stderr)
        return r.returncode
    try:
        card = json.loads(r.stdout)
        cid = card.get("id") or card.get("card", {}).get("id") or ""
    except ValueError:
        m = re.search(r"\b([0-9a-f]{8})\b", r.stdout)
        cid = m.group(1) if m else ""
    if cid:
        # mark the idea with the created card id (idempotent marker line)
        new = text.replace(f"## Идея #{a.num}\n{idea['body']}",
                           f"## Идея #{a.num}\n{idea['body']}"
                           f"- **Карточка:** {cid[:8]}\n", 1)
        BACKLOG.write_text(new, encoding="utf-8")
    print(cid)
    return 0


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("add")
    p.add_argument("--title", required=True)
    p.add_argument("--context", default="")
    p.add_argument("--notes", default="")
    p.add_argument("--status", default="NEW")
    p.add_argument("--source", action="append", default=[])
    p.set_defaults(fn=cmd_add)
    p = sub.add_parser("card")
    p.add_argument("--num", type=int, required=True)
    p.add_argument("--project", required=True)
    p.add_argument("--title", default=None)
    p.add_argument("--stage", default="backlog")
    p.add_argument("--boardctl", default=os.environ.get(
        "BOARDCTL", "boardctl"))
    p.set_defaults(fn=cmd_card)
    a = ap.parse_args()
    return a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
