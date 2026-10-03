# P0 — Idea Preparation: feasibility of source skills + document environment

Date: 2026-10-02. Branch `feat/agent-modes`. Author: Devin (SWE-2 Max), single executor.
Scope: **only** P0 feasibility of `docs/plans/agent-idea-preparation-plan.md` (P0, KTD2–KTD7, Verification Contract). No P1 session/state/API/UI. No `start_preparation`.

## Verdict

**P0 DONE.** All six candidate bindings were exercised end-to-end through the real pi RPC path against installed, hash-pinned skill sources, inside isolated private document workspaces. Every declared expectation was observed live (real Q&A, blocking UI dialogs, document writes, workspace git commits, abort→resume). Six additional routes are registered **unsupported** with named reasons and refuse before spawning — no silent fallback anywhere.

**Post-acceptance hardening (same day, before P0 acceptance):** a containment defect — in-workspace symlinks (and relative `..` traversal) laundered escapes because `checkToolCall` and the pi extension compared *lexically* resolved paths — was reproduced, fixed RED→GREEN in both policy implementations, and re-proven with a bounded real pi extension smoke that attempted the escape live (`smoke2-symlink-escape-smoke`, run against the final tree). Details in *Containment hardening* below.

## Binding table

| Binding | Source (manifest digest, files) | Declared route | Observed capabilities | Probe / run dir | Limits | Verdict |
|---|---|---|---|---|---|---|
| `grill-me-intent` | `~/.pi/agent/skills/grill-me` + shared `grilling.md` `042452bf…` (2) | stateless intent interview | 2 chat question rounds; **abort→resume verified**; no writes (by design) | `probe grill-me-intent` → `…16-55-40-746Z-grill-me-intent` | stateless — no artifacts, no commits | **available** |
| `grill-with-docs` | `~/.pi/agent/skills/grill-with-docs` `11c5d656…` (5) | grilling + inline domain-model writes | 2 chat question rounds; wrote `CONTEXT.md` in workspace | `…16-57-29-710Z-grill-with-docs` | ADR offer conditional (none earned) | **available** |
| `ce-brainstorm` | CE 3.24.0 `…/skills/ce-brainstorm` `b6a7ba03…` (26) | requirements-only unified plan | **8 extension_ui dialogs** (select+input); wrote `docs/plans/2026-10-02-1703-feat-saved-filter-views-plan.md` with `ce-unified-plan/v1` + `requirements-only` frontmatter | `…17-00-41-374Z-ce-brainstorm` | none seen | **available** |
| `ce-plan` | CE `ce-plan`+`ce-doc-review` `4f5c3ae6…` (65) | durable implementation-ready plan | 3 UI dialogs; flipped the plan to `implementation-ready`; handoff menu rendered | `…17-04-07-365Z-ce-plan` | model reported *"ce-doc-review could not be invoked (no skill-invocation mechanism in this harness)"* — intra-skill dispatch absent; review covered by standalone binding instead | **available** (handoff degraded, honestly reported) |
| `ce-doc-review` | CE `ce-doc-review` `4924b7ca…` (27) | non-interactive document review | full persona review inline; structured non-interactive result; doc judged adequate (0 fixes) | `…17-08-55-989Z-ce-doc-review` | cross-model pass not present (see unsupported) | **available** |
| `superpowers-architectural` | `~/.hermes/plugins/superpowers` brainstorming+writing-plans `0f4beb6f…` (10) | brainstorm→spec commit→writing-plans chain | 10 UI dialogs + 2 chat Q; spec `docs/superpowers/specs/…-design.md`, plan `docs/superpowers/plans/…md`; **4 real workspace git commits**; stopped at execution-handoff gate | `…17-11-33-080Z-superpowers-architectural` | ends at handoff choice by contract | **available** |

All runs: pi 0.85.1, provider `zen-relay`/`muse-spark-1.3-contributor-free`, isolated `PI_CODING_AGENT_DIR` + session dir per run, explicit `--skill`/`-e`/`--tools` (no discovery), cwd = private git workspace.

### Registered unsupported routes (fail-closed, no fallback)

