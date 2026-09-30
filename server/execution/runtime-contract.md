# Execution runtime contract (U1)

Scope: a reusable, import-safe adapter that starts, observes, and cancels
`porch delegate` runs inside the runner environment, plus a deterministic
in-memory fake with the same surface for controller tests. No HTTP listener,
no scheduler, no card dispatch — those belong to later units.

Modules (all under `server/execution/`, ESM, zero deps):

- `common.mjs` — `spawnBounded` (no shell, bounded time + output, descendant
  pipe-handle proof), atomic writes, id/path validation, stderr→code mapping.
- `porch-runtime.mjs` — `createPorchRuntime(opts)` process backend.
- `fake-runtime.mjs` — `createFakeRuntime(opts)` scripted backend.

## Factory options

```
createPorchRuntime({
  rootDir,            // execution root; default: $ACP_EXEC_DIR
                      //   || $STATE_DIR/execution
                      //   || ~/.hermes/acp-ui-state/execution
  porchPath,          // default: $ACP_PORCH_CLI
                      //   || ~/.pi/agent/skills/pragmatic-orchestration/scripts/porch
  env,                // base env for children (default process.env)
  namespace,          // label recorded in attempt metadata
  launchTimeoutMs,    // detach handshake bound (default 30s)
  controlTimeoutMs,   // status/events/cancel/list bound (default 20s)
  maxResultBytes,     // wait payload cap (default 8 MiB, carries full answer)
  maxControlBytes,    // status/events/cancel/list payload cap (default 1 MiB)
})
// Truncated JSON never returns silently: a capped payload fails JSON parse
// and surfaces as an error result (e.g. wait → outcome 'error',
// error.code 'parse_error'/'cli_failed').
```

Layout created under `rootDir`: `steer/` (PORCH_STEER_DIR registry),
`outputs/` (PORCH_OUTPUT_DIR), `attempts/<attemptId>/` containing
`prompt.md`, `porch-config.json`, `artifacts/` (PORCH_RUN_DIR), and
`launch.json` (attempt record: identity, argv, diagnostics, outcome).

## Child env contract

Children inherit the base env minus: every `PORCH_*` var (registry, output,
run-dir, config, bin and debug routing are owned by the runtime), the
per-backend model/effort overrides (`CODEX_MODEL`, `CODEX_EFFORT`,
`CLAUDE_*`, `OPENCODE_*`, `GROK_*`, `GEMINI_MODEL`, `DEVIN_MODEL`,
`PI_MODEL`, `PI_PROVIDER`), and `ACP_BACKEND`. `params.env` extras pass
through the same filter and cannot reintroduce dropped keys. Runtime then
sets `PORCH_STEER_DIR`, `PORCH_OUTPUT_DIR`, `PORCH_SAVE_OUTPUTS=1`, and for
launches `PORCH_RUN_DIR`, `PORCH_CONFIG` (the attempt snapshot), and
`PORCH_PI_SESSION_ID=acp-<attemptId>` (pi keys sessions by cwd + id; the
default basename would collide across attempts in one worktree).

## start(params)

```
start({
  attemptId,     // safe id, unique per attempt (dir create is exclusive)
  profileId,     // exact porch agent id (no globs)
  cwd,           // existing absolute task worktree
  prompt | promptFile,          // one required; both land in prompt.md
  config | configPath,          // REQUIRED explicit profile snapshot;
                                //  copied into the attempt dir, never a
                                //  mutable pointer to the global config
  env, launchTimeoutMs,
})
```

Launch command: `porch delegate -a <profileId> --detach --prompt-file
<attemptDir>/prompt.md` with `cwd` = the task worktree. No `--cwd`/`--model`
flags exist on porch and none are invented.

Result `phase`:

| phase | meaning |
|---|---|
| `launched` | exit 0 + valid `run_*` id on stdout → `porchRunId` set |
| `launch_failed` | spawn error / pre-launch validation / porch nonzero exit before handshake — no live supervisor per porch contract |
| `launch_uncertain` | handshake timeout, signal, or exit 0 without an id — a setsid'd supervisor may still register the run; reconcile before any retry |

`launch.json` records the outcome and environment identity at every step. A
persistence failure after a live launch is reported via `recordPersisted:
false` — it never rewrites a possibly-live run as safely-failed.

## observe

- `status(runId)` → `{ ok, status, terminal, exitCode, error, agentId,
  backend, model, pid, process, startedAt, finishedAt, mailboxClosed, … }`.
  `process` = `{pid, starttime, pidNs, alive}` probed from `/proc` — compare
  all three before trusting liveness of a remembered pid (PID reuse and pid
  namespaces make a bare number meaningless).
- `events(runId, {cursor, maxEvents})` → `{ events, cursor, nextCursor,
  remaining, terminal, status, exitCode, cursorReset }`. Cursor starts at 0
  and walks forward — full history, no implicit tail-only snapshot.
- `wait(runId, {timeoutSec})` → `outcome: 'terminal' | 'timeout' | 'error'`.
  Timeout (`--timeout` inside porch, exit 124) is "still running", carries a
  status snapshot + recent events — never an error and never a cancel.
  Terminal carries the full `finalText` (not the status preview),
  `finalAvailable`, derived `exitCode` (0 completed / 130 cancelled / 70
  supervisor dead / 74 no answer / backend code). `observer_timeout` means
  our own kill deadline fired — run untouched.

## cancel

`cancel(runId)` → `{ requested: true }` only when porch accepted the cancel
envelope. Nonzero exits map to `already_terminal` / `unknown_run` /
`supervisor_dead` / `uid_mismatch` etc. Cancellation is always by run id
through the registry — never by PID signal — so a recycled pid or foreign
namespace cannot be hit. `requested: true` means "cancel filed"; terminal
state must still be awaited via `wait`/`status`.

## reconcile(match)

`list --all --limit 0 --json` underneath. Every supplied selector must
match (AND): `runIds`, `artifactsDir` (the per-attempt unique dir — the
strongest proof), `cwd`. A stale run in the same worktree does not satisfy a
query scoped by artifactsDir. Zero matches only proves "nothing live in this
registry"; a retry additionally needs proof the launcher exited.

## environment()

`{ namespace, backend, uid, gid, pid, pidStarttime, pidNs, hostname, bootId,
platform, node, rootDir, steerDir, outputDir, attemptsDir, porchPath }`.
`pidNs` = `/proc/self/ns/pid` link, `pidStarttime` = `/proc/self/stat`
field 22; together with hostname + bootId they distinguish a container
recreate (new pid ns, same hostname, same host boot) from a same-container
process restart (new starttime). The porch registry additionally enforces
run-dir `owner_uid == current uid`, so observation and control MUST run under
one uid; a worktree is a file boundary, not a security sandbox.

## Errors

Invalid arguments throw `RuntimeError` (`invalid_argument`,
`invalid_run_id`, `attempt_exists`, …). Runtime outcomes resolve into
result objects — `{ ok: false, error: { code, message, stderrTail? } }` —
with stable codes: `unknown_run`, `already_terminal`, `supervisor_dead`,
`uid_mismatch`, `config_error`, `command_timeout`, `spawn_error`,
`parse_error`, `cli_error`.

## Fake backend

`createFakeRuntime({ behaviors: { default, byProfile, byAttempt } })` —
same method surface and result shapes; scripted `launch`, `outcome`,
`delayMs`, `finalText`, `events`, `onCancel`. Validation matches on
identifier syntax; `cwd` must be absolute but is not stat'ed. `_runs` /
`_force` are the test seams.
