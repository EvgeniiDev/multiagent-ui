#!/usr/bin/env python3
"""Deterministic regression tests — U7 apply capture preservation.

Drives scripts/u7_transition.py `apply` through a fully mocked
subprocess/urlopen seam: NO Docker, NO sockets, NO services. Every
filesystem constant is redirected under a per-test tmp root; the real
~/.cache/acp-u7-devin is never touched, and no live inspect/restore
file content is ever read (fixtures carry opaque sentinel bytes only).

Covered:
  * refusal at the FIRST idle preflight -> zero docker side effects,
    shared captures byte-identical, no window receipt
  * refusal at the SECOND idle preflight (the observed childless-
    bridge guard scenario) -> staged captures cleaned, shared captures
    byte-identical, no tag/publish/stop/up, no window receipt
  * refusal on a captured image absent from the store -> fail-closed
    before any build/tag/mutation
  * fault-injected os.replace during _publish_stage — at a mid-required
    install (after successful installs landed), at an optional install
    after a new (non-baseline) file was already published, and during
    the backup phase before any install — -> every pre-existing shared
    capture byte-identical, partial installs withdrawn, stage and
    rollback dirs cleaned, no window/transition receipt, no
    transition-began flag, no service stop/up/start
  * publish failure + sabotaged rollback restore -> residual prior copy
    preserved in the kept rollback dir and explicitly reported
  * fixed :u7baseline image pins are part of the baseline generation —
    a failed publish re-points them at the prior target or withdraws
    tags that did not exist, never leaving them on the refused capture
  * SIGINT/SIGTERM at backup AND install boundaries — the rollback
    completes before the signal is re-raised (real pending-signal
    delivery proves a transaction commits whole or rolls back whole);
    a fault in the post-move bookkeeping window still restores the
    moved prior / withdraws the moved new file
  * the publish transaction holds an exclusive cross-process flock;
    restore/verify take shared/exclusive reads — no concurrent
    publisher can interleave and no reader sees a mixed generation
  * the rollback copy fallback never writes through a destination
    symlink — a hostile mid-rollback swap cannot redirect captured
    bytes outside the private dir
  * successful apply -> staged capture is published AT the mutation
    boundary and is exactly what restore()/verify() consume; image
    pins resolve to the staged capture ids; service mutations happen
    only after the second preflight passed

Run:  python3 scripts/test_u7_transition_capture_safety.py
"""

from __future__ import annotations

import fcntl
import io
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
from contextlib import ExitStack, redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

# The real signal.signal — captured BEFORE setUp patches the module
# attribute, so a test can still install a genuine handler for
# pending-signal delivery checks.
_real_signal = signal.signal

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _e2e_compose_harness as H          # noqa: E402
import u7_restore_override as RG          # noqa: E402
import u7_transition as T                 # noqa: E402

SELF_ID = "self-run-1"
WINDOW = "w1n0test"
SERVICES = T.SCOPED + [T.CRON]
# Fresh "captured" image ids — distinct from anything a stale baseline
# could hold, so a wrongly-shared old capture is visible on any compare.
NEW_IMAGE = {svc: f"sha256:{i + 1:064x}" for i, svc in enumerate(SERVICES)}

_MUTATING_COMPOSE = {"stop", "up", "start", "restart", "down", "kill",
                     "rm", "create", "recreate", "pause", "unpause"}
_MUTATING_DOCKER = {"stop", "rm", "kill", "create", "run", "restart",
                    "rename", "update"}


def mk_inspect(svc: str, image_id: str) -> dict:
    """Minimal `docker inspect` row satisfying every field the driver,
    the restore generator, and the verifier read."""
    return {
        "Image": image_id,
        "Config": {
            "Image": "live-repo:tag",
            "Env": ["PATH=/usr/bin", f"ACP_ROLE={svc}"],
            "User": "",
            "Cmd": ["node", f"/app/{svc}.mjs"],
            "Entrypoint": ["docker-entrypoint.sh"],
            "WorkingDir": "/app",
        },
        "HostConfig": {"NetworkMode": "host",
                       "RestartPolicy": {"Name": "unless-stopped"}},
        "Mounts": [{"Type": "bind", "Source": f"/live/{svc}",
                    "Destination": "/data", "Mode": "rw"}],
        "State": {"Status": "running", "StartedAt": "2026-01-01T00:00:00Z"},
    }


class Resp:
    def __init__(self, status: int = 200, payload=b""):
        self.status = status
        self._payload = payload if isinstance(payload, bytes) \
            else json.dumps(payload).encode()

    def read(self):
        return self._payload

    def __enter__(self):
        return self

    def __exit__(self, *_a):
        return False


