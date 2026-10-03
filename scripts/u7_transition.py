#!/usr/bin/env python3
"""U7 transition driver — the ONLY path the scoped test transition runs.

Modes:
  plan     read-only + private files: capture actual specs (refused while
           the test stack owns the ports — a capture then would record the
           TEST spec as "actual" and corrupt restore), generate the restore
           compose file + digest manifest, render both overlay configs with
           assertions, seed the on-disk test marker and the git sandbox.
  apply    preflight -> staged capture -> render-check -> marker/sandbox
           -> build -> RE-preflight -> pin images -> publish captures ->
           stop cron -> up -d --no-deps scoped services (OFF) -> verify
           isolation. --self-run-id is required; any failure or signal
           runs restore() first, then exits. Captures stay in a private
           per-window staging dir until the mutation boundary, so every
           refusal leaves the shared restore baseline byte-identical.
  on       stack compose.u7-on.yaml; recreate state+runner (managed ON).
  fusion   stack compose.u7-fusion.yaml on top of ON; recreate state+runner
           (managed ON + ACP_EXEC_FUSION=1 + runner F1 container runtime).
  preparation  stack compose.u7-preparation.yaml on top of ON; recreate
           state+runner (managed ON + ACP_EXEC_PREPARATION=1 + the
           runner-side lead supervisor driving real `pi --mode rpc`).
  off      recreate state+runner back to the OFF overlay.
  seed     HTTP-seed test fixtures — only after marker-verified isolation.
  restore  Compose-driven return to the captured actual spec; each scoped
           service returns to its captured prior status (all were running
           at capture); cron resumes via `start` (original container).
  verify   compare live inspect to the manifest privately — image/user/
           entrypoint/cmd/wd/network/restart + sha256 of SORTED env and
           mounts (ordering differences are not drift).

Guards (AGENTS.md): single acp-ui project, fixed ports, --no-deps only, no
--remove-orphans, no `down`, no bare node/python servers, no second stack.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import _e2e_compose_harness as H  # noqa: E402
import u7_restore_override as restore_gen  # noqa: E402

PRIV = Path(os.path.expanduser("~/.cache/acp-u7-devin"))
PROJECT = "acp-ui"
SCOPED = ["state", "runner", "web", "bridge-hermes"]
CRON = "cron"
TEST_STATE_DIR = Path("/home/hermes/.hermes/acp-ui-state-u7")
TEST_EXEC_DIR = TEST_STATE_DIR / "execution"
TEST_WS_DIR = Path("/home/hermes/projects/.acp-workspaces-u7")
TEST_OPS_DIR = Path("/home/hermes/.acp-ops-u7")
SANDBOX = Path("/home/hermes/projects/acp-u7-sandbox")
LIVE_STATE_DIR = "/home/hermes/.hermes/acp-ui-state"
TEST_IMAGE = "acp-ui-u7:latest"
PORCH = os.path.expanduser(
    "~/.pi/agent/skills/pragmatic-orchestration/scripts/porch")

FILES_OFF = [ROOT / "compose.yaml", ROOT / "compose.u7.yaml"]
FILES_ON = FILES_OFF + [ROOT / "compose.u7-on.yaml"]
FILES_FUSION = FILES_ON + [ROOT / "compose.u7-fusion.yaml"]
FILES_PREP = FILES_ON + [ROOT / "compose.u7-preparation.yaml"]
FILES_RESTORE = [PRIV / "restore-acp-ui.yaml"]


class StepError(RuntimeError):
    pass


def run(cmd: list[str], timeout=120.0, ok_codes=(0,), **kw) -> subprocess.CompletedProcess:
    res = subprocess.run(cmd, capture_output=True, text=True,
                         timeout=timeout, **kw)
    if res.returncode not in ok_codes:
        raise StepError(
            f"{' '.join(map(str, cmd))} -> exit {res.returncode}\n"
            f"{res.stdout[-2000:]}\n{res.stderr[-2000:]}")
    return res


def compose(files, *args, timeout=120.0):
    cmd = ["docker", "compose", "-p", PROJECT]
    for f in files:
        cmd += ["-f", str(f)]
    return run(cmd + list(args), timeout=timeout)


def compose_json(files, *args, timeout=120.0):
    return json.loads(compose(files, *args, timeout=timeout).stdout)


def write_private(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)


def _safe_name(raw: str) -> str:
    """Path-segment guard — window ids are hex nonces but the argv value
    is operator-supplied; never let it escape the private dir."""
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", raw)


def _new_stage_dir(window: str | None) -> Path:
    """Fresh private staging dir for one apply attempt (0700, files 0600
    via write_private). mkdtemp invents the name O_EXCL-fresh, so the
    returned dir is provably owned by THIS window's attempt — _cleanup_
    stage may remove it and nothing else."""
    PRIV.mkdir(parents=True, exist_ok=True)
    os.chmod(PRIV, 0o700)
    label = _safe_name(window) if window else "adhoc"
    return Path(tempfile.mkdtemp(prefix=f"stage-{label}-", dir=PRIV))


def _cleanup_stage(stage: Path) -> None:
    """Remove ONLY a staging dir this run created. Guards: inside PRIV,
    name still carries our stage- prefix, not a symlink — so a swapped
    path can never rmtree a foreign or shared location."""
    try:
        if stage.parent == PRIV and stage.name.startswith("stage-") \
                and stage.is_dir() and not stage.is_symlink():
            shutil.rmtree(stage)
    except OSError as e:
        print(f"WARN  could not remove own staging dir {stage}: {e}")


def _publish_stage(stage: Path) -> None:
    """Install the staged captures as the shared private baseline —
    called ONLY at the mutation boundary, after every pre-mutation
    refusal point has passed. Publication is all-or-nothing with
    respect to the prior baseline:

      1. every staged REQUIRED name must exist before anything moves;
      2. every pre-existing shared file is moved aside into a private
         rollback dir (same filesystem — a rename, never a copy), so a
         failure in this phase cannot have published a single staged
         byte yet;
      3. the staged files are installed one by one via os.replace
         (atomic per-file, keeps the staged 0600 mode).

    A mid-publish failure restores every prior file byte-for-byte and
    withdraws any already-installed file that did not previously exist,
    so a refused publish never leaves a half-new baseline behind. If
    the rollback itself cannot complete, each deviation is reported
    explicitly and the surviving prior copies are KEPT in the rollback
    dir — the last copy of the baseline is never deleted silently."""
    required = [f"inspect-{svc}.json" for svc in SCOPED + [CRON]]
    required += ["restore-acp-ui.yaml", "restore-acp-ui-check.json"]
    missing = [n for n in required if not (stage / n).exists()]
    if missing:
        raise StepError(f"staged baseline incomplete {missing} — refusing "
                        "to publish a partial capture")
    names = required + [n for n in ("render-off.json", "render-on.json",
                                    "render-fusion.json")
                        if (stage / n).exists()]
    try:
        backup = Path(tempfile.mkdtemp(prefix=f"rollback-{stage.name}-",
                                       dir=PRIV))
    except OSError as e:
        raise StepError(f"cannot create a rollback dir for publish: {e} "
                        "— refusing to publish unsafely") from e
    priors: list[str] = []         # shared files moved aside, in order
    installed_new: list[str] = []  # published names that had NO prior
    try:
        for name in names:
            dst = PRIV / name
            if os.path.lexists(dst):
                os.replace(dst, backup / name)
                priors.append(name)
        prior_set = set(priors)
        for name in names:
            os.replace(stage / name, PRIV / name)
            if name not in prior_set:
                installed_new.append(name)
    except OSError as e:
        problems = []
        for name in reversed(priors):
            try:
                os.replace(backup / name, PRIV / name)
            except OSError as e2:
                try:
                    shutil.copy2(backup / name, PRIV / name)
                except OSError as e3:
                    problems.append(f"prior {name} unrestored "
                                    f"({e2}; copy fallback: {e3})")
        for name in reversed(installed_new):
            try:
                os.remove(PRIV / name)
            except OSError as e2:
                problems.append(f"new file {name} not withdrawn ({e2})")
        if problems:
            tail = (f"; surviving prior copies kept under {backup} — "
                    "inspect before removing") \
                if backup.is_dir() and any(backup.iterdir()) else ""
            raise StepError(
                f"publish failed at {name!r}: {e} — rollback INCOMPLETE "
                f"({'; '.join(problems)}){tail}") from e
        shutil.rmtree(backup, ignore_errors=True)
        raise StepError(f"publish failed at {name!r}: {e} — prior shared "
                        "baseline restored intact") from e
    shutil.rmtree(backup, ignore_errors=True)


def inspect_svc(service: str) -> dict:
    return json.loads(
        run(["docker", "inspect", f"{PROJECT}-{service}-1"]).stdout)[0]


def on_test_stack() -> bool:
    """True when the state container already runs the test spec — baseline
    captures must then be preserved, never overwritten."""
    try:
        d = inspect_svc("state")
    except StepError:
        return False
    env = {e.split("=", 1)[0]: e.split("=", 1)[1]
           for e in d["Config"].get("Env") or []}
    return d["Config"].get("Image") == TEST_IMAGE \
        or env.get("STATE_DIR") == str(TEST_STATE_DIR)


def capture_all(priv: Path | None = None) -> dict:
    """Actual spec of scoped services + cron status, saved privately.

    Refuses while the test stack owns the ports: recapturing then would
    overwrite the pretest baseline with test specs and break restore.
    apply() passes a per-window staging dir; plan writes the shared
    baseline directly (that mode exists to regenerate it)."""
    priv = priv or PRIV
    if on_test_stack():
        raise StepError(
            "state container already runs the U7 spec — refusing to "
            "overwrite the pretest baseline captures")
    got = {}
    for svc in SCOPED + [CRON]:
        d = inspect_svc(svc)
        write_private(priv / f"inspect-{svc}.json", json.dumps([d]))
        got[svc] = d
    return got


def _image_present(image_id: str) -> bool:
    return subprocess.run(
        ["docker", "image", "inspect", image_id],
        capture_output=True).returncode == 0


def _image_id_of(ref: str) -> str | None:
    res = subprocess.run(
        ["docker", "image", "inspect", ref, "--format", "{{.Id}}"],
        capture_output=True, text=True)
    return res.stdout.strip() if res.returncode == 0 else None


def pin_restore_images(priv: Path | None = None) -> None:
    """Stable local refs for every captured image. Root cause of window
    67099d73 was image ABSENCE, not ref syntax: the untagged runner image
    was orphaned when its container was recreated and then GC'd; the bare
    `sha256:<id>` ref resolves fine while the image exists (state/web/
    bridge-hermes restored exactly that way) and only degenerates into a
    pull attempt for a repo literally named `sha256` once absent.

    Fail-closed: ANY pin error — tag failure, or a pinned tag that does not
    resolve back to the captured image id — aborts before mutation. An
    image that merely exists NOW does not prevent GC later; only a
    verified pinned tag holds the reference."""
    priv = priv or PRIV
    for svc in SCOPED + [CRON]:
        p = priv / f"inspect-{svc}.json"
        if not p.exists():
            raise StepError(f"missing capture for pin: {p}")
        d = json.loads(p.read_text())[0]
        tag = f"acp-ui-u7-restore-{svc}:u7baseline"
        res = subprocess.run(["docker", "tag", d["Image"], tag],
                             capture_output=True, text=True)
        if res.returncode != 0:
            raise StepError(
                f"cannot pin {svc} image {d['Image'][:19]}: "
                f"{res.stderr.strip() or 'image absent'} — refusing to "
                "mutate services on an unpinned restore image")
        got = _image_id_of(tag)
        if got != d["Image"]:
            raise StepError(
                f"pinned {tag} resolves to {got!r}, expected "
                f"{d['Image']!r} — refusing to mutate services on an "
                "unverified pin")


def missing_captured_images(priv: Path | None = None) -> list[str]:
    """Scoped+cron services whose captured image is absent from the store."""
    manifest = _manifest(priv)
    return [svc for svc in SCOPED + [CRON]
            if manifest.get(svc)
            and not _image_present(manifest[svc]["image"])]


def seed_marker() -> str:
    """Write the marker doc ON DISK into the test STATE_DIR (never HTTP)."""
    TEST_STATE_DIR.mkdir(parents=True, exist_ok=True)
    f = TEST_STATE_DIR / f"{H.MARKER_DOC}.json"
    if f.exists():
        try:
            return json.loads(f.read_text())["data"]["nonce"]
        except Exception:
            pass
    nonce = secrets.token_hex(16)
    doc = {
        "name": H.MARKER_DOC,
        "rev": 1,
        "updatedAt": int(time.time() * 1000),
        "data": {"stateDir": "acp-ui-state-u7", "nonce": nonce,
                 "purpose": "u7 isolation marker — seeded on disk pre-transition"},
    }
    fd = os.open(f, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
    with os.fdopen(fd, "w") as fh:
        fh.write(json.dumps(doc))
    print(f"marker seeded on disk: {f} nonce={nonce[:8]}…")
    return nonce


def seed_scheduler_limits() -> None:
    """Operator-editable scheduler limits for the test fleet (host FS only).

    A retained-unproven attempt holds its role slot FOREVER by design —
    record-once honesty never releases a reservation on hope (observed:
    codex run_6497b779 att-1 stranded 'running' by the pre-fix childPid
    race; every later implementer begin_attempt was refused
    limit_reached(scope=role, cap 1)). Seeding implementer:4 gives the
    fleet headroom next to a few retained reservations (a foreign-env
    'cancelling'/'running' attempt is untouchable by design and never
    releases) without touching any proof gate — stranded attempts stay
    durably unproven. Absent-file defaults (global 2, roles 1) are
    unchanged for prod-like flow tests."""
    p = TEST_EXEC_DIR / "state" / "scheduler.json"
    if p.exists():
        return
    p.parent.mkdir(parents=True, exist_ok=True)
    doc = {"version": 1,
           "limits": {"global": 4,
                      "roles": {"implementer": 4, "reviewer": 1,
                                "checker": 1}}}
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(json.dumps(doc))
    print(f"scheduler limits seeded: {p} (implementer=4 headroom for "
          f"retained reservations)")


def sweep_orphan_runs() -> None:
    """Stop every live run left by an earlier window via the real
    user-channel `stop` command. At transition time every live run is an
    orphan by definition — the window that owned it already exited.
    `stop` is never launch-gated: a queued run (no live attempt) takes
    the durable stop intent and finalizes terminal on the next scheduler
    tick; a run whose live attempts are owned by a foreign env keeps
    their retained reservations untouched — the intent still blocks any
    further scheduling of that run. Nothing is terminalized by hand and
    no proof semantics are touched; the sweep only prevents orphaned
    queued runs from racing the suite's run for an attempt slot."""
    cards_dir = TEST_EXEC_DIR / "state" / "cards"
    if not cards_dir.is_dir():
        return
    live_run = {"queued", "active", "stopping", "awaiting_acceptance"}
    live_att = {"launching", "running", "cancelling"}

    def post_stop(cid: str, rev) -> tuple[int, str]:
        body = {"commandId": f"u7-sweep-{secrets.token_hex(8)}",
                "type": "stop",
                "payload": {"by": "u7-transition",
                            "reason": "orphan sweep at window start"},
                "expectedControlRevision": rev}
        req = urllib.request.Request(
            f"{H.STATE_URL}/api/execution/cards/{cid}/commands",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, ""
        except urllib.error.HTTPError as e:
            code = ""
            try:
                code = (json.loads(e.read()) or {}).get("code") or ""
            except Exception:
                pass
            return e.code, code
        except Exception as e:
            return 0, str(e)

    swept = 0
    for f in sorted(cards_dir.glob("*.json")):
        try:
            agg = json.loads(f.read_text())
        except Exception:
            continue
        runs = [r for r in (agg.get("runs") or []) if isinstance(r, dict)]
        if not any(r.get("status") in live_run
                   or any((a or {}).get("status") in live_att
                          for a in (r.get("attempts") or []))
                   for r in runs):
            continue
        cid = agg.get("cardId") or f.stem
        st, code = post_stop(cid, agg.get("controlRevision"))
        if code == "revision_conflict":
            try:  # one fresh read covers the list->post TOCTOU window
                agg = json.loads(f.read_text())
                st, code = post_stop(cid, agg.get("controlRevision"))
            except Exception as e:
                st, code = 0, str(e)
        if st == 200:
            swept += 1
            print(f"  sweep: stop issued on {cid}")
        elif code not in ("run_terminal", "nothing_to_stop"):
            # raced-to-terminal is already clean; anything else keeps the
            # reservation intact and is reported, never hidden
            print(f"  sweep: {cid} stop returned {st} {code} "
                  "(reservations intact — kept honest)")
    print(f"orphan sweep: {swept} card(s) issued stop")


def seed_cli_compat() -> None:
    """Widen the pi model table inside the TEST exec store (host FS only).

    The seed compat table lists one pi model — a fusion panel needs at
    least two distinct model identities. The operator override file is
    exactly the sanctioned extension point (merged per-CLI with the
    seed); writing it under the test STATE_DIR's execution store keeps
    the live deployment's table untouched. Every entry is a model the
    registered zen-relay provider actually serves — plus nothing else."""
    p = TEST_EXEC_DIR / "state" / "cli-compat.json"
    doc = {"pi": {"models": [
        "zen-relay/muse-spark-1.3-contributor-free",
        "zen-relay/muse-spark-1.2-contributor-free",
    ], "effort": None, "params": []}}
    cur = None
    try:
        cur = json.loads(p.read_text()) if p.exists() else None
    except Exception:
        cur = None
    if cur == doc:
        return
    p.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(json.dumps(doc, indent=2))
    print(f"cli-compat seeded: {p} (2 zen-relay models for the panel)")


def seed_sandbox() -> None:
    """Isolated git projects for workspace/role tests — host FS only."""
    for name in ("proj-a", "proj-b"):
        d = SANDBOX / name
        if (d / ".git").exists():
            continue
        d.mkdir(parents=True)
        run(["git", "-C", str(d), "init", "-q"])
        (d / "README.md").write_text(f"# u7 sandbox {name}\n")
        (d / "main.py").write_text("VALUE = 1\n")
        run(["git", "-C", str(d), "add", "-A"])
        run(["git", "-C", str(d), "-c", "user.email=u7@test.invalid",
             "-c", "user.name=u7", "commit", "-qm", "init"])
    # Fusion workers resolve fusion.projectRoot as a single-segment name
    # directly under the registered projects root (assertSafeId + realpath
    # containment in env-controller) — nested sandbox paths are rejected
    # with project_not_registered. Expose each repo as a top-level symlink
    # so the default basename resolution (projectKeyFor) lands; the link
    # realpaths inside the root, so containment still holds. A pre-existing
    # real entry with the same name is a hard stop, never shadowed.
    for name in ("proj-a", "proj-b"):
        link = SANDBOX.parent / name
        rel = f"{SANDBOX.name}/{name}"
        if link.is_symlink() and os.readlink(link) == rel:
            continue
        if os.path.lexists(link):
            raise SystemExit(
                f"{link} exists and is not the u7 sandbox alias — refusing")
        link.symlink_to(rel)
    print(f"sandbox repos ready under {SANDBOX} "
          f"(top-level aliases proj-a/proj-b -> {SANDBOX.name}/*)")


def render_check(priv: Path | None = None) -> list[str]:
    """`docker compose config` renders + asserts; returns findings list."""
    priv = priv or PRIV
    notes = []
    off = compose_json(FILES_OFF, "config", "--format", "json")
    on = compose_json(FILES_ON, "config", "--format", "json")
    write_private(priv / "render-off.json", json.dumps(off, indent=2))
    write_private(priv / "render-on.json", json.dumps(on, indent=2))

    def svc(cfg, name):
        return cfg["services"][name]

    st, rn, web, bh = (svc(off, s) for s in SCOPED)
    ops = [v for v in st.get("volumes", []) if v.get("target") == "/run/acp-ops"]
    assert len(ops) == 1 and ops[0]["source"] == str(TEST_OPS_DIR), \
        f"state /run/acp-ops resolves {ops!r} — must be solely {TEST_OPS_DIR}"
    assert not any(v.get("target") == "/run/acp-ops"
                   for v in rn.get("volumes", [])), \
        "runner must NOT see the ops dir"
    assert not any(v.get("target") == "/run/acp-ops"
                   for v in bh.get("volumes", [])), \
        "bridge-hermes must NOT see the ops dir"
    notes.append("ops mount: state-only ro, source .acp-ops-u7, runner/bridge absent")
    env_st = st.get("environment", {})
    env_rn = rn.get("environment", {})
    assert env_st.get("STATE_DIR") == str(TEST_STATE_DIR), env_st.get("STATE_DIR")
    assert env_st.get("ACP_WORKSPACE_DIR") == str(TEST_WS_DIR)
    assert env_rn.get("ACP_WORKSPACE_DIR") == str(TEST_WS_DIR)
    assert env_rn.get("ACP_EXEC_DIR") == str(TEST_EXEC_DIR)
    notes.append("isolated STATE_DIR/ACP_EXEC_DIR/ACP_WORKSPACE_DIR rendered")
    for env, who in ((env_st, "state"), (env_rn, "runner")):
        assert env.get("ACP_EXEC_START") == "0", (who, env.get("ACP_EXEC_START"))
        assert env.get("ACP_EXEC_VALIDATION") == "0", \
            (who, env.get("ACP_EXEC_VALIDATION"))
    st_on, rn_on = svc(on, "state"), svc(on, "runner")
    for env, who in ((st_on["environment"], "state"),
                     (rn_on["environment"], "runner")):
        assert env.get("ACP_EXEC_START") == "1", (who, env.get("ACP_EXEC_START"))
        assert env.get("ACP_EXEC_VALIDATION") == "1"
    notes.append("ACP_EXEC_START/VALIDATION render '0' OFF, '1' ON on both")
    fuz = compose_json(FILES_FUSION, "config", "--format", "json")
    write_private(priv / "render-fusion.json", json.dumps(fuz, indent=2))
    st_f, rn_f = svc(fuz, "state"), svc(fuz, "runner")
    for env, who in ((st_f["environment"], "state"),
                     (rn_f["environment"], "runner")):
        assert env.get("ACP_EXEC_FUSION") == "1", (who, env.get("ACP_EXEC_FUSION"))
        assert env.get("ACP_EXEC_START") == "1", (who, env.get("ACP_EXEC_START"))
        assert env.get("ACP_EXEC_VALIDATION") == "1"
    assert rn_f["environment"].get("ACP_F1_CONFIG") \
        == "/repo/deploy/execution/environment.config.json", \
        rn_f["environment"].get("ACP_F1_CONFIG")
    notes.append("FUSION render: ACP_EXEC_FUSION=1 both, runner pinned to "
                 "the repo F1 config (client view)")
    dv = [v for v in web.get("volumes", []) if v.get("target") == "/repo/dist-web"]
    assert dv and dv[0]["source"] == str(ROOT / "dist-web"), dv
    cmd = " ".join(bh.get("command", []))
    assert "acp-ws-bridge.mjs" in cmd and "u7_mock_acp.mjs" in cmd \
        and "--port" in cmd and "25901" in cmd, cmd
    assert bh.get("user") == "1001:1001"
    notes.append("web isolated dist-web; bridge-hermes uid1001 + mock ACP cmd")
    assert st.get("image") == TEST_IMAGE
    assert rn.get("image") == TEST_IMAGE
    assert any(v.get("target") ==
               "/home/hermes/.cache/pragmatic-orchestration/steer"
               and v.get("read_only")
               for v in st.get("volumes", [])), \
        "state must mount the external porch steer dir read-only"
    notes.append("state porch steer dir mounted ro; images pinned acp-ui-u7")
    for n in notes:
        print("  PASS", n)
    return notes


def proc_rows(service: str) -> list[str]:
    return H.proc_rows(service)


def preflight_idle(self_run_id: str | None) -> None:
    """Prove no live work would be disturbed. Read-only checks only."""
    print("preflight: live claims/doc on current state server")
    try:
        with urllib.request.urlopen(
                f"{H.STATE_URL}/api/state/claims.json", timeout=5) as r:
            doc = json.loads(r.read())
    except Exception as e:
        raise StepError(f"live claims read failed: {e}") from e
    data = doc.get("data") or {}
    if data.get("claims") or data.get("attempts"):
        raise StepError("live claims.json not empty — refusing transition")
    print("preflight: porch delegate list --active")
    res = run([PORCH, "delegate", "list", "--active", "--json"], timeout=30)
    try:
        active = json.loads(res.stdout)
    except json.JSONDecodeError as e:
        raise StepError(f"porch active list unreadable: {e}") from e
    others = [r for r in active if r.get("run_id") != self_run_id]
    if others:
        raise StepError(
            f"active porch runs besides self: "
            f"{[r.get('run_id') for r in others]}")
    # bridge-hermes: the bridge line itself contains "--cmd hermes acp" in
    # its CMD; a live agent child is any OTHER process row.
    bh = [ln for ln in proc_rows("bridge-hermes")
          if "acp-ws-bridge.mjs" not in ln]
    if bh:
        raise StepError(
            f"bridge-hermes has live children — refusing:\n{bh}")
    rn = proc_rows("runner")
    if len(rn) != 1 or "acp-runner.mjs" not in rn[0]:
        raise StepError(f"runner has live children/jobs:\n{rn}")
    print("preflight: claims empty, only self porch run, "
          "bridge-hermes childless, runner idle")


def build_image() -> None:
    print(f"building {TEST_IMAGE} from isolated Dockerfile.node …")
    run(["docker", "build", "-f", str(ROOT / "Dockerfile.node"),
         "-t", TEST_IMAGE, str(ROOT)], timeout=1800)


def up(files, *services) -> None:
    compose(files, "up", "-d", "--no-deps", *services, timeout=600)


def provision_test_ops() -> None:
    """Test-only ops dir+token — never the production ~/.acp-ops."""
    TEST_OPS_DIR.mkdir(parents=True, exist_ok=True)
    os.chmod(TEST_OPS_DIR, 0o700)
    tok = TEST_OPS_DIR / "ops-token"
    if not tok.exists():
        res = run(["openssl", "rand", "-hex", "24"])
        fd = os.open(tok, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(res.stdout.strip() + "\n")
    (TEST_OPS_DIR / "env-receipts").mkdir(exist_ok=True)
    print("test ops dir ready (token 0600, dir 0700) — value never printed")


def _manifest(priv: Path | None = None) -> dict:
    ck = (priv or PRIV) / "restore-acp-ui-check.json"
    return json.loads(ck.read_text()) if ck.exists() else {}


def diff_against_manifest() -> list:
    """Private full-manifest comparison — returns (service, field) drift."""
    manifest = _manifest()
    bad = []
    for svc in SCOPED + [CRON]:
        exp = manifest.get(svc)
        if not exp:
            continue
        try:
            d = inspect_svc(svc)
        except StepError:
            bad.append((svc, "container-missing"))
            continue
        cfg, host = d["Config"], d["HostConfig"]
        cur_env = restore_gen.digest(sorted(cfg.get("Env") or []))
        cur_m = restore_gen.digest(sorted(
            [m["Source"], m["Destination"], m.get("Mode") or "rw"]
            for m in (d.get("Mounts") or [])))
        cur = {
            "image": d["Image"],
            "user": cfg.get("User") or "",
            "command": cfg.get("Cmd"),
            "entrypoint": cfg.get("Entrypoint"),
            "workingDir": cfg.get("WorkingDir") or "",
            "networkMode": host.get("NetworkMode"),
            "restart": (host.get("RestartPolicy") or {}).get("Name"),
            "env_sha256": cur_env,
            "mounts_sha256": cur_m,
        }
        for k, v in cur.items():
            if exp.get(k) != v:
                bad.append((svc, k))
        if exp.get("status") == "running" \
                and d["State"].get("Status") != "running":
            bad.append((svc, "status"))
    return bad


def _restore_impl() -> int:
    rf = PRIV / "restore-acp-ui.yaml"
    if not rf.exists():
        print("restore: no generated file — regenerating from last capture")
        if restore_gen.main([]) != 0:
            print("FAIL  cannot regenerate restore file")
            return 1
    manifest = _manifest()
    # Never recreate a service whose captured image is gone — the emitted
    # ref resolves only against the local store (pull_policy: never), so an
    # absent image simply cannot be brought back. Restore the available
    # ones exactly; STOP the unrecreatable test containers so the test spec
    # cannot act on live state, and report the deviation.
    missing = [s for s in SCOPED
               if manifest.get(s)
               and not _image_present(manifest[s]["image"])]
    avail = [s for s in SCOPED if s not in missing]
    for svc in missing:
        print(f"restore: {svc} captured image "
              f"{manifest[svc]['image'][:19]} unavailable — stopping its "
              "container instead of substituting another image")
        try:
            compose(FILES_RESTORE, "stop", svc)
        except StepError:
            pass
    if avail:
        print(f"restore: up -d --no-deps {avail} on captured actual spec")
        run(["docker", "compose", "-p", PROJECT, "-f", str(rf),
             "up", "-d", "--no-deps", *avail], timeout=600)
    for svc in avail:  # captured-not-running services must stay down
        if manifest.get(svc, {}).get("status") != "running":
            compose(FILES_RESTORE, "stop", svc)
    if manifest.get(CRON, {}).get("status") == "running":
        print("restore: start cron (original container)")
        compose(FILES_OFF, "start", CRON)
    time.sleep(1.5)
    bad = diff_against_manifest()
    try:
        with urllib.request.urlopen(f"{H.STATE_URL}/health", timeout=5) as r:
            hdir = json.loads(r.read()).get("dir")
        if hdir != LIVE_STATE_DIR:
            bad.append(("state-health-dir", hdir))
    except Exception as e:
        bad.append(("state-health", str(e)))
    if bad:
        print("FAIL  restore verification:", bad)
        return 1
    print("restore: scoped services back on captured actual spec, "
          "state dir = live")
    return 0


def restore() -> int:
    try:
        return _restore_impl()
    except StepError as e:
        print(f"FAIL  restore raised: {e}")
        return 1


def _on_signal(signum, _frame):
    if _transition_began:
        print(f"\nsignal {signum} during transition — restoring first")
        _restore_impl()
    sys.exit(128 + signum)


_transition_began = False


def main() -> int:
    global _transition_began
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["plan", "apply", "on", "fusion",
                                     "preparation", "off",
                                     "seed", "restore", "verify"])
    ap.add_argument("--self-run-id", default=None,
                    help="porch run id of this very session (active filter)")
    ap.add_argument("--window", default=None,
                    help="u7_run window nonce — recorded BEFORE the first "
                         "scoped mutation so the orchestrator restores only "
                         "windows that actually touched the stack")
    args = ap.parse_args()
    signal.signal(signal.SIGINT, _on_signal)
    signal.signal(signal.SIGTERM, _on_signal)

    if args.mode == "plan":
        if on_test_stack():
            print("already on test stack — baseline captures preserved, "
                  "skipping capture")
        else:
            capture_all()
            print(f"captured actual specs → {PRIV}/inspect-*.json")
        if restore_gen.main([]) != 0:
            return 1
        render_check()
        seed_marker()
        seed_sandbox()
        seed_cli_compat()
        print("\nplan complete — review render-*.json and restore-acp-ui.yaml")
        return 0

    if args.mode == "restore":
        return restore()

    if args.mode == "verify":
        bad = diff_against_manifest()
        if bad:
            print("FAIL  drift vs captured actual:", bad)
            return 1
        print("verify: all scoped+cron specs match the captured actual spec")
        return 0

    if args.mode == "seed":
        H.verify_isolation()
        status, body = H.seed_doc("projects.json", {
            "version": 1,
            "projects": [
                {"id": "u7-proj-a", "name": "u7-a",
                 "path": str(SANDBOX / "proj-a"),
                 "createdAt": int(time.time() * 1000)},
                {"id": "u7-proj-b", "name": "u7-b",
                 "path": str(SANDBOX / "proj-b"),
                 "createdAt": int(time.time() * 1000)},
            ],
            "activeProjectId": "u7-proj-a",
        })
        print("projects.json:", status)
        now = int(time.time() * 1000)
        status2, body2 = H.seed_doc("board.json", {
            "version": 2,
            "cards": [{
                "id": "u7-card-solo", "title": "U7 managed smoke card",
                "description": "managed execution fixture",
                "agent": "", "priority": "normal", "acceptance": "",
                "verification": "", "links": [], "session": None,
                "blocked": False, "blockedReason": "", "cancelled": False,
                "touches": [], "dependsOn": [], "blocks": [],
                "conflictsWith": [], "stage": "backlog", "status": "todo",
                "statusByStage": {}, "order": 0, "project": "u7-proj-a",
                "createdAt": now, "updatedAt": now,
            }],
        })
        print("board.json:", status2)
        return 0 if status == 200 and status2 == 200 else 1

    if args.mode == "apply":
        if not args.self_run_id:
            ap.error("--self-run-id is required for apply")
        # Gate 1 — the live-activity check precedes EVERY capture, file
        # write, image tag, seed, build and compose call: a refusal here
        # must leave the shared private baseline byte-identical.
        try:
            preflight_idle(args.self_run_id)
        except (StepError, H.HarnessError) as e:
            print(f"REFUSE  {e}")
            return 1
        if on_test_stack():
            print("REFUSE  already on the test stack — apply would mutate "
                  "services under possibly-active U7 roles/tests; "
                  "restore first or use on/off/seed")
            return 1
        stage = _new_stage_dir(args.window)
        try:
            # Everything until the boundary writes into the private stage,
            # never the shared baseline — any refusal below leaves the
            # pre-existing inspect-*.json / restore-acp-ui.* untouched.
            capture_all(stage)
            print(f"captured fresh actual specs (staged: {stage.name})")
            gen_args = ["--inspect-dir", str(stage),
                        "--out", str(stage / "restore-acp-ui.yaml"),
                        "--check-out",
                        str(stage / "restore-acp-ui-check.json")]
            if restore_gen.main(gen_args) != 0:
                return 1
            missing = missing_captured_images(stage)
            if missing:
                print("REFUSE  captured image missing from local store for "
                      f"{missing} — restore would not be exact; aborting "
                      "before any service mutation")
                return 1
            render_check(stage)
            seed_marker()
            seed_sandbox()
            seed_cli_compat()
            seed_scheduler_limits()
            provision_test_ops()
            build_image()
            # Gate 2 — rechecked right before the mutation boundary; the
            # staged baseline is still unpublished, so a refusal here
            # rewrites nothing shared and touches no service.
            preflight_idle(args.self_run_id)
            # Fail-closed pins of the EXACT staged capture images, then a
            # regeneration so the staged restore file references the
            # freshly verified :u7baseline tags.
            pin_restore_images(stage)
            if restore_gen.main(gen_args) != 0:
                return 1
            _publish_stage(stage)
        except (StepError, H.HarnessError) as e:
            print(f"REFUSE  {e}")
            return 1
        finally:
            _cleanup_stage(stage)
        _transition_began = True
        try:
            if args.window:
                # Ownership receipt BEFORE the first scoped mutation — the
                # orchestrator restores only windows that reached this point.
                write_private(PRIV / f"window-{_safe_name(args.window)}.json",
                              json.dumps({"window": args.window,
                                          "selfRunId": args.self_run_id,
                                          "state": "mutation-begun",
                                          "at": time.time()}, indent=2))
            print("stop cron (prior status captured)")
            compose(FILES_OFF, "stop", CRON)
            print("up -d --no-deps state runner web bridge-hermes (OFF)")
            up(FILES_OFF, *SCOPED)
            time.sleep(1.0)
            H.require_stack(services=("state", "web", "runner"))
            if not H.service_running("bridge-hermes"):
                raise StepError("bridge-hermes not running after transition")
            write_private(PRIV / "transition-receipt.json", json.dumps({
                "phase": "off", "at": time.time(), "window": args.window,
                "stateDir": str(TEST_STATE_DIR),
            }, indent=2))
            if args.window:
                write_private(PRIV / f"window-{_safe_name(args.window)}.json",
                              json.dumps({"window": args.window,
                                          "state": "applied",
                                          "at": time.time()}, indent=2))
            print("transition complete — OFF stack live on fixed ports")
        except BaseException:
            print("transition failed — restoring before exit")
            _restore_impl()
            raise
        return 0

    if args.mode in ("on", "fusion", "preparation", "off"):
        H.verify_isolation()
        flag_files = {"on": FILES_ON, "fusion": FILES_FUSION,
                      "preparation": FILES_PREP,
                      "off": FILES_OFF}[args.mode]
        _transition_began = True
        try:
            print(f"up -d --no-deps state runner ({args.mode.upper()} overlay)")
            up(flag_files, "state", "runner")
            time.sleep(1.0)
            if args.mode in ("on", "fusion", "preparation"):
                H.verify_isolation()
                sweep_orphan_runs()
                extra = (" ACP_EXEC_FUSION=1 "
                         "ACP_F1_CONFIG=/repo/deploy/execution/"
                         "environment.config.json") if args.mode == "fusion" else ""
                if args.mode == "preparation":
                    extra = (" ACP_EXEC_PREPARATION=1 "
                             "ACP_PREP_TICK_MS=1000 "
                             "ACP_PREP_MODEL=muse-spark-1.3-contributor-free")
                print(f"{args.mode.upper()} phase live — ACP_EXEC_START=1 "
                      f"ACP_EXEC_VALIDATION=1{extra}")
            else:
                print("OFF phase restored")
        except BaseException:
            print(f"{args.mode} transition failed — restoring before exit")
            _restore_impl()
            raise
        return 0

    return 2


if __name__ == "__main__":
    sys.exit(main())
