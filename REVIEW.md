VERDICT: APPROVE_WITH_NITS

Reviewed `git diff 2e077b9..HEAD` on `cc/workflow` against PLAN.md §1–§9.
Ran `node scripts/test_workflow_porch.mjs` (50/50 pass, node type-stripping
works) and `npm run build:web` (vue-tsc + vite, green, 4.77s). Read every
changed file end-to-end plus the referenced house conventions
(storage.ts, secure.ts, ChatView.vue, acp-state-server.mjs porch handler).

## Blocking issues

None.

## Nits

1. `src/components/WorkflowView.vue:27` — mount/unmount race leaks the
   poller. `wf.initWorkflowStore().then(() => wf.startPolling())`: if the
   view unmounts before `loadKvStore` resolves (worst case ~1.5–5.5 s when
   the state server is down — probe + fetchDoc timeouts), `onBeforeUnmount`
   → `stopPolling()` runs while `timer === null` (no-op), then the `.then`
   still fires `startPolling()` — an orphaned 2 s interval lives for the
   rest of the session (the Pinia store outlives the component). Low impact
   (read-only GETs; when the probe cached `false` it's a cheap no-op loop),
   but it breaks the "poll only while mounted" contract. Fix: a local
   `let disposed = false` flag checked in the `.then`, or have the store own
   start/stop idempotently.

2. `src/lib/porch/api.ts:42-57` — `probePorch()` caches a `false` verdict
   forever. If the state server is down at first mount and comes up later,
   the view is stuck at "Porch endpoint unreachable" until reload — every
   tick short-circuits on the cached promise. Same convention as
   `probeStateServer` (storage.ts:117-135), so it's parity, not a
   regression; but a poll-driven view is the place where re-probing a
   failed result would actually pay off. Consider `if (await healthProbe)
   return true; healthProbe = null;`-style retry-on-false.

3. `src/lib/porch/audit.ts:174-179` vs `src/lib/porch/status.ts:40-45` —
   `metaFailed`/`isFailure` are the same terminal-failure predicate
   duplicated in two modules. Consistent today; will drift. Export one.

4. `src/lib/porch/event-blocks.ts:105-108` (and 66-72) — `completeTool` /
   the repeated-start update overwrite `truncated` from the *latest*
   payload only. A tool card whose input preview was `…`-truncated loses
   the flag when an untruncated output lands. Cosmetic.

5. `src/lib/porch/event-blocks.ts:95-101` — positional fallback tracks only
   `lastOpenKey`. With two open tools, a *keyed* completion nulls
   `lastOpenKey`, so a later unkeyed completion produces a standalone done
   block while the older tool sits at `started` forever. Dead-ish path on
   this host (only opencode emits `tool_completed`, always with call_id),
   but the comment "positional pairing" oversells it — it's last-open
   pairing.

6. `src/stores/workflow.ts:201-206` — on `getRun` 404, `detail`/`events`
   are cleared but `runStatus`/`lastAuditSize` are not. A pinned run that
   falls out of the registry keeps its last status; if it was `stale`, the
   "no recent output" banner lingers over an empty stepper (`staleText`
   falls back to the generic string when `meta` is gone).

7. `src/stores/workflow.ts:209` — `auditGrew` computes
   `lastAuditSize === null || size !== lastAuditSize`. A run whose
   `audit` is `null` every poll keeps `lastAuditSize === null` → `auditGrew`
   is always true → such a run can never go `stale`. Edge case (audit.jsonl
   is always present for registered runs); consider treating "both sides
   null twice" as not-grown.

8. `src/stores/workflow.ts:241-246` — `selectRun` → `void tick()` is a
   silent no-op while a tick is in flight (`ticking` guard), so a pinned
   run's detail loads on the next interval (≤2 s). Harmless, mildly laggy.

9. `src/features/workflow/WorkflowBlock.vue:26` — `marked`+`v-html` is
   unsanitized, identical to ChatView.vue:755/863/903 (same trust level:
   agent output; `marked` passes raw HTML through). Parity confirmed per
   PLAN §6's condition — flagging only so the inherited XSS surface is on
   record for both views.

10. `src/stores/workflow.ts` — `detail.state` (state.json) is fetched every
    2 s and never read (steers/`active_tools` unused). Tiny payload;
    noting as known-dead data, not a defect.

11. `scripts/test_workflow_porch.mjs:86` — test name mixes Cyrillic
    ("completed без final.txt"). Harmless; inconsistent with the file's
    English naming.

## What I verified

- **Scope**: `git diff --name-only 2e077b9..HEAD` — only allowed paths
  (WorkflowView.vue, src/lib/porch/*, src/stores/workflow.ts,
  src/features/workflow/*, test + fixtures + PLAN/REPORT). No forbidden
  file touched; App.vue's `v-if` seam (App.vue:691) is from the base
  commit.
- **kind→type map** (audit.ts:28-52): all 24 entries match PLAN §1.3
  verbatim, including `tool`/`tool_start`/`tool_started` → `tool_started`
  and `error` → `run_failed`.
- **steer_ack** (audit.ts:117-126): `data_preview` split at first `:`,
  known-status check against the 16-member set, `steer_request_sent`
  fallback — matches §1.3/§4.2.
- **Supervisor lines** (audit.ts:147-172): `steer_result` →
  `steer_<status>` (+error/evidence as data), `steer_ack_reconcile` →
  `steer_<new_status>` (unknown → skipped), `supervisor_error` →
  `run_failed`, `open_messages_failed_on_terminal` → `steer_failed`.
- **Tool fields** (audit.ts:95-110): `JSON.parse` first, regex
  `/"tool"\s*:\s*"([^"]+)"/` + `call_id` fallback — the truncation-safe
  path §1.2 requires; covered by a real test (test_workflow_porch.mjs:153).
- **kind:"tool"** (audit.ts:133-138): preview becomes `toolName`,
  `data=null` — "Ran ls" doesn't render twice.
- **Bookends** (audit.ts:212-227): `run_started` always prepended from
  `meta.started_at`; terminal `run_completed`/`run_failed` appended only
  when no terminal event was seen and meta is terminal.
- **deriveRunStatus** (status.ts:47-68): terminal → `failed` on
  failed/cancelled/nonzero exit_code/non-empty error, else `done`;
  `stale` requires BOTH `updated_at` older than 3 min AND `!auditGrew`;
  missing meta → `active`; `final` never consulted — the deliberate
  drop of Paseo's `done-pending` is implemented and documented.
- **Stepper rule** (graph.ts:102-107 + WorkflowStepper.vue:24-28): last
  matched node = active, before = done, after = idle; on terminal runs the
  last node renders `done` — matches PLAN §2's addition.
- **Pairing** (event-blocks.ts:57-123): by `toolId` when present,
  positional otherwise; repeated `tool_started` for one call_id updates in
  place — matches the opencode pending→running double-emit.
- **Server contract**: `acp-state-server.mjs:110-148` — `audit.size` is the
  full file size (`st.size`), `truncated = start > 0`, partial first line
  dropped server-side; `runs` sorted `startedAt` desc (line 107). The
  client assumptions hold.
- **Node-safety**: grep over `src/lib/porch/` — `import.meta`/`location`
  appear only inside `porchBase()` (api.ts:23-26); no enums/namespaces/
  parameter properties; the test run itself proves the lib imports and
  runs under node type-stripping.
- **Store lifecycle**: `startPolling` guards double-start (workflow.ts:225),
  `stopPolling` clears the interval, `ticking` serializes ticks,
  `onBeforeUnmount` → `stopPolling` (WorkflowView.vue:29-32). The one hole
  is nit #1.
- **Honesty**: empty states ("Porch endpoint unreachable", "No porch runs
  yet" + real `porch-dispatch` hint), idle ask/code/pipeline nodes,
  tool cards stuck at `started` on devin/pi (backend truly emits no
  `tool_completed`), `…` truncation markers, "no output for N min"
  wording — all honest; zero invented/demo data anywhere.
- **Fixtures are real**: devin tail has `kind:"tool"` summaries
  ("Ran cat, wc") + `progress` heartbeats; opencode tail has real
  `call_id` JSON previews including genuinely truncated `…` strings.
- **Test quality**: all 50 assertions are behavioral (type/field/status/
  ordering checks); no `assert(true)`, `|| true`, or source-grep. The
  "every matchType produceable by §1.3" guard (test:421-441) is a real
  regression net. `porchBase` smoke test is light but real — it proves
  node-safe import + sane default.
- **Verification commands**: `node scripts/test_workflow_porch.mjs` →
  50 pass / 0 fail; `npm run build:web` → vue-tsc clean, vite green.

## Notes for the implementer

- Nit #1 is the only one I'd bother fixing before merge — one-line guard:
  `let disposed = false; onBeforeUnmount(() => { disposed = true; wf.stopPolling(); });`
  and `if (!disposed) wf.startPolling()` in the `.then`. Alternatively move
  the init+start sequence into a store action so the race can't exist.
- Nit #2 (sticky `false` probe) is worth a thought while you're in api.ts;
  it's the difference between "view heals itself" and "user must reload".
- Nits #6/#7 are same-area one-liners in the store's tick bookkeeping —
  bundle them if you touch it.
- The `run_failed`-typed adapter `error` lines mean a mid-run
  `kind:"error"` lights Acceptance (its matchTypes include `run_failed`)
  on an otherwise-healthy run. It's the honest reading of the event and
  the banner explains it — leaving as designed is defensible; just be
  aware the stepper can show Acceptance early on a run that later
  completes fine (the synthesized terminal check in audit.ts:216-218
  deliberately doesn't add `run_completed` once any terminal-ish event
  exists).
- `detail.state` is plumbed but unread (nit #10) — fine as a seam for a
  future steers row; say so in a comment if you keep it.

REVIEW COMPLETE