class World:
    """Fake subprocess/urlopen world — records every event for order
    assertions and answers from in-memory container/image tables."""

    def __init__(self, marker_file: Path):
        self.events: list[tuple[str, object]] = []
        self.marker_file = marker_file
        self.containers = {svc: mk_inspect(svc, NEW_IMAGE[svc])
                           for svc in SERVICES}
        self.images = {iid: {"Id": iid,
                             "RepoTags": [f"live-img-{svc}:latest"]}
                       for svc, iid in NEW_IMAGE.items()}
        self.tags: dict[str, str] = {}
        self.top_rows = {
            "bridge-hermes": ["1000 111 1 0 10:00 ? 00:00:01 node "
                              "/app/deploy/acp-ws-bridge.mjs --port 25901"],
            "runner": ["1000 211 1 0 10:00 ? 00:00:01 "
                       "node /app/deploy/acp-runner.mjs"],
        }
        self.claims: dict = {"data": {"claims": [], "attempts": []}}
        self.active_runs = [{"run_id": SELF_ID}]
        self.health_dir = ""            # set after constants are patched
        self.on_build = None            # hook fired inside `docker build`

    # -- helpers for assertions -------------------------------------
    def idx(self, pred) -> int:
        for i, e in enumerate(self.events):
            if pred(e):
                return i
        return -1

    def count(self, pred) -> int:
        return sum(1 for e in self.events if pred(e))

    @staticmethod
    def is_claims(e) -> bool:
        return e[0] == "http" and str(e[1]).endswith("/api/state/claims.json")

    @staticmethod
    def is_inspect(e) -> bool:
        return e[0] == "cmd" and e[1][:2] == ["docker", "inspect"]

    @staticmethod
    def is_build(e) -> bool:
        return e[0] == "cmd" and e[1][:2] == ["docker", "build"]

    @staticmethod
    def is_tag(e) -> bool:
        return e[0] == "cmd" and e[1][:2] == ["docker", "tag"]

    @staticmethod
    def _compose_subcmd(cmd: list[str]):
        i = 2                                    # skip docker compose
        while i < len(cmd):
            if cmd[i] in ("-p", "-f", "--project-name", "--file"):
                i += 2
            elif cmd[i].startswith("-"):
                i += 1
            else:
                return cmd[i]
        return None

    def service_mutations(self) -> list[list[str]]:
        out = []
        for kind, cmd in self.events:
            if kind != "cmd":
                continue
            if cmd[:2] == ["docker", "compose"]:
                if self._compose_subcmd(cmd) in _MUTATING_COMPOSE:
                    out.append(cmd)
            elif cmd[0] == "docker" and len(cmd) > 1 \
                    and cmd[1] in _MUTATING_DOCKER:
                out.append(cmd)
        return out

    # -- faked seams -------------------------------------------------
    def urlopen(self, req, timeout=None):
        url = req.full_url if hasattr(req, "full_url") else req
        self.events.append(("http", url))
        if url.endswith("/api/state/claims.json"):
            return Resp(200, self.claims)
        if url.endswith("/health"):
            return Resp(200, {"dir": self.health_dir})
        if f"/api/state/{H.MARKER_DOC}" in url:
            doc = json.loads(self.marker_file.read_text())
            return Resp(200, {"data": doc["data"], "rev": doc.get("rev")})
        if url == H.WEB_URL:
            return Resp(200, {})
        raise urllib.error.URLError(f"unhandled url {url}")

    def _image_id(self, ref: str):
        if ref in self.tags:
            return self.tags[ref]
        return ref if ref in self.images else None

    def run(self, cmd, *a, **kw):
        cmd = [str(c) for c in cmd]
        self.events.append(("cmd", cmd))

        def cp(rc=0, out="", err=""):
            return subprocess.CompletedProcess(cmd, rc, out, err)

        if cmd[0] == "openssl":
            return cp(0, "ab" * 24 + "\n")
        if cmd[0] == "git":
            return cp()
        if "delegate" in cmd:                       # porch delegate list
            return cp(0, json.dumps(self.active_runs))
        if cmd[:2] == ["docker", "inspect"]:
            svc = cmd[2].removeprefix("acp-ui-").removesuffix("-1")
            d = self.containers.get(svc)
            return cp(0, json.dumps([d])) if d \
                else cp(1, "", "no such container")
        if cmd[:3] == ["docker", "image", "inspect"]:
            iid = self._image_id(cmd[3])
            if iid is None:
                return cp(1, "", "no such image")
            if "--format" in cmd:
                return cp(0, iid + "\n")
            return cp(0, json.dumps([self.images[iid]]))
        if cmd[:2] == ["docker", "tag"]:
            iid, tag = cmd[2], cmd[3]
            if iid not in self.images:
                return cp(1, "", "No such image")
            self.images[iid].setdefault("RepoTags", []).append(tag)
            self.tags[tag] = iid
            return cp()
        if cmd[:2] == ["docker", "rmi"]:
            ref = cmd[2]
            if ref in self.tags:
                iid = self.tags.pop(ref)
                if iid in self.images \
                        and ref in self.images[iid]["RepoTags"]:
                    self.images[iid]["RepoTags"].remove(ref)
                return cp(0, f"Untagged: {ref}\n")
            return cp(1, "", f"Error: No such image: {ref}")
        if cmd[:2] == ["docker", "top"]:
            svc = cmd[2].removeprefix("acp-ui-").removesuffix("-1")
            rows = self.top_rows.get(svc)
            if rows is None:
                return cp(1, "", "no such container")
            return cp(0, "UID PID PPID C STIME TTY TIME CMD\n"
                      + "\n".join(rows))
        if cmd[:2] == ["docker", "build"]:
            if self.on_build:
                self.on_build(self)
            return cp()
        if cmd[:2] == ["docker", "compose"]:
            sub = self._compose_subcmd(cmd)
            if sub == "config":
                return cp(0, json.dumps(self.rendered_config(cmd)))
            if sub == "ps":
                svc = cmd[-1]
                return cp(0, json.dumps(
                    {"Service": svc, "Name": f"acp-ui-{svc}-1",
                     "State": "running"}) + "\n")
            return cp()                             # stop/up/start/...
        return cp(1, "", f"unhandled: {cmd}")

    def rendered_config(self, cmd: list[str]) -> dict:
        """Compose-rendered specs satisfying every render_check assert."""
        files = [cmd[i + 1] for i, c in enumerate(cmd) if c == "-f"]
        fusion = any("fusion" in f for f in files)
        on = fusion or any("u7-on" in f for f in files)
        base = {"ACP_EXEC_START": "1" if on else "0",
                "ACP_EXEC_VALIDATION": "1" if on else "0"}
        if fusion:
            base["ACP_EXEC_FUSION"] = "1"
        st = {"image": T.TEST_IMAGE,
              "environment": {**base,
                              "STATE_DIR": str(T.TEST_STATE_DIR),
                              "ACP_WORKSPACE_DIR": str(T.TEST_WS_DIR)},
              "volumes": [{"target": "/run/acp-ops",
                           "source": str(T.TEST_OPS_DIR)},
                          {"target": "/home/hermes/.cache/"
                                     "pragmatic-orchestration/steer",
                           "source": "/steer", "read_only": True}]}
        rn = {"image": T.TEST_IMAGE,
              "environment": {**base,
                              "ACP_WORKSPACE_DIR": str(T.TEST_WS_DIR),
                              "ACP_EXEC_DIR": str(T.TEST_EXEC_DIR)},
              "volumes": [{"target": "/data", "source": "/d"}]}
        if fusion:
            rn["environment"]["ACP_F1_CONFIG"] = \
                "/repo/deploy/execution/environment.config.json"
        web = {"environment": {},
               "volumes": [{"target": "/repo/dist-web",
                            "source": str(T.ROOT / "dist-web")}]}
        bh = {"environment": {}, "user": "1001:1001", "volumes": [],
              "command": ["node", "/app/deploy/acp-ws-bridge.mjs",
                          "--cmd", "node", "/app/scripts/u7_mock_acp.mjs",
                          "--port", "25901"]}
        return {"services": {"state": st, "runner": rn, "web": web,
                             "bridge-hermes": bh}}


class CaptureSafetyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="u7capsafe-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.priv = self.tmp / "priv"
        self.priv.mkdir(mode=0o700)
        self.state_dir = self.tmp / "state-u7"
        self.marker_file = self.state_dir / f"{H.MARKER_DOC}.json"

        # Pre-existing shared baseline — opaque sentinel bytes. Proving
        # byte-for-byte survival doubles as proof nothing even READ them
        # (they are not valid JSON/YAML a reader could digest).
        self.sentinel = {}
        for svc in SERVICES:
            self.sentinel[f"inspect-{svc}.json"] = \
                f"SENTINEL-CAPTURE-{svc}\n".encode()
        self.sentinel["restore-acp-ui.yaml"] = b"SENTINEL-RESTORE-YAML\n"
        self.sentinel["restore-acp-ui-check.json"] = b"SENTINEL-CHECK\n"
        for name, data in self.sentinel.items():
            p = self.priv / name
            p.write_bytes(data)
            os.chmod(p, 0o600)

        self.world = World(self.marker_file)
        stack = ExitStack()
        self.addCleanup(stack.close)
        p = lambda obj, name, val: stack.enter_context(
            mock.patch.object(obj, name, val))
        p(T, "PRIV", self.priv)
        p(T, "TEST_STATE_DIR", self.state_dir)
        p(T, "TEST_EXEC_DIR", self.state_dir / "execution")
        p(T, "TEST_WS_DIR", self.tmp / "ws-u7")
        p(T, "TEST_OPS_DIR", self.tmp / "ops-u7")
        p(T, "SANDBOX", self.tmp / "sandbox")
        p(T, "FILES_RESTORE", [self.priv / "restore-acp-ui.yaml"])
        p(H, "TEST_STATE_DIR", self.state_dir)
        p(H, "MARKER_FILE", self.marker_file)
        H._verified = False
        stack.enter_context(mock.patch("subprocess.run", self.world.run))
        stack.enter_context(
            mock.patch("urllib.request.urlopen", self.world.urlopen))
        stack.enter_context(mock.patch("signal.signal", lambda *a: None))
        stack.enter_context(mock.patch("time.sleep", lambda *a: None))
        # Post-transition the faked stack reports the test state dir —
        # exactly what verify_isolation() demands inside require_stack.
        self.world.health_dir = str(self.state_dir)
        # Module-level flag survives between tests in this process —
        # reset so a refused apply provably never sets it.
        T._transition_began = False
        if hasattr(T, "_baseline_lock_depth"):
            T._baseline_lock_depth = 0
        self.addCleanup(
            signal.pthread_sigmask, signal.SIG_UNBLOCK,
            {signal.SIGINT, signal.SIGTERM})
        self.addCleanup(_real_signal, signal.SIGTERM, signal.SIG_DFL)
        self.addCleanup(_real_signal, signal.SIGINT, signal.SIG_DFL)

    # -- helpers -----------------------------------------------------
    def cli(self, *argv: str):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(sys, "argv", ["u7_transition.py", *argv]):
            with redirect_stdout(out), redirect_stderr(err):
                try:
                    rc = T.main()
                except SystemExit as e:
                    rc = e.code if isinstance(e.code, int) else 2
        return rc, out.getvalue() + err.getvalue()

    def apply(self):
        return self.cli("apply", "--self-run-id", SELF_ID,
                        "--window", WINDOW)

    def assert_sentinels_intact(self):
        for name, data in self.sentinel.items():
            p = self.priv / name
            self.assertTrue(p.exists(),
                            f"{name} missing — baseline file stranded")
            self.assertEqual(p.read_bytes(), data, f"{name} changed")

    def assert_no_residue(self, extra=()):
        self.assertEqual([p.name for p in self.priv.glob("stage-*")], [],
                         "staging dir leaked into shared private dir")
        self.assertEqual([p.name for p in self.priv.glob("rollback-*")], [],
                         "publish rollback dir leaked into shared private dir")
        self.assertFalse((self.priv / f"window-{WINDOW}.json").exists(),
                         "window mutation receipt written on a refused "
                         "apply — would falsely claim mutation began")
        self.assertFalse((self.priv / "transition-receipt.json").exists(),
                         "transition receipt written on a refused apply")
        self.assertEqual(set(os.listdir(self.priv)),
                         set(self.sentinel) | set(extra),
                         "unexpected files left in shared private dir")

    def install_publish_fault(self, *, install=None, backup=None,
                              install_after=None, backup_after=None,
                              signal_at=None, kill_at=None,
                              restore_replace=(), restore_fallback=(),
                              link_dst=None):
        """Patch os.replace and the rollback copy fallbacks
        (shutil.copyfileobj + shutil.copy2) so _publish_stage can be
        killed at a chosen point — classified by where each move goes,
        not by call order:

          install=N / backup=N  -> the Nth move of that kind raises
                                   BEFORE it runs (no file moved)
          install_after=N / backup_after=N
                               -> the Nth move runs, THEN raises — the
                                  file DID move but bookkeeping after
                                  the call never ran (the signal/moved-
                                  untracked window)
          signal_at=(kind, N, signum)
                               -> the Nth move of kind runs, then the
                                  driver's signal handler is invoked
                                  with signum — SystemExit raised
                                  inside the os.replace frame
          kill_at=(kind, N, signum)
                               -> the Nth move of kind runs, then a
                                  REAL signum is sent to this process
          restore_replace=(names)  -> rollback os.replace of those
                                      priors raises
          restore_fallback=(names) -> the rollback copy fallback of
                                      those priors raises
          link_dst={name: target}  -> before a failing restore-replace,
                                      dst is swapped for a symlink to
                                      target (hostile mid-rollback swap)

        Returns patchers; start them before apply(). self.fault records
        how many moves of each kind ran and which file was failed."""
        real_replace = os.replace
        real_copyfileobj = shutil.copyfileobj
        real_copy2 = shutil.copy2
        link_dst = link_dst or {}
        self.fault = {"install": 0, "backup": 0, "failed": None}

        def kind_of(src, dst):
            s, d = Path(src), Path(dst)
            if d.parent == self.priv and s.parent.parent == self.priv:
                if s.parent.name.startswith("stage-"):
                    return "install"
                if s.parent.name.startswith("rollback-"):
                    return "restore"
            if d.parent.parent == self.priv \
                    and d.parent.name.startswith("rollback-"):
                return "backup"
            return None

        def flaky_replace(src, dst):
            k = kind_of(src, dst)
            if k in ("install", "backup"):
                self.fault[k] += 1
                n, nm = self.fault[k], Path(src).name
                limit = {"install": install, "backup": backup}[k]
                if limit is not None and n == limit:
                    self.fault["failed"] = nm
                    raise OSError(f"injected {k} failure on {nm}")
                after = {"install": install_after,
                         "backup": backup_after}[k]
                if after is not None and n == after:
                    self.fault["failed"] = nm
                    real_replace(src, dst)
                    raise OSError(f"injected post-move {k} failure on "
                                  f"{nm}")
                if signal_at is not None \
                        and signal_at[:2] == (k, n):
                    real_replace(src, dst)
                    self.fault["failed"] = nm
                    T._on_signal(signal_at[2], None)
                    return
                if kill_at is not None and kill_at[:2] == (k, n):
                    real_replace(src, dst)
                    self.fault["failed"] = nm
                    os.kill(os.getpid(), kill_at[2])
                    return
            elif k == "restore" and Path(src).name in restore_replace:
                nm = Path(src).name
                if nm in link_dst:
                    if os.path.lexists(dst):
                        os.remove(dst)
                    os.symlink(link_dst[nm], dst)
                self.fault["failed"] = nm
                raise OSError(f"injected restore failure on {nm}")
            return real_replace(src, dst)

        def flaky_copyfileobj(fsrc, fdst, length=None):
            if Path(fsrc.name).name in restore_fallback:
                raise OSError("injected copy fallback failure on "
                              f"{Path(fsrc.name).name}")
            return real_copyfileobj(fsrc, fdst, length)

        def flaky_copy2(src, dst):
            if Path(src).name in restore_fallback:
                raise OSError("injected copy fallback failure on "
                              f"{Path(src).name}")
            return real_copy2(src, dst)

        return [mock.patch.object(os, "replace", flaky_replace),
                mock.patch.object(shutil, "copyfileobj",
                                  flaky_copyfileobj),
                mock.patch.object(shutil, "copy2", flaky_copy2)]

    def start_faults(self, **kw):
        for p in self.install_publish_fault(**kw):
            p.start()
            self.addCleanup(p.stop)

    def assert_no_mutation(self):
        self.assertEqual(self.world.service_mutations(), [],
                         "service stop/up/start issued on a refused path")
        self.assertEqual(self.world.count(World.is_tag), 0,
                         "docker tag (image pin) ran on a refused path")

    # -- tests --------------------------------------------------------
    def test_first_preflight_refusal_preserves_captures(self):
        """claims doc reports live work -> the FIRST preflight refuses
        before any docker call, capture, write, tag, build or compose."""
        self.world.claims = {"data": {"claims": [{"doc": "live-run"}],
                                     "attempts": []}}
        rc, out = self.apply()
        self.assertEqual(rc, 1, out)
        self.assertIn("REFUSE", out)
        self.assertIn("claims", out)
        # The claims read is the ONLY observable event: no docker
        # inspect/top/tag/build/compose, no git, no openssl.
        self.assertEqual(self.world.events,
                         [("http", f"{H.STATE_URL}/api/state/claims.json")])
        self.assert_sentinels_intact()
        self.assert_no_residue()
        self.assert_no_mutation()

    def test_second_preflight_refusal_preserves_captures(self):
        """The observed incident replay: a live `hermes acp` child appears
        inside bridge-hermes during the image build; the SECOND idle
        preflight must refuse — with every staged capture cleaned and the
        shared baseline untouched (previously it was already truncated).
        """
        def spawn_bridge_child(w):
            w.top_rows["bridge-hermes"].append(
                "1000 555 111 0 10:05 ? 00:00:02 hermes acp")
        self.world.on_build = spawn_bridge_child

        rc, out = self.apply()
        self.assertEqual(rc, 1, out)
        self.assertIn("REFUSE", out)
        self.assertIn("bridge-hermes", out)

        w = self.world
        i_c1 = w.idx(World.is_claims)
        i_inspect = w.idx(World.is_inspect)
        i_build = w.idx(World.is_build)
        claims_at = [i for i, e in enumerate(w.events) if World.is_claims(e)]
        self.assertEqual(len(claims_at), 2,
                         "both idle preflights must have run")
        i_c2 = claims_at[1]
        # Order: gate1 -> staged capture inspects -> build -> gate2.
        self.assertTrue(0 <= i_c1 < i_inspect < i_build < i_c2,
                        f"bad order: {w.events}")
        # Refusal path: pin never ran, publish never happened, no service
        # stop/up/start, no mutation receipt, no residue.
        self.assert_no_mutation()
        self.assert_sentinels_intact()
        self.assert_no_residue()
        # Sanity that the staged capture DID happen (it was cleaned, not
        # published): capture inspects ran between the two gates.
        self.assertGreaterEqual(
            w.count(World.is_inspect), len(SERVICES) + 1)

    def test_missing_captured_image_refuses_before_mutation(self):
        """A captured image absent from the store fails closed — before
        build, tag, publish or any service mutation."""
        gone = NEW_IMAGE["runner"]
        del self.world.images[gone]
        rc, out = self.apply()
        self.assertEqual(rc, 1, out)
        self.assertIn("REFUSE", out)
        self.assertIn("runner", out)
        self.assertEqual(self.world.count(World.is_build), 0,
                         "build ran although a captured image is absent")
        self.assert_no_mutation()
        self.assert_sentinels_intact()
        self.assert_no_residue()

    def test_publish_install_failure_restores_priors(self):
        """os.replace dies on the 4th staged->priv install — mid-required
        list, AFTER three publishes already landed. The refused apply
        must leave every pre-existing shared capture byte-identical,
        remove this attempt's stage AND rollback dirs, write no
        window/transition receipt, never set _transition_began, and
        issue no service stop/up/start (pins legitimately ran earlier —
        they are image-store refs, not service mutations)."""
        unrelated = self.priv / "unrelated-keep.txt"
        unrelated.write_bytes(b"DO-NOT-TOUCH\n")
        self.start_faults(install=4)

        rc, out = self.apply()
        self.assertEqual(rc, 1, out)
        self.assertIn("REFUSE", out)
        self.assertEqual(self.fault["failed"], "inspect-bridge-hermes.json")
        # The refusal names the failing file and does not mask the
        # underlying OSError; rollback is reported complete.
        self.assertIn("inspect-bridge-hermes.json", out)
        self.assertIn("injected install failure", out)
        self.assertIn("restored intact", out)

        self.assert_sentinels_intact()
        self.assertEqual(unrelated.read_bytes(), b"DO-NOT-TOUCH\n",
                         "publish rollback touched an unrelated file")
        self.assert_no_residue(extra=("unrelated-keep.txt",))
        self.assertFalse(T._transition_began,
                         "refused publish set the transition-began flag")
        # Three installs landed, then the refusal rolled them back —
        # prove the injector really ran mid-publish, not before it.
        self.assertEqual(self.fault["install"], 4)
        self.assertEqual(self.fault["backup"], len(self.sentinel))

        w = self.world
        claims_at = [i for i, e in enumerate(w.events)
                     if World.is_claims(e)]
        self.assertEqual(len(claims_at), 2)
        # gate1 -> staged capture -> build -> gate2 -> image pins; the
        # publish failure happens strictly after every pin.
        self.assertTrue(0 <= claims_at[0] < w.idx(World.is_inspect)
                        < w.idx(World.is_build) < claims_at[1]
                        < w.idx(World.is_tag),
                        f"bad order: {w.events}")
        self.assertEqual(w.count(World.is_tag), len(SERVICES))
        # And NOT ONE mutating compose/docker service command exists in
        # the whole stream — the boundary was never crossed.
        self.assertEqual(w.service_mutations(), [])

    def test_publish_failure_withdraws_new_files(self):
        """Failure on the 9th install — render-on.json — AFTER the new
        render-off.json (a name with NO pre-existing shared file) was
        already published. Rollback must restore all seven priors AND
        withdraw the partially installed render-off.json: no staged-only
        name may survive in the shared dir."""
        self.start_faults(install=9)

        rc, out = self.apply()
        self.assertEqual(rc, 1, out)
        self.assertIn("REFUSE", out)
        self.assertEqual(self.fault["failed"], "render-on.json")
        self.assertIn("render-on.json", out)
        # install #8 (render-off.json) landed before the kill point —
        # a real partial publish of a NEW name, not just an overwrite.
        self.assertEqual(self.fault["install"], 9)
        self.assertFalse((self.priv / "render-off.json").exists(),
                         "partially published new file survived rollback")
        self.assert_sentinels_intact()
        self.assert_no_residue()
        self.assertFalse(T._transition_began)
        self.assertEqual(self.world.service_mutations(), [])

    def test_publish_backup_phase_failure_installs_nothing(self):
        """os.replace dies during the backup phase (3rd priv->rollback
        move) — before a single staged byte reached the shared dir.
        Every sentinel stays byte-identical and both already-moved
        priors are put back."""
        self.start_faults(backup=3)

        rc, out = self.apply()
        self.assertEqual(rc, 1, out)
        self.assertIn("REFUSE", out)
        self.assertIn("injected backup failure", out)
        self.assertEqual(self.fault["install"], 0,
                         "a staged file reached the shared dir although "
                         "the backup phase aborted first")
        self.assert_sentinels_intact()
        self.assert_no_residue()
        self.assertFalse(T._transition_began)
        self.assertEqual(self.world.service_mutations(), [])

    def test_rollback_failure_preserves_and_reports_residual(self):
        """Publish dies installing inspect-runner.json AND the rollback
        restore of inspect-state.json is sabotaged (replace + copy
        fallback). Result: every other prior returns byte-identical,
        the unrestored prior's original bytes SURVIVE inside the kept
        rollback dir, the staged partial file left in its place is
        honestly reported — still no receipt, no flag, no service
        mutation."""
        self.start_faults(install=2,
                          restore_replace={"inspect-state.json"},
                          restore_fallback={"inspect-state.json"})

        rc, out = self.apply()
        self.assertEqual(rc, 1, out)
        self.assertIn("REFUSE", out)
        self.assertIn("INCOMPLETE", out)
        self.assertIn("inspect-state.json", out)
        # The injected publish failure is still the reported cause.
        self.assertIn("injected install failure", out)

        # Every prior except the sabotaged one is back byte-for-byte.
        for name, data in self.sentinel.items():
            if name == "inspect-state.json":
                continue
            self.assertEqual((self.priv / name).read_bytes(), data, name)
        # The unrestored name currently holds the STAGED bytes (the
        # partial install that could not be rolled back) — while its
        # prior copy survives in the rollback dir the refusal names.
        staged = json.loads(
            (self.priv / "inspect-state.json").read_text())
        self.assertEqual(staged[0]["Image"], NEW_IMAGE["state"],
                         "inspect-state.json was neither restored nor "
                         "left honestly partial")
        backups = list(self.priv.glob("rollback-*"))
        self.assertEqual(len(backups), 1,
                         "unrestored prior copies must be kept, not "
                         "silently deleted with the stage dir")
        self.assertEqual(
            (backups[0] / "inspect-state.json").read_bytes(),
            self.sentinel["inspect-state.json"],
            "surviving prior copy is not the original baseline bytes")
        self.assertIn(str(backups[0]), out,
                      "refusal did not report where the residual lives")
        # The attempt's OWN stage dir is still cleaned.
        self.assertEqual([p.name for p in self.priv.glob("stage-*")], [])
        self.assertFalse(T._transition_began)
        self.assertFalse((self.priv / f"window-{WINDOW}.json").exists())
        self.assertFalse((self.priv / "transition-receipt.json").exists())
        self.assertEqual(self.world.service_mutations(), [])

    def test_publish_failure_restores_prior_pin_targets(self):
        """The fixed :u7baseline tags are part of the baseline
        generation — the published restore file resolves them BY NAME.
        A failed publish must therefore restore each tag's prior target
        (or withdraw a tag that did not exist), never leave them
        re-pointed at the unpublished capture."""
        tag = {s: f"acp-ui-u7-restore-{s}:u7baseline" for s in SERVICES}
        prior = {s: f"sha256:{0xf0 + i:064x}" for i, s in
                 enumerate(SERVICES[:3])}
        for svc, iid in prior.items():
            self.world.images[iid] = {"Id": iid,
                                      "RepoTags": [f"prior-{svc}:prev",
                                                   tag[svc]]}
            self.world.tags[tag[svc]] = iid
        untagged = SERVICES[3:]
        self.start_faults(install=4)

        rc, out = self.apply()
        self.assertEqual(rc, 1, out)
        self.assertIn("REFUSE", out)

        # Previously pinned services: the fixed tag resolves to the
        # PRIOR image id again — the old baseline restores the old
        # image, not the failed capture.
        for svc, iid in prior.items():
            self.assertEqual(self.world.tags.get(tag[svc]), iid,
                             f"{tag[svc]} still points at the "
                             "unpublished capture")
            self.assertIn(tag[svc], self.world.images[iid]["RepoTags"])
        # Services with NO prior pin: the fresh tag was withdrawn, not
        # left behind resolving to the unpublished image.
        for svc in untagged:
            self.assertNotIn(tag[svc], self.world.tags,
                             f"{tag[svc]} leaked from the refused "
                             "publish")
        self.assert_sentinels_intact()
        self.assert_no_residue()
        self.assertFalse(T._transition_began)
        self.assertEqual(self.world.service_mutations(), [])

    def test_signal_during_publish_rolls_back_then_reraises(self):
        """SIGTERM landing mid-install (the driver's real _on_signal
        raising SystemExit inside os.replace) is NOT a publishable
        OSError: the rollback must still run to completion BEFORE the
        signal is re-raised — priors byte-identical, partial installs
        withdrawn, pins restored — and the process must exit with the
        signal status, never a swallowed REFUSE."""
        self.start_faults(signal_at=("install", 4, signal.SIGTERM))

        rc, out = self.apply()
        self.assertEqual(rc, 128 + signal.SIGTERM,
                         f"SIGTERM was swallowed into a normal exit: "
                         f"rc={rc} out={out}")
        # The 4th install (bridge-hermes) really did land before the
        # signal — the rollback had real work to undo.
        self.assertEqual(self.fault["failed"],
                         "inspect-bridge-hermes.json")
        self.assert_sentinels_intact()
        # The pins moved before the signal — they must be rolled back
        # too, not left pointing at the unpublished capture.
        self.assertEqual(self.world.tags, {},
                         "restore-image pins survived a signaled publish")
        self.assert_no_residue()
        self.assertFalse(T._transition_began)
        self.assertEqual(self.world.service_mutations(), [])

    def test_signal_during_backup_phase_rolls_back_priors(self):
        """SIGTERM inside the backup phase — after a prior was moved
        aside but before the move's bookkeeping ran — must still
        restore every moved prior: rollback state comes from the
        rollback dir's CONTENTS, so an interrupted move cannot strand
        a baseline file."""
        self.start_faults(signal_at=("backup", 3, signal.SIGTERM))

        rc, out = self.apply()
        self.assertEqual(rc, 128 + signal.SIGTERM, out)
        # 3 priors were genuinely moved aside before the signal.
        self.assertEqual(self.fault["backup"], 3)
        self.assert_sentinels_intact()
        self.assert_no_residue()
        self.assertFalse(T._transition_began)
        self.assertEqual(self.world.service_mutations(), [])

    def test_post_move_backup_fault_restores_untracked_prior(self):
        """An OSError raised AFTER os.replace already moved a prior —
        the exact interleaving a signal produces — must not strand the
        file: the prior moved but was never recorded in the rollback
        bookkeeping, so only content-derived rollback brings it back."""
        self.start_faults(backup_after=3)

        rc, out = self.apply()
        self.assertEqual(rc, 1, out)
        self.assertIn("REFUSE", out)
        self.assertIn("restored intact", out)
        # The 3rd backup move really happened before the fault.
        self.assertEqual(self.fault["backup"], 3)
        self.assert_sentinels_intact()
        self.assert_no_residue()
        self.assertFalse(T._transition_began)

    def test_post_move_install_fault_withdraws_untracked_new_file(self):
        """Same post-move window on the install side: a staged NEW name
        (no prior) whose os.replace completed but whose bookkeeping
        never ran must still be withdrawn — rollback decides from what
        the rollback dir actually contains, not from an append that may
        have been skipped."""
        self.start_faults(install_after=8)

        rc, out = self.apply()
        self.assertEqual(rc, 1, out)
        self.assertIn("REFUSE", out)
        self.assertIn("restored intact", out)
        # render-off.json (install #8) moved in, then the fault hit.
        self.assertEqual(self.fault["failed"], "render-off.json")
        self.assertFalse((self.priv / "render-off.json").exists(),
                         "post-move new file survived rollback")
        self.assert_sentinels_intact()
        self.assert_no_residue()
        self.assertFalse(T._transition_began)

    def test_real_sigterm_pending_until_transaction_completes(self):
        """A REAL SIGTERM delivered mid-install must not corrupt the
        baseline: signal delivery is deferred to the commit point, so
        the publish either commits a complete new generation or rolls
        fully back — here it commits (the mask holds to the end), the
        handler then runs and the process exits with the signal
        status. Proves a pending signal can never split the
        transaction."""
        _real_signal(signal.SIGTERM, T._on_signal)
        self.start_faults(kill_at=("install", 2, signal.SIGTERM))

        rc, out = self.apply()
        self.assertEqual(rc, 128 + signal.SIGTERM,
                         f"pending SIGTERM lost or swallowed: "
                         f"rc={rc} out={out}")
        self.assertEqual(self.fault["failed"], "inspect-runner.json")
        # The publish COMMITTED under deferral — the whole shared
        # baseline is the new staged generation, never a mix.
        for svc in SERVICES:
            p = self.priv / f"inspect-{svc}.json"
            self.assertTrue(p.exists(),
                            f"mixed generation: {p.name} missing")
            try:
                d = json.loads(p.read_text())
            except Exception:
                self.fail(f"mixed generation: {p.name} holds "
                          f"{p.read_bytes()[:60]!r}")
            self.assertEqual(d[0]["Image"], NEW_IMAGE[svc],
                             f"mixed generation: inspect-{svc}.json")
        manifest = json.loads(
            (self.priv / "restore-acp-ui-check.json").read_text())
        self.assertEqual(manifest["state"]["image"], NEW_IMAGE["state"])
        self.assertTrue(
            (self.priv / "restore-acp-ui.yaml").read_text())
        # No half-committed residue.
        self.assertEqual([p.name for p in self.priv.glob("stage-*")], [])
        self.assertEqual([p.name for p in self.priv.glob("rollback-*")],
                         [])
        self.assertEqual(self.world.service_mutations(), [])

    def test_publish_holds_exclusive_baseline_lock(self):
        """The publish transaction must hold an OS-level (flock)
        EXCLUSIVE lock for the whole critical section — a concurrent
        publisher cannot acquire EX and a concurrent reader cannot
        acquire SH mid-publish, so neither can see a half-moved
        generation. Probed non-blockingly from inside the publish
        itself; released again afterwards."""
        lock_path = getattr(
            T, "_baseline_lock_path",
            lambda: self.priv.with_name(self.priv.name + ".lock"))()
        probes = {}
        real_replace = os.replace

        def probing_replace(src, dst):
            s, d = Path(src), Path(dst)
            if d.parent == self.priv \
                    and s.parent.parent == self.priv \
                    and s.parent.name.startswith("stage-") \
                    and "mid" not in probes:
                res = {}
                for name, op in (
                        ("EX", fcntl.LOCK_EX | fcntl.LOCK_NB),
                        ("SH", fcntl.LOCK_SH | fcntl.LOCK_NB)):
                    fd = os.open(lock_path,
                                 os.O_RDWR | os.O_CREAT, 0o600)
                    try:
                        fcntl.flock(fd, op)
                        res[name] = "acquired"
                    except BlockingIOError:
                        res[name] = "blocked"
                    finally:
                        os.close(fd)
                probes["mid"] = res
            return real_replace(src, dst)

        with mock.patch.object(os, "replace", probing_replace):
            rc, out = self.apply()
        self.assertEqual(rc, 0, out)
        self.assertEqual(probes.get("mid"),
                         {"EX": "blocked", "SH": "blocked"},
                         "publish ran without holding the baseline "
                         "lock exclusively")
        # And the lock is released once the transaction is over.
        fd = os.open(lock_path, os.O_RDWR)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.fail("baseline lock still held after publish")
        finally:
            os.close(fd)

    def test_readers_acquire_baseline_lock(self):
        """restore and verify must take the baseline lock while they
        read — a shared lock for verify, exclusive for restore (which
        may also regenerate the restore file) — so a publish in
        progress can never hand them a mixed generation."""
        lock_path = os.path.realpath(
            self.priv.with_name(self.priv.name + ".lock"))
        ops = []
        real_flock = fcntl.flock

        def spy(fd, op):
            try:
                ops.append((os.path.realpath(
                    os.readlink(f"/proc/self/fd/{fd}")), op))
            except OSError:
                ops.append(("?", op))
            return real_flock(fd, op)

        # An empty manifest is a valid, fully-matching baseline for the
        # fake world — keeps this about locking, not content.
        (self.priv / "restore-acp-ui-check.json").write_text("{}")
        self.world.health_dir = str(T.LIVE_STATE_DIR)
        with mock.patch("fcntl.flock", spy):
            rc, out = self.cli("verify")
            self.assertEqual(rc, 0, out)
            rc, out = self.cli("restore")
            self.assertEqual(rc, 0, out)
        got = [op for p, op in ops if p == lock_path]
        self.assertIn(fcntl.LOCK_SH, got,
                      f"verify read the baseline unlocked: {ops}")
        self.assertIn(fcntl.LOCK_EX, got,
                      f"restore read the baseline unlocked: {ops}")

    def test_rollback_copy_never_follows_dst_symlink(self):
        """The rollback copy fallback must never write through a
        destination symlink: a hostile swap that replaces the partially
        published inspect-state.json with a link to a file OUTSIDE the
        private dir must leave the outside file untouched and still
        restore the prior baseline bytes as a real file."""
        outside = self.tmp / "outside-priv.txt"
        outside.write_bytes(b"OUTSIDE-ORIGINAL\n")
        self.start_faults(
            install=2,
            restore_replace={"inspect-state.json"},
            link_dst={"inspect-state.json": outside})

        rc, out = self.apply()
        self.assertEqual(rc, 1, out)
        self.assertIn("REFUSE", out)
        self.assertIn("restored intact", out)
        self.assertEqual(self.fault["failed"], "inspect-state.json")

        # The file behind the planted link was never written through.
        self.assertEqual(outside.read_bytes(), b"OUTSIDE-ORIGINAL\n",
                         "rollback copy followed a dst symlink and "
                         "wrote captured bytes outside the private dir")
        # And the prior itself still came back — as a real file, not
        # the attacker's link.
        p = self.priv / "inspect-state.json"
        self.assertFalse(p.is_symlink(), "restored prior is a symlink")
        self.assertEqual(p.read_bytes(),
                         self.sentinel["inspect-state.json"])
        self.assert_sentinels_intact()
        self.assert_no_residue()
        self.assertFalse(T._transition_began)
        self.assertEqual(self.world.service_mutations(), [])

    def test_successful_apply_publishes_staged_capture(self):
        """Full mocked apply: staged captures are pinned + published at
        the mutation boundary, and restore()/verify() then consume the
        published files — i.e. exactly this window's capture."""
        stage_modes = {}

        def peek_stage(w):
            dirs = [d for d in self.priv.glob("stage-*") if d.is_dir()]
            self.assertEqual(len(dirs), 1, "expected exactly one stage dir")
            st = dirs[0]
            stage_modes["dir"] = st.stat().st_mode & 0o777
            insp = st / "inspect-state.json"
            stage_modes["file"] = insp.stat().st_mode & 0o777
            # Staged capture already carries the NEW ids pre-publish.
            self.assertIn(NEW_IMAGE["state"], insp.read_text())
            self.assertTrue((st / "restore-acp-ui.yaml").exists())
            self.assertTrue((st / "restore-acp-ui-check.json").exists())
        self.world.on_build = peek_stage

        rc, out = self.apply()
        self.assertEqual(rc, 0, out)
        self.assertIn("transition complete", out)

        # Staging area isolation while it existed.
        self.assertEqual(stage_modes.get("dir"), 0o700, stage_modes)
        self.assertEqual(stage_modes.get("file"), 0o600, stage_modes)

        w = self.world
        claims_at = [i for i, e in enumerate(w.events) if World.is_claims(e)]
        self.assertEqual(len(claims_at), 2)
        i_inspect = w.idx(World.is_inspect)
        i_build = w.idx(World.is_build)
        i_tag = w.idx(World.is_tag)
        i_stop = w.idx(lambda e: e[0] == "cmd"
                       and w._compose_subcmd(e[1]) == "stop")
        i_up = w.idx(lambda e: e[0] == "cmd"
                     and w._compose_subcmd(e[1]) == "up")
        # gate1 -> capture -> build -> gate2 -> pin -> stop cron -> up.
        self.assertTrue(0 <= claims_at[0] < i_inspect < i_build
                        < claims_at[1] < i_tag < i_stop < i_up,
                        f"bad order: {w.events}")

        # Pins target the EXACT staged capture ids, verified per service.
        tagged = {e[1][3]: e[1][2] for e in w.events if World.is_tag(e)}
        for svc in SERVICES:
            self.assertEqual(
                tagged.get(f"acp-ui-u7-restore-{svc}:u7baseline"),
                NEW_IMAGE[svc], f"pin for {svc} does not resolve to the "
                                "staged capture image")

        # Published baseline = the staged capture; stage dir cleaned.
        self.assertEqual([p.name for p in self.priv.glob("stage-*")], [])
        for svc in SERVICES:
            d = json.loads((self.priv / f"inspect-{svc}.json").read_text())
            self.assertEqual(d[0]["Image"], NEW_IMAGE[svc],
                             f"published inspect-{svc}.json is not the "
                             "staged capture")
            self.assertEqual(
                (self.priv / f"inspect-{svc}.json").stat().st_mode & 0o777,
                0o600)
        yaml_text = (self.priv / "restore-acp-ui.yaml").read_text()
        self.assertIn(":u7baseline", yaml_text,
                      "restore file does not reference the pinned tags")
        manifest = json.loads(
            (self.priv / "restore-acp-ui-check.json").read_text())
        for svc in SERVICES:
            self.assertEqual(manifest[svc]["image"], NEW_IMAGE[svc])
        for svc in T.SCOPED:
            self.assertTrue(manifest[svc]["imageRef"].endswith(":u7baseline"),
                            f"{svc} manifest ref {manifest[svc]['imageRef']} "
                            "is not the pinned tag")

        # Window receipt exists and records this window honestly.
        receipt = json.loads(
            (self.priv / f"window-{WINDOW}.json").read_text())
        self.assertEqual(receipt["state"], "applied")
        self.assertEqual(receipt["window"], WINDOW)

        # verify() consumes the PUBLISHED manifest: the live (faked)
        # inspect data still matches the staged capture -> rc 0. The old
        # sentinel check file was unparseable, so success here is only
        # possible through the published staged manifest.
        rc, out = self.cli("verify")
        self.assertEqual(rc, 0, out)
        self.assertIn("match the captured actual spec", out)

        # restore() consumes the PUBLISHED restore file: its compose up
        # must reference the file we just staged+published.
        self.world.health_dir = str(T.LIVE_STATE_DIR)
        rc, out = self.cli("restore")
        self.assertEqual(rc, 0, out)
        ups = [e[1] for e in w.events if e[0] == "cmd"
               and w._compose_subcmd(e[1]) == "up"]
        restore_ups = [c for c in ups
                       if str(self.priv / "restore-acp-ui.yaml") in c]
        self.assertEqual(len(restore_ups), 1,
                         "restore did not compose-up the published file")
        started = [e[1] for e in w.events if e[0] == "cmd"
                   and w._compose_subcmd(e[1]) == "start"]
        self.assertTrue(any("cron" in c for c in started),
                        "captured-running cron was not restarted")


if __name__ == "__main__":
    unittest.main(verbosity=2)
