#!/usr/bin/env python3
"""U7 runner recovery proposal — standalone compose spec for parent review.

The captured original runner image sha256:c4e9f89a… is gone from Docker and
containerd (image record absent from `ctr -n moby images ls`; config blob
absent from `content get`) — exact image restoration is impossible. This
emits a runner-only compose file that preserves EVERY captured container
field (uid root, host network, cmd, env, mounts, wd, entrypoint, restart)
with the single declared deviation:

    image: acp-ui-runner:latest   (sha256:4ec02cdbdb0e…, committed U1 build)

Review, then execute explicitly:
  docker compose -p acp-ui -f <out> up -d --no-deps runner

This script never starts/stops/recreates anything by itself.
"""

from __future__ import annotations

import copy
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import u7_restore_override as restore_gen  # noqa: E402

PRIV = Path(os.path.expanduser("~/.cache/acp-u7-devin"))
SUBSTITUTE_IMAGE = "acp-ui-runner:latest"


def main() -> int:
    src = PRIV / "inspect-runner.json"
    try:
        d = json.loads(src.read_text())[0]
    except (OSError, IndexError, json.JSONDecodeError) as e:
        print(f"cannot read runner capture: {e}", file=sys.stderr)
        return 1
    sub = subprocess_ref = SUBSTITUTE_IMAGE
    res = __import__("subprocess").run(
        ["docker", "image", "inspect", sub], capture_output=True, text=True)
    if res.returncode != 0:
        print(f"substitute image {sub} not in local store — aborting",
              file=sys.stderr)
        return 1
    sub_id = json.loads(res.stdout)[0]["Id"]

    dd = copy.deepcopy(d)
    dd["Image"] = sub                       # the ONLY deviation
    body = "\n".join(restore_gen.emit_service("runner", dd))
    # emit_service resolves refs from the real image id; rewrite the emitted
    # `image:` line to the declared substitute and keep the capture as comment.
    lines = []
    for ln in body.splitlines():
        if ln.lstrip().startswith("image:"):
            lines.append(f'    image: {restore_gen.q(sub)}   '
                         f"# DEVIATION: captured {d['Image']} unrecoverable")
        else:
            lines.append(ln)
    header = [
        "# U7 RUNNER RECOVERY PROPOSAL — review before executing.",
        f"# Captured image {d['Image']} is UNRECOVERABLE (image record and",
        "# content blobs absent from containerd moby store; untagged, GC'd).",
        f"# Substitute: {sub} = {sub_id} (already-committed image).",
        "# All other fields are verbatim from the captured actual spec:",
        "#   user(root), network_mode host, entrypoint, cmd, env, mounts,",
        "#   working_dir, restart unless-stopped.",
        "# Execute ONLY: docker compose -p acp-ui -f <this> up -d --no-deps runner",
        "services:",
    ]
    out = PRIV / "restore-runner-proposal.yaml"
    restore_gen._write_private(out, "\n".join(header + lines) + "\n")

    cfg = d["Config"]
    print(f"wrote {out} (0600)")
    print(f"deviation: image {d['Image'][:19]} -> {sub} ({sub_id[:19]})")
    print(f"identical: user={cfg.get('User')!r}(root) network=host "
          f"cmd={cfg.get('Cmd')} wd={cfg.get('WorkingDir')} "
          f"env={len(cfg.get('Env') or [])} mounts={len(d.get('Mounts') or [])} "
          f"restart={(d['HostConfig'].get('RestartPolicy') or {}).get('Name')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