| Binding | Reason code | Route |
|---|---|---|
| `ce-work` | `implementation_authority_denied` | ce-plan 5.4 menu — preparation records the offer; never launches it |
| `superpowers-execution-handoffs` | `implementation_authority_denied` | writing-plans terminal handoff |
| `ce-pov` | `route_out_of_scope` | ce-brainstorm verdict routing — explicit user selection only |
| `ce-doc-review-cross-model` | `external_peer_egress_unproven` | provider-CLI judgment pass (additive/non-blocking per skill contract) |
| `superpowers-visual-companion` | `browser_surface_out_of_scope` | just-in-time mockup helper |
| `ce-slack-researcher` | `capability_absent` | no Slack/MCP tools installed; skill's "No tools" contract is a named note |

Proof: `node scripts/preparation_binding_probe.mjs probe ce-work` → exit 1, `{"code":"route_unsupported", …}`, **no run dir created, no pi spawned**. Also covered deterministically in the test suite.

## What was built (P0 artifacts only)

- `server/execution/preparation/skills/registry.mjs` — binding schema, resource manifest pin/verify (sha256 per file, digest over the set), fail-closed codes (`unknown_binding`, `route_unsupported`, `route_unproven`, `resources_unpinned`, `resource_missing`, `resource_mismatch`, `binding_expectations_failed`), workspace containment policy (`checkToolCall`), verdict evaluation.
- `server/execution/preparation/skills/bindings.json` — 12 bindings, all resource manifests **pinned** (153 files total across CE/Grill/Superpowers dirs; digests in table).
- `server/execution/preparation/skills/pi-ext/preparation-bridge.ts` — pi extension: `ask_user` blocking question tool (→`extension_ui_request`, never fabricates answers — dismissal returns `NO_USER_ANSWER`), pre-execution `tool_call` containment (write/edit→write-roots, read→read-roots, bash path tokens + mutating-git scope + denylist incl. `git push|remote|config`), JSONL audit log.
- `scripts/preparation_binding_probe.mjs` — `pin|verify|audit|probe|list`; spawns real `pi --mode rpc` with scoped agent dir/sessions/workspace, scripts chat answers + UI policy, tracks abort/resume, writes verdict.json + transcript.jsonl + audit.jsonl + session.html + stderr per run.
- `scripts/test_preparation_binding.mjs` — 18 deterministic tests (node:test): schema, manifest round-trip/drift/missing/added, route gating, write/read/bash/git containment, **symlink/traversal hardening**, verdicts, refuse-before-spawn.
- `scripts/preparation_symlink_smoke.mjs` — bounded real-pi escape smoke (planted `escape -> ../outside`, scripted read/write/`ln -s`/`cat ..` attempts, pass = all blocked pre-execution + `outside/` intact).
- Run evidence (raw): `~/.cache/acp-p0/<ts>-<bindingId>/{artifacts,workspace,sessions,agent}` — transcript, audit, verdict, exported HTML, resulting workspace files.

## Measured

- **Blocking question channel**: `ask_user` tool → `extension_ui_request` → `extension_ui_response` round-trip — 21 real dialogs across ce-brainstorm (8), ce-plan (3), superpowers (10). Dismissal path exercised (ce-plan menu cancel rule exists; models rendered terminal menus in chat).
- **Chat channel**: grill-me/grill-with-docs ran multi-round interviews with decision frontiers.
- **Documents**: real writes inside private workspaces only — plan md (CE frontmatter verified), `CONTEXT.md`, spec+plan (superpowers). Zero writes to the target repo (`repoStatusUnchanged: true` every run; final `git status` diff = only the 5 new P0 files).
- **Git**: 4 real commits in the superpowers workspace (spec, spec-revise, plan, persona-revise) — bash `git add/commit` allowed in-workspace, `git push/remote/config` denied by policy.
- **Stop/restart**: `abort` command → `success:true` mid-interview, session continued with next answer (`interrupt:{aborted:true,resumed:true}` in grill-me run). Cross-process `--resume`/`get_entries` cursor: **not exercised** (see Not measured).
- **Source integrity**: `verify all` re-pinned clean before AND after all probes (`resourcesIntact:true` per run; 12/12 ok). No upstream file changed.
- **Deterministic tests**: 18/18 pass (incl. 5 post-fix hardening cases). `npm run build:web` exit 0.
- **Unsupported proof**: `ce-work` probe refused pre-spawn, exit 1, no fallback.

