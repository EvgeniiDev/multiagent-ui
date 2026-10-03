// scripts/u3_crossuid_proof.mjs — REAL cross-UID provisioning proof for U3.
//
// Runs INSIDE the prepared runner image via a oneoff compose container as
// root; the root phase provisions through PRODUCTION module/service code on
// isolated temp paths under the shared projects mount, then spawns a uid1001
// child which proves readability/writability through production code again.
// No listeners, no live state/token mutation, no global git config, no chown
// of foreign repos. Every fixture is created and removed by this script.
//
// Parent invocation — from the MAIN compose project, using the runner image;
// the script is reached via the mounted /home/hermes/projects tree (no
// separate compose project, nothing deployed, no listeners):
//   cd /home/hermes/projects/acp-ui && docker compose run --rm --no-deps \
//     --user 0:0 --entrypoint /usr/local/bin/node runner \
//     /home/hermes/projects/acp-ui-agent-modes/scripts/u3_crossuid_proof.mjs
//
// Exit 0 = all checks passed. Output is JSON-lines: {"check","ok","detail"}.
// Token VALUES are never printed — only ownership/mode/readability booleans.

import { spawnSync, execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createStateService } from '../server/execution/state-service.mjs';
import { ensureInternalToken, loadInternalToken, tokenFilePath }
  from '../server/execution/internal-transport.mjs';
import { ensureWorkspaceRootAccess, createWorkspace, verifyWorkspace, gitCommonDir }
  from '../server/execution/workspaces.mjs';

const RUNNER_UID = 1001;
const RUNNER_GID = 1001;
const BASE = `/home/hermes/projects/.acp-u3-xuid-${randomUUID().slice(0, 8)}`;

const results = [];
const rec = (check, ok, detail = '') => {
  results.push({ check, ok });
  console.log(JSON.stringify({ check, ok, detail }));
};
const diag = (r) =>
  `status=${r.status} code=${r.json?.code ?? '-'} ${String(r.json?.error ?? '').slice(0, 160)}`;
const VALID_PI_MEMBER = { cli: 'pi', model: 'zen-relay/muse-spark-1.3-contributor-free' };
const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf-8', timeout: 20000 }).trim();

