// Real state-service queue and authenticated internal transport; no listener,
// agent process, controller, or model. These are shared dispatch seam tests.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createStateService } from "../server/execution/state-service.mjs";
import { createInternalClient } from "../server/execution/internal-transport.mjs";
import {
  sha256,
  writeStagedArtifact,
} from "../server/execution/execution-store.mjs";
const roots = [];
after(async () => {
  for (const p of roots) await fs.rm(p, { recursive: true, force: true });
});
const profile = (id) => ({
  schemaVersion: 1,
  profileId: id,
  pi: { version: "0.85.1" },
  image: "worker",
  provider: "zen-relay",
  model: id,
  skills: [],
  extensions: [],
  tools: ["read", "bash"],
  search: { enabled: false, provider: null, params: {} },
  launch: { progress: "none", extraFlags: [] },
  systemPromptFile: null,
});
const member = {
  cli: "pi",
  model: "zen-relay/muse-spark-1.3-contributor-free",
};
const self = {
  envKey: {
    uid: process.getuid(),
    gid: process.getgid(),
    hostname: hostname(),
    bootId: (
      await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")
    ).trim(),
    pidNs: await fs.readlink("/proc/self/ns/pid"),
  },
  runnerId: "wiring-test",
  instanceId: "wiring-instance",
  pid: process.pid,
  uid: process.getuid(),
  gid: process.getgid(),
};
const git = (dir, ...args) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
async function env() {
  const root = await fs.mkdtemp(join(tmpdir(), "mode-wiring-"));
  roots.push(root);
  const stateDir = join(root, "state"),
    project = join(root, "project");
  await fs.mkdir(project);
  git(project, "init", "-q");
  await fs.writeFile(join(project, "a.txt"), "base");
  git(project, "add", ".");
  git(
    project,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-qm",
    "base",
  );
  const svc = await createStateService({
    stateDir,
    features: {
      start: true,
      validation: true,
      fusion: true,
      orchestrator: true,
      swarm: true,
    },
    env: {
      ROOT_DIR: root,
      ACP_WORKSPACE_DIR: join(root, "workspaces"),
      PORCH_STEER_DIR: join(root, "steer"),
      ACP_EXEC_TOKEN_UID: String(process.getuid()),
      ACP_EXEC_TOKEN_GID: String(process.getgid()),
    },
  });
  const request = async (method, path, body, headers) => {
    const u = new URL(path, "http://test");
    return svc.request({
      method,
      path: u.pathname,
      query: u.searchParams,
      bodyText: body === undefined ? undefined : JSON.stringify(body),
      headers,
    });
  };
  const client = createInternalClient({
    stateDir,
    transport: async ({ method, path, body, headers }) => {
      const r = await request(method, path, body, headers);
      return { status: r.status, body: r.json };
    },
  });
  const card = async (id) =>
    (await request("GET", `/api/execution/cards/${id}`)).json;
  const run = async (id) =>
    (await request("GET", `/api/execution/runs/${id}`)).json;
  const user = async (id, type, payload = {}) => {
    const c = await card(id);
    return request("POST", `/api/execution/cards/${id}/commands`, {
      type,
      commandId: randomUUID(),
      expectedControlRevision: c.controlRevision,
      payload,
    });
  };
  const internal = async (id, type, payload = {}) => {
    const c = await card(id);
    return client.command(id, {
      type,
      commandId: randomUUID(),
      expectedInternalRevision: c.internalRevision,
      payload: { ...self, ...payload },
    });
  };
  await request("PUT", "/api/state/projects.json", {
    data: {
      version: 1,
      projects: [{ id: "project", name: "project", path: project }],
    },
  });
  await request("PUT", "/api/state/board.json", {
    data: {
      version: 2,
      cards: ["fusion", "orchestrator", "swarm"].map((id) => ({
        id,
        title: id,
        stage: "spec",
        status: "in_progress",
        project: "project",
        order: 1,
      })),
    },
  });
  for (const id of ["fusion", "orchestrator", "swarm"]) {
    assert.equal((await user(id, "enable")).status, 200);
    for (const kind of ["requirements", "plan"]) {
      const a = await user(id, "attach_document", {
        kind,
        source: { type: "text", text: `# Approved ${kind}` },
        ...(kind === "plan"
          ? { checks: [{ run: "test -f a.txt", timeoutSec: 30 }] }
          : {}),
      });
      assert.equal(a.status, 200, JSON.stringify(a.json));
      const approved = await user(
        id,
        kind === "plan" ? "approve_plan" : "approve_requirements",
        a.json.result,
      );
      assert.equal(approved.status, 200, JSON.stringify(approved.json));
    }
    assert.equal(
      (
        await user(id, "save_preset", {
          preset: {
            id: `preset-${id}`,
            name: "Core gate",
            members: { implementer: member, reviewer: member, checker: member },
            limits: { maxAttemptsPerRole: 3 },
          },
        })
      ).status,
      200,
    );
  }
  const payload = (mode) =>
    mode === "swarm"
      ? {
          mode,
          swarm: {
            participants: ["alpha", "bravo"].map((participantId) => ({
              participantId,
              callsign: participantId,
              profile: profile(participantId),
              ownedPaths: ["a.txt"],
            })),
            limits: {
              maxTurnsPerParticipant: 12,
              maxRounds: 3,
              maxMessages: 200,
              verifyRequired: true,
            },
          },
        }
      : mode === "orchestrator"
        ? {
            mode,
            orchestrator: {
              decomposer: { profile: profile("decomposer") },
              verifier: { profile: profile("verifier") },
              integrator: { profile: profile("integrator") },
              workers: { worker: { profile: profile("worker") } },
              limits: { requireSpecApproval: true },
            },
          }
        : {
            mode,
            fusion: {
              resultKind: "implementation",
              panelists: ["alpha", "bravo"].map((id) => ({
                id,
                profile: profile(id),
              })),
              judge: { profile: profile("judge") },
              integrator: { profile: profile("integrator") },
              review: { reviewer: member, checker: member },
              search: { enabled: false },
            },
          };
  const start = async (mode) => {
    const r = await user(mode, "start", payload(mode));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json.result.runId;
  };
  const artifact = async (cardId, runId, attemptId, kind, text) => {
    const name = `${kind}-${attemptId}.json`,
      id = `art-${randomUUID()}`,
      staged = await writeStagedArtifact(stateDir, attemptId, name, text);
    await internal(cardId, "commit_artifact", {
      runId,
      attemptId,
      artifact: {
        id,
        kind,
        file: name,
        sha256: staged.sha256,
        bytes: staged.bytes,
      },
      stagedPath: staged.stagedPath,
    });
    return { artifactId: id, sha256: staged.sha256, bytes: staged.bytes };
  };
  return {
    root,
    svc,
    request,
    client,
    card,
    run,
    user,
    internal,
    start,
    artifact,
    project,
  };
}
const launch = (entry, attemptId, extra = {}) => ({
  profileId: entry.profileId,
  profileDigest: entry.profileDigest,
  promptSha256: "a".repeat(64),
  materialsSha256: "b".repeat(64),
  cwd: "/work/project",
  attemptDir: "/work/attempt",
  artifactsDir: `/work/attempt/run-${attemptId}`,
  ...extra,
});
test("exact inline UI profiles start three modes with approved immutable inputs and Core roles", async () => {
  const e = await env();
  for (const mode of ["fusion", "orchestrator", "swarm"]) {
    const runId = await e.start(mode),
      r = await e.run(runId);
    assert.equal(r.mode, mode);
    assert.ok(r.inputs.requirements.sha256);
    assert.ok(r.inputs.plan.sha256);
    assert.equal(r.composition.preset.members.reviewer.cli, "pi");
    assert.equal(r.composition.preset.members.checker.cli, "pi");
    if (mode === "swarm")
      assert.equal(r.swarm.participants[0].profile.model, "alpha");
    if (mode === "orchestrator")
      assert.equal(r.orchestrator.workers.worker.profile.model, "worker");
  }
});
test("user channel cannot issue internal swarm authority and unauthenticated transport rejects it", async () => {
  const e = await env(),
    runId = await e.start("swarm");
  assert.notEqual(
    (await e.user("swarm", "swarm_claim", { runId, ...self })).status,
    200,
  );
  const r = await e.request("POST", "/api/internal/cards/swarm/commands", {
    type: "swarm_claim",
    commandId: randomUUID(),
    payload: { runId, ...self },
  });
  assert.notEqual(r.status, 200);
  await e.internal("swarm", "swarm_claim", { runId });
  assert.equal((await e.run(runId)).swarm.owner.runnerId, self.runnerId);
});
test("swarm extra commands dispatch and stop retains live attempt until terminal callback", async () => {
  const e = await env(),
    runId = await e.start("swarm");
  await e.internal("swarm", "swarm_claim", { runId });
  await e.internal("swarm", "swarm_freeze", {
    runId,
    recovery: { recovered: [], blocked: [] },
  });
  let r = await e.run(runId),
    p = r.swarm.participants[0];
  await e.internal("swarm", "swarm_participant_begin", {
    runId,
    participantId: p.participantId,
    attemptId: "swarm-att",
    launch: launch(p, "swarm-att", {
      snapshotEpoch: 0,
      workerId: "w-swarm-att",
    }),
  });
  await e.internal("swarm", "bind_attempt", {
    runId,
    attemptId: "swarm-att",
    porchRunId: "run_porch_swarm",
  });
  await e.internal("swarm", "swarm_cursor", {
    runId,
    attemptId: "swarm-att",
    cursor: 2,
  });
  assert.equal((await e.run(runId)).attempts[0].commandCursor, 2);
  await e.internal("swarm", "swarm_observed", {
    runId,
    attemptId: "swarm-att",
    outcome: "failed",
    reason: "observed terminal",
  });
  await e.internal("swarm", "swarm_worker_settled", {
    runId,
    attemptId: "swarm-att",
    workerId: "w-swarm-att",
    state: "gone",
  });
  await e.user("swarm", "stop");
  await assert.rejects(
    () => e.internal("swarm", "complete_run", { runId, status: "cancelled" }),
    (x) => x.code === "attempt_active",
  );
  await e.internal("swarm", "resolve_attempt", {
    runId,
    attemptId: "swarm-att",
    outcome: "cancelled",
  });
  r = await e.run(runId);
  assert.equal(r.phase, "coordinate");
  assert.equal(r.swarm.protocol.participants.alpha.activeTurn, null);
  assert.equal(r.swarm.participants[0].status, "stopped");
  await e.internal("swarm", "complete_run", { runId, status: "cancelled" });
  assert.equal((await e.run(runId)).status, "cancelled");
});
test("completed swarm frame uses committed proposal descriptor and keeps coordination phase", async () => {
  const e = await env(),
    runId = await e.start("swarm");
  await e.internal("swarm", "swarm_claim", { runId });
  await e.internal("swarm", "swarm_freeze", {
    runId,
    recovery: { blocked: [] },
  });
  let r = await e.run(runId),
    p = r.swarm.participants[0];
  await e.internal("swarm", "swarm_participant_begin", {
    runId,
    participantId: p.participantId,
    attemptId: "frame-att",
    launch: launch(p, "frame-att", {
      snapshotEpoch: 0,
      workerId: "w-frame-att",
    }),
  });
  await e.internal("swarm", "bind_attempt", {
    runId,
    attemptId: "frame-att",
    porchRunId: "run_frame",
  });
  await assert.rejects(
    () =>
      e.internal("swarm", "resolve_attempt", {
        runId,
        attemptId: "frame-att",
        outcome: "completed",
      }),
    (x) => x.code === "swarm_result_invalid",
  );
  const text =
    "```acp-swarm\n" +
    JSON.stringify({
      goal: "Define allocation",
      declaration: {
        files: ["a.txt"],
        contracts: "shared export",
        approach: "owned file",
        risks: "none",
      },
      commands: [],
      outcome: "continue",
    }) +
    "\n```";
  const proposal = await e.artifact(
    "swarm",
    runId,
    "frame-att",
    "swarm-result",
    text,
  );
  await e.internal("swarm", "swarm_turn_result", {
    runId,
    attemptId: "frame-att",
    artifactId: proposal.artifactId,
  });
  await e.internal("swarm", "swarm_worker_settled", {
    runId,
    attemptId: "frame-att",
    workerId: "w-frame-att",
    state: "gone",
  });
  await assert.rejects(
    () =>
      e.internal("swarm", "resolve_attempt", {
        runId,
        attemptId: "frame-att",
        outcome: "completed",
        proposal: { ...proposal, sha256: "f".repeat(64) },
      }),
    (x) => x.code === "swarm_result_invalid",
  );
  await e.internal("swarm", "resolve_attempt", {
    runId,
    attemptId: "frame-att",
    outcome: "completed",
    proposal,
  });
  r = await e.run(runId);
  assert.equal(r.attempts[0].status, "completed");
  assert.equal(r.phase, "coordinate");
  assert.equal(r.swarm.participants[0].declaration.approach, "owned file");
  assert.equal(r.swarm.protocol.participants.alpha.activeTurn, null);
  await e.internal("swarm", "swarm_freeze", {
    runId,
    active: true,
    physicalConfirmed: true,
    identities: [],
    reason: "verify",
  });
  await assert.rejects(
    () =>
      e.internal("swarm", "swarm_materialized", {
        runId,
        epoch: 1,
        commitSha: git(e.project, "rev-parse", "HEAD"),
        treeSha: git(e.project, "rev-parse", "HEAD^{tree}"),
      }),
    (x) => x.code === "materialization_invalid",
  );
  await e.internal("swarm", "swarm_materialized", {
    runId,
    epoch: 0,
    commitSha: git(e.project, "rev-parse", "HEAD"),
    treeSha: git(e.project, "rev-parse", "HEAD^{tree}"),
    canonicalId: "fixture-canonical",
  });
  assert.equal((await e.run(runId)).swarm.materialized.epoch, 0);
  await assert.rejects(
    () =>
      e.internal("swarm", "swarm_phase", {
        runId,
        phase: "awaiting_validation",
      }),
    (x) => x.code === "convergence_pending",
  );
});
test("Orchestrator decomposition is artifact-bound, approved explicitly, and owns task transitions", async () => {
  const e = await env(),
    runId = await e.start("orchestrator");
  await e.internal("orchestrator", "orch_claim", { runId });
  let r = await e.run(runId);
  await e.internal("orchestrator", "orch_decompose_begin", {
    runId,
    attemptId: "decomp-att",
    launch: launch(r.orchestrator.decomposer, "decomp-att"),
  });
  await e.internal("orchestrator", "bind_attempt", {
    runId,
    attemptId: "decomp-att",
    porchRunId: "run_decomp",
  });
  const text = JSON.stringify({
    decomposition: {
      subtasks: [
        {
          id: "task-a",
          title: "Own a",
          outcome: "Update a",
          acceptanceCriteria: ["a remains present"],
          dependsOn: [],
          boundary: { paths: ["a.txt"] },
          worker: { profileId: "worker" },
          limits: { maxAttempts: 2, maxFixCycles: 3 },
        },
      ],
    },
  });
  const spec = await e.artifact(
    "orchestrator",
    runId,
    "decomp-att",
    "decomposition",
    text,
  );
  await assert.rejects(
    () =>
      e.internal("orchestrator", "resolve_attempt", {
        runId,
        attemptId: "decomp-att",
        outcome: "completed",
        spec: { ...spec, bytes: spec.bytes + 1 },
      }),
    (x) => x.code === "spec_unbound",
  );
  await e.internal("orchestrator", "resolve_attempt", {
    runId,
    attemptId: "decomp-att",
    outcome: "completed",
    spec,
  });
  r = await e.run(runId);
  assert.equal(r.phase, "decompose");
  assert.equal(r.orchestrator.graph.status, "approval_pending");
  assert.equal(r.orchestrator.spec.status, "pending");
  const approved = await e.user("orchestrator", "orch_approve", {
    runId,
    specSha256: r.orchestrator.spec.sha256,
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.json));
  r = await e.run(runId);
  assert.equal(r.phase, "work");
  assert.equal(r.orchestrator.tasks[0].state.status, "ready");
  const worker = r.orchestrator.workers.worker;
  await assert.rejects(
    () =>
      e.internal("orchestrator", "orch_task_begin", {
        runId,
        taskId: "task-a",
        kind: "verify",
        attemptId: "premature-verify",
        launch: launch(r.orchestrator.verifier, "premature-verify"),
      }),
    (x) => x.code === "task_state",
  );
  await e.internal("orchestrator", "orch_task_begin", {
    runId,
    taskId: "task-a",
    kind: "work",
    attemptId: "work-att",
    launch: launch(worker, "work-att", {
      inputCommit: r.baseCommit,
      snapshotOf: [],
    }),
  });
  await e.internal("orchestrator", "bind_attempt", {
    runId,
    attemptId: "work-att",
    porchRunId: "run_worker",
  });
  await e.internal("orchestrator", "resolve_attempt", {
    runId,
    attemptId: "work-att",
    outcome: "failed",
    reason: "fixture terminal failure",
  });
  r = await e.run(runId);
  assert.equal(r.phase, "work");
  assert.notEqual(r.orchestrator.tasks[0].state.status, "accepted");
  assert.equal(r.attempts.at(-1).status, "failed");
});
test("Fusion callback stays in panel and all modes refuse premature Core validation/acceptance", async () => {
  const e = await env();
  for (const mode of ["fusion", "orchestrator", "swarm"]) {
    const runId = await e.start(mode);
    await assert.rejects(
      () =>
        e.internal(mode, "begin_validation", {
          runId,
          validationId: "val_fixture",
        }),
      (x) => x.code === "validation_state",
    );
    const a = await e.user(mode, "accept_result", {
      runId,
      resultSha256: "a".repeat(64),
    });
    assert.notEqual(a.status, 200);
    if (mode === "fusion") {
      let r = await e.run(runId);
      await e.internal(mode, "panel_claim", { runId });
      const p = r.fusion.participants[0];
      await e.internal(mode, "panel_begin", {
        runId,
        participantId: p.id,
        attemptId: "panel-att",
        launch: launch(p, "panel-att"),
      });
      await e.internal(mode, "bind_attempt", {
        runId,
        attemptId: "panel-att",
        porchRunId: "run_panel",
      });
      await e.internal(mode, "resolve_attempt", {
        runId,
        attemptId: "panel-att",
        outcome: "failed",
        reason: "fixture terminal failure",
      });
      r = await e.run(runId);
      assert.equal(r.phase, "panel");
      assert.equal(r.attempts[0].role, "panelist");
      assert.equal(r.fusion.participants[0].status, "pending");
      assert.equal(r.fusion.participants[0].attemptsUsed, 1);
    }
  }
});
import {
  createWorkspace,
  workspacePath,
  workspaceBranch,
  projectKeyFor,
} from "../server/execution/workspaces.mjs";
test("Swarm convergence reaches actual Core reservation and cannot accept or terminalize before validation settles", async () => {
  const e = await env(),
    runId = await e.start("swarm");
  await e.internal("swarm", "swarm_claim", { runId });
  await e.internal("swarm", "swarm_freeze", {
    runId,
    recovery: { blocked: [] },
  });
  async function turn(id, tag, commands, outcome = "continue") {
    let r = await e.run(runId),
      p = r.swarm.participants.find((p) => p.participantId === id);
    await e.internal("swarm", "swarm_participant_begin", {
      runId,
      participantId: id,
      attemptId: tag,
      launch: launch(p, tag, { snapshotEpoch: 0, workerId: `w-${tag}` }),
    });
    await e.internal("swarm", "bind_attempt", {
      runId,
      attemptId: tag,
      porchRunId: `run_${tag.replaceAll("-", "_")}`,
    });
    const cmds = await commands(tag);
    for (const [i, command] of cmds.entries())
      await e.internal("swarm", "swarm_protocol", {
        runId,
        attemptId: tag,
        commandId: `frame-${tag}-${i}`,
        command,
      });
    const text =
      "```acp-swarm\n" +
      JSON.stringify({
        goal: "Finish own scope",
        declaration: {
          files: ["a.txt"],
          contracts: "agreed allocation",
          approach: "own path",
          risks: "none",
        },
        commands: cmds,
        outcome,
      }) +
      "\n```";
    const proposal = await e.artifact(
      "swarm",
      runId,
      tag,
      "swarm-result",
      text,
    );
    await e.internal("swarm", "swarm_turn_result", {
      runId,
      attemptId: tag,
      artifactId: proposal.artifactId,
    });
    await e.internal("swarm", "swarm_worker_settled", {
      runId,
      attemptId: tag,
      workerId: `w-${tag}`,
      state: "gone",
    });
    await e.internal("swarm", "resolve_attempt", {
      runId,
      attemptId: tag,
      outcome: "completed",
      proposal,
    });
  }
  await turn("alpha", "coord-alpha", async (tag) => {
    const command = {
      type: "open_decision",
      id: "allocation",
      scope: { kind: "global" },
      text: "Alpha owns a, Bravo reviews interface",
    };
    await e.internal("swarm", "swarm_protocol", {
      runId,
      attemptId: tag,
      commandId: `frame-${tag}-0`,
      command,
    });
    const d = (await e.run(runId)).swarm.protocol.decisions.allocation,
      rev = d.revisions.at(-1);
    return [
      command,
      {
        type: "ack_decision",
        decisionId: d.id,
        rev: rev.rev,
        revHash: rev.revHash,
      },
    ];
  });
  await turn("bravo", "coord-bravo", async () => {
    const d = (await e.run(runId)).swarm.protocol.decisions.allocation,
      rev = d.revisions.at(-1);
    return [
      {
        type: "ack_decision",
        decisionId: d.id,
        rev: rev.rev,
        revHash: rev.revHash,
      },
    ];
  });
  await e.internal("swarm", "swarm_phase", { runId, phase: "implement" });
  await turn("alpha", "done-alpha", async () => [], "done");
  await turn("bravo", "done-bravo", async () => [], "done");
  let r = await e.run(runId);
  await e.internal("swarm", "swarm_freeze", {
    runId,
    active: true,
    physicalConfirmed: true,
    identities: [],
    reason: "verify",
  });
  await e.internal("swarm", "swarm_materialized", {
    runId,
    epoch: 0,
    commitSha: r.baseCommit,
    treeSha: git(e.project, "rev-parse", "HEAD^{tree}"),
    canonicalId: "fixture-canonical",
  });
  await e.internal("swarm", "swarm_phase", {
    runId,
    phase: "awaiting_validation",
  });
  r = await e.run(runId);
  assert.equal(r.swarm.phase, "verify");
  assert.equal(r.phase, "awaiting_validation");
  const wsId = "ws-wiring",
    branch = workspaceBranch("swarm", wsId),
    path = workspacePath(
      join(e.root, "workspaces"),
      projectKeyFor(e.project),
      "swarm",
      wsId,
    );
  await e.internal("swarm", "begin_workspace", {
    runId,
    workspaceId: wsId,
    branch,
    path,
    baseCommit: r.baseCommit,
  });
  await createWorkspace({
    sourcePath: e.project,
    targetPath: path,
    branch,
    baseCommit: r.baseCommit,
  });
  await e.internal("swarm", "workspace_ready", {
    runId,
    workspaceId: wsId,
    head: r.baseCommit,
  });
  await e.internal("swarm", "begin_validation", {
    runId,
    validationId: "val_wiring",
  });
  r = await e.run(runId);
  assert.equal(r.validation.status, "active");
  assert.equal(r.validation.phase, "prepare");
  assert.equal(r.mode, "swarm");
  const accept = await e.user("swarm", "accept_result", {
    runId,
    resultSha256: "a".repeat(64),
  });
  assert.equal(accept.status, 409);
  assert.equal(accept.json.code, "not_acceptable");
  await assert.rejects(
    () => e.internal("swarm", "complete_run", { runId, status: "succeeded" }),
    (x) => x.code === "validation_active",
  );
  await assert.rejects(
    () =>
      e.internal("swarm", "swarm_participant_begin", {
        runId,
        participantId: "alpha",
        attemptId: "illegal-during-checks",
        launch: launch(r.swarm.participants[0], "illegal-during-checks", {
          snapshotEpoch: 0,
        }),
      }),
    (x) => ["swarm_frozen", "validation_active"].includes(x.code),
  );
});