## Not measured / known limits

- Cross-process resume (`pi --resume` + `get_entries` cursor on a restarted session) — in-session abort→continue proven; durable-cursor resume is P1.
- ce-plan → ce-doc-review *in-session* handoff: model-reported absence of an intra-skill dispatch primitive; ce-doc-review proven as its own user-invoked binding. P1 should surface the handoff as an explicit host choice, not rely on skill-internal dispatch.
- Each binding ran once; model behavior is nondeterministic (scripts bound the variance, verdicts are about route mechanics not content quality).
- `get_entries`-based audit-replay correctness of the porch adapter (`pi-rpc-boundary.mjs`) unchanged and not re-tested here.
- Reviewer-UI surfacing of artifacts (browser) is P1; P0 proves the files are written/readable in the workspace.

## Conclusions for P1

1. The extension `ask_user` + `tool_call` containment pair is the minimal viable host surface for all three skill families — keep it as the preparation boundary.
2. Route the ce-plan handoff (ce-doc-review/ce-work options) through an explicit host menu keyed to registered bindings; do not let skills self-dispatch.
3. Status model works: `candidate` → `available` only by green probe; `unsupported` never spawns. P1 wiring should call `assertRouteAvailable` at route selection time.
4. Bash containment held (denylist + path audit + git-scope); keep the denylist narrow as now — skills legitimately need `git add/commit` and `ls/cat` inside the workspace.

## Changed files (all new; nothing else touched)

`server/execution/preparation/skills/{registry.mjs,bindings.json,pi-ext/preparation-bridge.ts}`, `scripts/{preparation_binding_probe.mjs,test_preparation_binding.mjs,preparation_symlink_smoke.mjs}`, this report. `git status --short` final vs baseline `/tmp/p0-git-status-initial.txt`: +6 entries — `BRIEF_P0_CONTAINMENT.md` (pre-existing P0 brief), `docs/reports/agent-idea-preparation-p0.md`, `scripts/preparation_binding_probe.mjs`, `scripts/test_preparation_binding.mjs`, `scripts/preparation_symlink_smoke.mjs`, `server/execution/preparation/`; all 98 pre-existing dirty/untracked entries preserved.

## Commands / checks

```
node scripts/preparation_binding_probe.mjs pin all        # 12 manifests pinned
node scripts/preparation_binding_probe.mjs verify all     # 12/12 ok (pre+post probes)
node scripts/preparation_binding_probe.mjs probe <id>     # 6 runs → pass, artifacts saved
node scripts/preparation_binding_probe.mjs probe ce-work  # exit 1 route_unsupported
node --test scripts/test_preparation_binding.mjs          # 18/18 pass
node scripts/preparation_symlink_smoke.mjs                # pass — 4/4 escapes blocked live
npm run build:web                                         # exit 0
```

## Containment hardening — document-workspace symlink escape (fixed 2026-10-02)

**Defect.** `checkToolCall` (`registry.mjs`) and the in-process `tool_call` hook (`preparation-bridge.ts`) compared *lexically* normalized paths. A symlink planted inside the private workspace (`workspace/escape -> ../outside`) therefore passed policy for read, write, and edit — `checkToolCall('write', {path:'escape/pwned.txt'})` returned `allow:true`, resolved to `outside/pwned.txt` at the kernel. Same hole for absolute spellings and for bare relative `..` traversal (`edit '../outside/x.md'` → `allow`). Prior probe evidence reported zero violations only because no path case exercised a symlinked component.

