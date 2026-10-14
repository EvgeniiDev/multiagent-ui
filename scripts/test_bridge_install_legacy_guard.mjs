#!/usr/bin/env node
// Regression: deploy/install.sh must refuse to write anything while a retired
// acp-bridge-*.service unit is active OR enabled. Bounded end-to-end run of the
// real installer with stubbed HOME (symlinked canonical checkout), stubbed
// systemctl/node, and a real temp filesystem; asserts abort-before-any-writes
// with the exact unit plus manual recovery guidance, and a clean pass-through.
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, symlink, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL = path.join(ROOT, 'deploy/install.sh');
const LEGACY = ['hermes', 'opencode', 'devin', 'pi', 'codex'].map((n) => `acp-bridge-${n}.service`);

async function snapshot(dir) {
  const out = [];
  async function walk(p) {
    for (const e of await readdir(p, { withFileTypes: true })) {
      if (e.isSymbolicLink()) { out.push(path.relative(dir, path.join(p, e.name)) + '@link'); continue; }
      out.push(path.relative(dir, path.join(p, e.name)));
      if (e.isDirectory()) await walk(path.join(p, e.name));
    }
  }
  await walk(dir);
  return out.sort();
}

async function stage(legacyMode) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'acp-install-'));
  const bin = path.join(home, 'bin');
  const webdir = path.join(home, 'web');
  await mkdir(path.join(home, 'projects'), { recursive: true });
  await symlink(ROOT, path.join(home, 'projects', 'acp-ui'));
  await mkdir(bin, { recursive: true });
  await mkdir(webdir, { recursive: true });
  await writeFile(path.join(webdir, 'index.html'), '<html></html>\n');
  // Stub systemctl: scripted legacy states, quiet success for the rest.
  // Legacy modes: 'clean' (units absent: LoadState=not-found), 'active:<unit>',
  // 'enabled:<unit>', 'probe-failure' (every legacy-unit query fails),
  // 'ambiguous:<unit>' (LoadState outside the known set), plus unknown/empty/
  // failing is-active and is-enabled probe outputs.
  const stub = `#!/usr/bin/env bash
mode=${JSON.stringify(legacyMode)}
if [[ "$1" == "--user" ]]; then shift; fi
legacy_unit() {
  for u in "$@"; do case "$u" in acp-bridge-*.service) return 0;; esac; done
  return 1
}
case "$1" in
  show)
    shift; while [[ "$1" == -* ]]; do shift; done
    if legacy_unit "$@" && [[ "$mode" == probe-failure* ]]; then
      echo "Failed to connect to bus: manager unreachable" >&2; exit 1
    fi
    for u in "$@"; do
      case " $mode " in
        *" ambiguous:$u "*) echo "bad-state"; exit 0;;
        *" active:$u "*|*" enabled:$u "*|*" inactive-disabled:$u "*|*" inactive-success:$u "*|*" disabled-success:$u "*|*" active-unknown:$u "*|*" active-empty:$u "*|*" enabled-unknown:$u "*|*" enabled-empty:$u "*|*" active-error:$u "*|*" enabled-error:$u "*) echo loaded; exit 0;;
        *) echo not-found; exit 0;;
      esac
    done;;
  is-active)
    shift; while [[ "$1" == -* ]]; do shift; done
    # Final status line queries the NEW units: report active so install succeeds.
    case " $* " in
      *"acp-ui-web.service"*) echo active; exit 0;;
    esac
    if legacy_unit "$@" && [[ "$mode" == probe-failure* ]]; then
      echo "Failed to connect to bus: manager unreachable" >&2; exit 1
    fi
    for u in "$@"; do
      case " $mode " in
        *" inactive-success:$u "*) echo inactive; exit 0;;
        *" active-unknown:$u "*) echo unknown; exit 4;;
        *" active-empty:$u "*) exit 4;;
        *" active-error:$u "*) echo "systemctl query failed" >&2; exit 1;;
        *" active:$u "*) echo active; exit 0;;
        *) echo inactive; exit 3;;
      esac
    done;;
  is-enabled)
    shift; while [[ "$1" == -* ]]; do shift; done
    if legacy_unit "$@" && [[ "$mode" == probe-failure* ]]; then
      echo "Failed to connect to bus: manager unreachable" >&2; exit 1
    fi
    if [[ "$mode" == "clean" ]]; then echo disabled; exit 1; fi
    for u in "$@"; do
      case " $mode " in
        *" disabled-success:$u "*) echo disabled; exit 0;;
        *" enabled-unknown:$u "*) echo unknown; exit 1;;
        *" enabled-empty:$u "*) exit 1;;
        *" enabled-error:$u "*) echo "systemctl query failed" >&2; exit 1;;
        *" enabled:$u "*|*" active:$u "*) echo enabled; exit 0;;
        *) echo disabled; exit 1;;
      esac
    done;;
  daemon-reload|enable|disable|stop|start) exit 0;;
esac
exit 0
`;
  await writeFile(path.join(bin, 'systemctl'), stub, { mode: 0o755 });
  await writeFile(path.join(bin, 'node'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  return { home, bin, webdir };
}

function runInstall({ home, bin, webdir }) {
  return spawnSync('bash', [path.join(home, 'projects', 'acp-ui', 'deploy', 'install.sh'), '--web-dir', webdir], {
    env: { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin` },
    encoding: 'utf8',
  });
}

// Case (a): an active OR enabled retired unit must abort before ANY writes.
for (const legacyMode of ['active:acp-bridge-hermes.service', 'enabled:acp-bridge-pi.service']) {
  const s = await stage(legacyMode);
  try {
    const before = await snapshot(s.home);
    const r = runInstall(s);
    assert.notEqual(r.status, 0, `installer proceeded despite retired legacy units\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr + r.stdout, /acp-bridge-(hermes|pi)\.service/, 'abort must name the offending retired unit');
    assert.match(r.stderr + r.stdout, /manual/i, 'abort must point at safe manual recovery');
    assert.match(r.stderr + r.stdout, /systemctl --user (stop|disable)/, 'abort must show explicit recovery commands');
    const after = await snapshot(s.home);
    assert.deepEqual(after, before, `installer wrote files before aborting: +${after.filter((f) => !before.includes(f)).join(', ')}`);
    console.log(`PASS retired legacy unit aborts before any writes (${legacyMode})`);
  } finally { await rm(s.home, { recursive: true, force: true }); }
}

// Cases (c–e): probe errors, ambiguous/empty outputs, and contradictory
// output/exit-status pairs must all abort fail-closed before any writes.
// None of these responses are evidence that the legacy unit is absent/safe.
for (const legacyMode of [
  'probe-failure', 'ambiguous:acp-bridge-devin.service',
  'inactive-success:acp-bridge-devin.service', 'disabled-success:acp-bridge-devin.service',
  'active-unknown:acp-bridge-devin.service', 'active-empty:acp-bridge-devin.service',
  'active-error:acp-bridge-devin.service', 'enabled-unknown:acp-bridge-devin.service',
  'enabled-empty:acp-bridge-devin.service', 'enabled-error:acp-bridge-devin.service',
]) {
  const s = await stage(legacyMode);
  try {
    const before = await snapshot(s.home);
    const r = runInstall(s);
    assert.notEqual(r.status, 0, `installer proceeded despite failed legacy-unit probe (${legacyMode})\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr + r.stdout, /acp-bridge-.*\.service/, 'probe-failure abort must name the unprobable retired unit');
    assert.match(r.stderr + r.stdout, /manual/i, 'probe-failure abort must point at safe manual recovery');
    const after = await snapshot(s.home);
    assert.deepEqual(after, before, `installer wrote files after a failed probe: +${after.filter((f) => !before.includes(f)).join(', ')}`);
    console.log(`PASS ambiguous or failed systemctl probe aborts before writes (${legacyMode})`);
  } finally { await rm(s.home, { recursive: true, force: true }); }
}

// Case (b): absent units and explicitly inactive/disabled units both pass.
for (const legacyMode of ['clean', 'inactive-disabled:acp-bridge-hermes.service']) {
  const s = await stage(legacyMode);
  try {
    const r = runInstall(s);
    assert.equal(r.status, 0, `safe legacy state failed install (${legacyMode})\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /installed bridge ->/, 'safe legacy state must proceed to installation');
    console.log(`PASS safe legacy state passes the retired-unit guard (${legacyMode})`);
  } finally { await rm(s.home, { recursive: true, force: true }); }
}

// Static order check: the guard must run before the first write in install.sh.
{
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(INSTALL, 'utf8');
  const lines = src.split('\n');
  const guard = lines.findIndex((l) => /acp-bridge-.*\.service.*is-active|retired.*bridge.*unit/i.test(l));
  const firstWrite = lines.findIndex((l) => /mkdir -p "\$HOME\/\.hermes"|install -m 0755 "\$BRIDGE_SRC"/.test(l));
  assert.ok(guard >= 0, 'install.sh must contain a retired-unit guard');
  assert.ok(firstWrite >= 0, 'install.sh write site lookup failed');
  assert.ok(guard < firstWrite, `retired-unit guard (line ${guard + 1}) must precede first write (line ${firstWrite + 1})`);
  console.log('PASS retired-unit guard precedes all writes in install.sh');
}
