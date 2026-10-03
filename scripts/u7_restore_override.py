#!/usr/bin/env python3
"""Generate the U7 restore compose file from captured `docker inspect` data.

The live containers drift from main's compose.yaml (image ids, mounts, uid),
so restoring via the bare file would change foreign services. This emits a
STANDALONE compose file describing the *actual* pretest spec of the
transitioned services, pinned by image sha256 — restoration stays
Compose-driven, never `docker run` or manual server starts.

  python3 scripts/u7_restore_override.py \
      [--inspect-dir ~/.cache/acp-u7-devin] \
      [--out ~/.cache/acp-u7-devin/restore-acp-ui.yaml]

Restore direction (exact services only, no deps, no orphans, no down):
  docker compose -p acp-ui -f <out> up -d --no-deps state runner web bridge-hermes
  docker compose -p acp-ui start cron   # exact original container

Fail-closed: a capture with non-bind mounts, a non-host network, or an
unreadable/missing file aborts generation instead of silently dropping
config. Entrypoint is emitted verbatim (null = image default is preserved
by omission). Secrets-bearing env lands ONLY in the private 0600 output.

The check manifest stores sha256 digests of env/mount lists — the
post-restore verifier compares without printing secret values.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

SERVICES = ["state", "runner", "web", "bridge-hermes"]
# Captured for prior-status restoration only — never recreated by the
# generated file (cron is stop/start-ed, keeping its original container).
MANIFEST_ONLY = ["cron"]


def q(s: str) -> str:
    """JSON double-quoted scalar — valid YAML flow scalar."""
    return json.dumps(s)


def digest(obj) -> str:
    return hashlib.sha256(
        json.dumps(obj, sort_keys=True).encode()).hexdigest()


def resolve_image_ref(image_id: str) -> tuple[str, bool]:
    """(compose-usable ref, imageAvailable) for a captured image ID.

    Prefers the pinned `acp-ui-u7-restore-<svc>:u7baseline` tag the driver
    creates at apply-time, else any real RepoTag/RepoDigest on that exact
    image, else the bare `sha256:<id>` — a valid local-ID reference while
    the image exists (state/web/bridge-hermes restored exactly that way).
    `pull_policy: never` is emitted so an ABSENT image fails closed with
    "image not available locally" instead of docker treating `sha256:` as
    a repo name and attempting a pull (`pull access denied for sha256` in
    window 67099d73 — root cause was the image being GC'd, not the ref
    form).
    """
    res = subprocess.run(["docker", "image", "inspect", image_id],
                         capture_output=True, text=True)
    if res.returncode != 0:
        return image_id, False
    img = json.loads(res.stdout)[0]
    refs = list(img.get("RepoTags") or []) + list(img.get("RepoDigests") or [])
    refs = [r for r in refs if "<none>" not in r]
    pinned = [r for r in refs if r.endswith(":u7baseline")]
    if pinned:
        return pinned[0], True
    if refs:
        return refs[0], True
    return image_id, True   # local ID still directly referenceable


def emit_service(name: str, d: dict) -> list[str]:
    cfg, host = d["Config"], d["HostConfig"]
    nets = host.get("NetworkMode")
    if nets != "host":
        raise SystemExit(
            f"FAIL  {name}: NetworkMode={nets!r} — generator only supports "
            "the host-network layout; refusing to emit a lossy spec")
    mounts = d.get("Mounts") or []
    for m in mounts:
        if m.get("Type") != "bind":
            raise SystemExit(
                f"FAIL  {name}: non-bind mount {m!r} — refusing to emit a "
                "lossy spec")
    image_id = d["Image"]
    ref, available = resolve_image_ref(image_id)
    out = [f"  {name}:"]
    out.append(f"    image: {q(ref)}   # captured {image_id}")
    out.append("    pull_policy: never")
    if cfg.get("User"):
        out.append(f"    user: {q(cfg['User'])}")
    out.append("    network_mode: host")
    wd = cfg.get("WorkingDir")
    if wd:
        out.append(f"    working_dir: {q(wd)}")
    ep = cfg.get("Entrypoint")
    if ep:
        out.append("    entrypoint:")
        out += [f"      - {q(c)}" for c in ep]
    cmd = cfg.get("Cmd")
    if cmd:
        out.append("    command:")
        out += [f"      - {q(c)}" for c in cmd]
    env = cfg.get("Env") or []
    if env:
        out.append("    environment:")
        out += [f"      - {q(e)}" for e in env]
    if mounts:
        out.append("    volumes:")
        for m in mounts:
            mode = m.get("Mode") or "rw"
            out.append(
                f"      - {q(m['Source'] + ':' + m['Destination'] + ':' + mode)}")
    rp = (host.get("RestartPolicy") or {})
    if rp.get("Name"):
        out.append("    restart: " + q(rp["Name"]))
        if rp.get("MaximumRetryCount"):
            out.append(
                f"    # restart MaxRetryCount={rp['MaximumRetryCount']} "
                "(informational — compose restart has no count field)")
    return out


def _write_private(path: Path, text: str) -> None:
    """0600 from the first syscall — contents may embed env values."""
    path.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--inspect-dir",
                    default=os.path.expanduser("~/.cache/acp-u7-devin"))
    ap.add_argument("--out", default=None)
    ap.add_argument("--check-out", default=None,
                    help="also write a digest manifest for verification")
    args = ap.parse_args(argv)
    src = Path(args.inspect_dir)
    out = Path(args.out or src / "restore-acp-ui.yaml")

    lines = [
        "# GENERATED by scripts/u7_restore_override.py — do not edit by hand.",
        "# Standalone actual-pretest spec of the U7-transitioned services.",
        "# Restore: docker compose -p acp-ui -f <this> up -d --no-deps \\",
        "#   state runner web bridge-hermes && docker compose -p acp-ui start cron",
        "# Verbatim container env may carry secrets: private file, 0600.",
        "services:",
    ]
    manifest = {}
    for svc in SERVICES + MANIFEST_ONLY:
        path = src / f"inspect-{svc}.json"
        try:
            data = json.loads(path.read_text())
        except OSError:
            print(f"missing capture: {path}", file=sys.stderr)
            return 1
        d = data[0]
        if svc in SERVICES:
            lines += emit_service(svc, d)
            lines.append("")
        cfg, host = d["Config"], d["HostConfig"]
        iref, iavail = resolve_image_ref(d["Image"])
        if svc in SERVICES and not iavail:
            print(f"WARN  {svc}: captured image {d['Image'][:19]} is NOT in "
                  "the local store — restore for this service cannot "
                  "succeed; do not mutate services", file=sys.stderr)
        manifest[svc] = {
            "image": d["Image"],
            "imageRef": iref,
            "imageAvailable": iavail,
            "user": cfg.get("User") or "",
            "command": cfg.get("Cmd"),
            "entrypoint": cfg.get("Entrypoint"),
            "workingDir": cfg.get("WorkingDir") or "",
            "networkMode": host.get("NetworkMode"),
            "restart": (host.get("RestartPolicy") or {}).get("Name"),
            "env_sha256": digest(sorted(cfg.get("Env") or [])),
            "mounts_sha256": digest(sorted(
                [m["Source"], m["Destination"], m.get("Mode") or "rw"]
                for m in (d.get("Mounts") or []))),
            "status": d["State"].get("Status"),
            "startedAt": d["State"].get("StartedAt"),
        }
    _write_private(out, "\n".join(lines) + "\n")
    print(f"wrote {out} (0600)")
    check = Path(args.check_out or src / "restore-acp-ui-check.json")
    _write_private(check, json.dumps(manifest, indent=2) + "\n")
    print(f"wrote {check}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