async function childMain(base) {
  // ---- uid1001 phase: prove the provisioned state is usable by the runner --
  const euid = process.getuid?.() ?? -1;
  const egid = process.getgid?.() ?? -1;
  rec('child: effective identity is 1001:1001',
    euid === RUNNER_UID && egid === RUNNER_GID, `uid=${euid} gid=${egid}`);

  const stateDir = path.join(base, 'svc-state');
  const stateDir2 = path.join(base, 'preexisting');
  const wsRoot = path.join(base, 'wsroot');
  const repo = path.join(base, 'repo');

  // 1. Runner can read the token the (root) state service provisioned.
  try {
    const tok = await loadInternalToken(stateDir);
    rec('child: token readable (service-provisioned)', typeof tok === 'string' && tok.length >= 32);
  } catch (e) { rec('child: token readable (service-provisioned)', false, String(e.code || e.message)); }

  // 2. Runner can read a token RECONCILED from a pre-existing root-owned
  //    0700 dir + 0600 file.
  try {
    const tok2 = await loadInternalToken(stateDir2);
    rec('child: token readable (reconciled root-owned)', typeof tok2 === 'string' && tok2.length >= 32);
  } catch (e) { rec('child: token readable (reconciled root-owned)', false, String(e.code || e.message)); }

  // 3. w+x under the root-provisioned workspace root.
  try {
    const probe = path.join(wsRoot, `.probe-${randomUUID().slice(0, 6)}`);
    await fs.mkdir(probe);
    await fs.writeFile(path.join(probe, 'w'), 'x');
    await fs.rm(probe, { recursive: true });
    rec('child: workspace root writable+executable', true);
  } catch (e) { rec('child: workspace root writable+executable', false, String(e.code || e.message)); }

  // 4. Production workspace creation as uid1001 on the uid1001-owned repo.
  //    verifyWorkspace's {ok, problems} result is asserted, not assumed.
  try {
    const baseCommit = git(repo, 'rev-parse', 'HEAD');
    const branch = 'acp/proof/ws-proof1';
    const target = path.join(wsRoot, 'proj-x', 'card-w--ws-proof1');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await createWorkspace({ sourcePath: repo, targetPath: target, branch, baseCommit });
    const expectedCommon = await gitCommonDir(repo);
    const v = await verifyWorkspace({ targetPath: target, branch, baseCommit,
      expectCommonDir: expectedCommon });
    const detail = v.ok ? `head=${v.head?.slice(0, 8)} branch=${v.branch}`
      : `problems=${(v.problems || []).map((p) => String(p).slice(0, 120)).join(';')}`;
    rec('child: production worktree create+verify on uid1001 repo',
      v.ok === true && v.head === baseCommit && v.branch === branch, detail);
    await fs.rm(target, { recursive: true, force: true });
  } catch (e) { rec('child: production worktree create+verify on uid1001 repo', false, String(e.code || e.message)); }

  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

async function parentMain() {
  let mergedChildChecks = 0, mergedChildFails = 0;
  const stateDir = path.join(BASE, 'svc-state');
  const stateDir2 = path.join(BASE, 'preexisting');
  const wsRoot = path.join(BASE, 'wsroot');
  const repo = path.join(BASE, 'repo');

  try {
    // --- fixtures: uid1001-owned git repo + temp roots -----------------------
    await fs.mkdir(repo, { recursive: true });
    await fs.writeFile(path.join(repo, 'req.md'), '# Imported requirements\n');
    execFileSync('git', ['init', '-q', repo]);
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
    execFileSync('chown', ['-R', `${RUNNER_UID}:${RUNNER_GID}`, repo]);
    rec('fixture: uid1001-owned git repo created', true);

    // --- root: production service startup provisions token for uid1001 -------
    const svc = await createStateService({
      stateDir,
      env: {
        ACP_WORKSPACE_DIR: wsRoot,
        ACP_EXEC_TOKEN_UID: String(RUNNER_UID),
        ACP_EXEC_TOKEN_GID: String(RUNNER_GID),
        ROOT_DIR: BASE,
      },
      features: { start: true },
    });
    const tf = tokenFilePath(stateDir);
    const ts = await fs.lstat(tf);
    rec('root: service provisioned token 1001:1001 mode0600',
      ts.uid === RUNNER_UID && ts.gid === RUNNER_GID && (ts.mode & 0o777) === 0o600,
      `${ts.uid}:${ts.gid}:${(ts.mode & 0o777).toString(8)}`);

    // --- root: production service enable/import/start on uid1001 repo --------
    // enable → isGitRoot (scoped safe.directory under foreign-owned repo)
    // import → readImportSource → isGitRoot again
    // start  → resolveBaseCommit
    const req = (method, p, body) => svc.request({
      method, path: p, query: new URLSearchParams(),
      bodyText: body === undefined ? undefined : JSON.stringify(body),
    });
    await req('PUT', '/api/state/projects.json',
      { data: { version: 1, projects: [{ id: 'proj-x', name: 'proj-x', path: repo }] } });
    await req('PUT', '/api/state/board.json',
      { data: { version: 2, cards: [{ id: 'card-w', title: 'w', stage: 'spec', status: 'in_progress', project: 'proj-x', order: 1 }] } });
    let r = await req('POST', '/api/execution/cards/card-w/commands',
      { commandId: 'en-x1', type: 'enable' });
    rec('root: service enable() on uid1001 repo (scoped git trust)',
      r.status === 200, diag(r));
    const c0 = (await req('GET', '/api/execution/cards/card-w')).json;
    r = await req('POST', '/api/execution/cards/card-w/commands', {
      commandId: 'at-x1', type: 'attach_document',
      expectedControlRevision: c0.controlRevision,
      payload: { kind: 'requirements', source: { type: 'import', projectId: 'proj-x', path: 'req.md' } },
    });
    rec('root: service attach_document(import) on uid1001 repo',
      r.status === 200, diag(r));
    const reqVer = r.json?.result;
    const c1 = (await req('GET', '/api/execution/cards/card-w')).json;
    r = await req('POST', '/api/execution/cards/card-w/commands', {
      commandId: 'ap-x1', type: 'approve_requirements',
      expectedControlRevision: c1.controlRevision, payload: reqVer,
    });
    rec('root: approve_requirements', r.status === 200, diag(r));
    const planDoc = await req('POST', '/api/execution/cards/card-w/commands', {
      commandId: 'at-x2', type: 'attach_document',
      expectedControlRevision: (await req('GET', '/api/execution/cards/card-w')).json.controlRevision,
      payload: { kind: 'plan', source: { type: 'text', text: '# Plan\n' }, checks: [{ run: 'true', timeoutSec: 10 }] },
    });
    rec('root: attach plan', planDoc.status === 200, diag(planDoc));
    r = await req('POST', '/api/execution/cards/card-w/commands', {
      commandId: 'ap-x2', type: 'approve_plan',
      expectedControlRevision: (await req('GET', '/api/execution/cards/card-w')).json.controlRevision,
      payload: planDoc.json?.result,
    });
    rec('root: approve_plan', r.status === 200, diag(r));
    r = await req('POST', '/api/execution/cards/card-w/commands', {
      commandId: 'ps-x1', type: 'save_preset',
      expectedControlRevision: (await req('GET', '/api/execution/cards/card-w')).json.controlRevision,
      payload: { preset: {
        id: 'p1', name: 'p',
        members: {
          implementer: { ...VALID_PI_MEMBER },
          reviewer: { ...VALID_PI_MEMBER },
          checker: { ...VALID_PI_MEMBER },
        },
        limits: { maxAttemptsPerRole: 3 } } },
    });
    rec('root: save_preset', r.status === 200, diag(r));

    r = await req('POST', '/api/execution/cards/card-w/commands', {
      commandId: 'st-x1', type: 'start',
      expectedControlRevision: (await req('GET', '/api/execution/cards/card-w')).json.controlRevision,
      payload: {},
    });
    rec('root: service start() resolves baseCommit on uid1001 repo',
      r.status === 200 && typeof r.json?.result?.runId === 'string', diag(r));

    // --- root: workspace root provisioned + handed to uid1001 -----------------
    const wst = await ensureWorkspaceRootAccess(wsRoot, { ownerUid: RUNNER_UID, ownerGid: RUNNER_GID })
      .then(() => fs.lstat(wsRoot));
    rec('root: workspace root provisioned, owned by runner uid',
      wst.uid === RUNNER_UID, `uid=${wst.uid}`);

    // --- root: pre-existing root-owned 0700 dir + root-owned token ----------
    // Seed a production-format token (48 hex chars): reconciliation must fix
    // ownership/mode while preserving the EXISTING value — no silent rotation.
    const seededToken = 'ab'.repeat(24);
    await fs.mkdir(path.join(stateDir2, 'execution'), { recursive: true, mode: 0o700 });
    await fs.writeFile(tokenFilePath(stateDir2), seededToken, { mode: 0o600 });
    const t2 = await ensureInternalToken(stateDir2, { readerUid: RUNNER_UID, readerGid: RUNNER_GID });
    const t2s = await fs.lstat(tokenFilePath(stateDir2)).catch(() => null);
    rec('root: pre-existing root-owned token reconciled to reader uid (value preserved)',
      t2.ok === true && t2s && t2s.uid === RUNNER_UID && (t2s.mode & 0o777) === 0o600
        && t2.token === seededToken,
      t2.ok ? `uid=${t2s?.uid} preserved=${t2.token === seededToken}` : `${t2.code}:${t2.message}`);

    // --- drop privileges: run the child phase as uid1001 ----------------------
    const child = spawnSync(process.execPath, [import.meta.url.replace('file://', ''), '--child', BASE],
      { uid: RUNNER_UID, gid: RUNNER_GID, encoding: 'utf-8', timeout: 60000 });
    process.stdout.write(child.stdout || '');
    if (child.stderr) process.stderr.write(child.stderr);
    // Merge the child's per-check results into the summary totals.
    for (const line of (child.stdout || '').split('\n')) {
      try {
        const j = JSON.parse(line);
        if (j && typeof j.check === 'string') {
          mergedChildChecks += 1; if (!j.ok) mergedChildFails += 1;
        }
      } catch { /* not a check line */ }
    }
    rec('child (uid1001) phase exit', child.status === 0,
      `exit=${child.status} checks=${mergedChildChecks} fails=${mergedChildFails}`);
  } finally {
    await fs.rm(BASE, { recursive: true, force: true }).catch(() => {});
  }
  const failed = results.filter((r) => !r.ok);
  // Totals: `results` covers the root phase plus one merged child-phase line;
  // the child's own per-check lines were parsed above into childChecks/Fails
  // and are reported separately so pass/fail is never silently undercounted.
  console.log(JSON.stringify({
    summary: {
      rootChecks: results.length, rootFails: failed.length,
      childChecks: mergedChildChecks, childFails: mergedChildFails,
      pass: results.length - failed.length + mergedChildChecks - mergedChildFails,
      fail: failed.length + mergedChildFails,
    },
  }));
  process.exit((failed.length + mergedChildFails) ? 1 : 0);
}

if (process.argv[2] === '--child') await childMain(process.argv[3]);
else if (process.getuid?.() === 0) await parentMain();
else { console.error('run as root (parent) or via --child (uid1001)'); process.exit(2); }