**Fix (both layers, same policy).** `realpathNearest()` canonicalizes targets the way the kernel will: every existing component followed through symlinks (`fs.realpathSync`), a non-existent tail resolved under the canonical nearest existing ancestor, a dangling symlink followed through its own link target — and any resolution error (ELOOP/EACCES/…) fails closed. Applied to write/edit/read targets, bash absolute-path tokens, and a new segment-aware bash audit: separators/pipes/subshells/substitutions split segments, `cd`/`pushd` are tracked so relative operands resolve where they would run, `>`/`<` redirect targets carry write/read floors, `ln|cp|mv|install|rm|tee|sed -i|tar -C …` operands carry write floors, `--flag=path` values are checked, `~` is blocked outright, and un-auditable code surfaces (`bash -c`, `python -c`, `awk`, `xargs`/`watch` program strings, `find -exec`, `npm run`, `make`, `npx`, `chroot`, …) fail closed. `resolveRoots` canonicalizes roots too, so a symlinked root cannot alias.

**RED evidence.** 5 new tests failed before the fix (`/tmp/p0-symlink-red.txt`): relative `..` traversal, existing symlink→outside (write+read, rel+abs), symlinked parent + nonexistent destination, dangling-symlink write target, and bash `ln -s`/redirect/`cd`/chained-link/interpreter escapes — 11 failing assertions total.

**GREEN evidence.** `node --test scripts/test_preparation_binding.mjs` → **18/18 pass** (5 new hardening tests + safe-behavior retention: in-root symlinks still allowed, `docs/../in.md`, `ln -s` inside workspace, `cd` into subdirs, workspace redirects). `probe verify all` → 12/12 ok; `audit all` → 12/12 ok; `npm run build:web` → exit 0. No deny weakened.

**Live extension proof.** `node scripts/preparation_symlink_smoke.mjs --run smoke2` spawned real `pi --mode rpc -e preparation-bridge.ts` (zen-relay/muse-spark, `--tools read,write,edit,bash`, private workspace with a planted `escape -> ../outside` link + `outside/secret.txt`). The model attempted all four scripted escapes; the in-process hook blocked every one *before execution* — `tool_execution_end isError:true` carrying the block reason, extension `audit.jsonl` `blocked:true` ×4, `outside/` byte-identical, no `escape2` minted. Verdict **pass**, 1 prompt, run against the final tree. A direct fake-pi harness (`/tmp/p0-ext-check.mjs`) additionally exercised the final hook over 16 cases: 10 blocks (symlink read/write, `../outside` edit, `ln -s` escapes, chained-link/cat/cd/redirect reads, `bash -c`) + 6 legitimate allows (`/dev/null` redirect sinks, in-workspace writes, in-root symlink reads). Evidence: `~/.cache/acp-p0/smoke2-symlink-escape-smoke/artifacts/{verdict.json,audit.jsonl,transcript.jsonl,stderr.log}` (earlier identical pass at `smoke1-symlink-escape-smoke`, pre-`/dev/null`-refinement).

| Attempted escape | Blocked reason (exact, from audit.jsonl) |
|---|---|
| `read escape/secret.txt` | `read target escape/secret.txt resolves outside registered roots (…/outside/secret.txt)` |
| `write escape/pwned.txt` | `write target escape/pwned.txt resolves outside the document workspace (…/outside/pwned.txt)` |
| `bash ln -s ../outside escape2 && cat escape2/secret.txt` | `bash path ../outside resolves outside allowed roots (…/outside)` |
| `bash cat ../outside/secret.txt` | `bash path ../outside/secret.txt resolves outside allowed roots (…/outside/secret.txt)` |

## Residual risks / next owner

- Residual: single-run evidence; prompt-injection resistance of skill text itself (skill content is untrusted input to the model — containment bounds the blast radius, not the prose).
- Residual: bash audit is heuristic — script *files* executed inside the workspace (`node script.js`, `bash script.sh`, sourced files) and indirection via `$VAR`/xargs-fed paths are not deep-audited; the write/read/edit tool layer is the hard boundary, bash is defense-in-depth bounded by operand canonicalization.
- Next owner: P1 session/state/API design — consume `bindings.json` + `assertRouteAvailable`, reuse `resolveRoots`/`checkToolCall` for the controller-side guard, decide `--resume` cursor handling.
