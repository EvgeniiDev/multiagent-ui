# Panel recovery, 19 October 2026

## Causes and changes

- Devin `darkened-shield` had legacy inventory `lastTurnStatus: working`,
  while the canonical status document said `null`. Successful replay still
  latched Queue from the legacy field. Restore now uses canonical `turnStatus`.
  Confirmed delivery and fresh live-work barriers remain intact.
- History cache budget trimming serialized an entire large transcript after
  every removed message. The regression fixture needed 71 full serializations;
  the replacement accounts for each message once and preserves the newest tail
  and user-turn ordinals within the same 512 KiB budget.
- The 4.6 MB activity document repeatedly exhausted localStorage. Acknowledged
  remote snapshots larger than 1 MiB are not mirrored. Pending edits retain the
  full offline write path. Repeated failures warn once until a real local write
  succeeds. No server ledger or pending message is deleted.
- OpenCode host CLI 1.18.34 was reading a database whose empty `workspace` table
  already had the V2 schema, causing `no such column: project_id` on startup/list.
  The source database contains 264 legacy sessions and 169 V2 sessions. V2 CLI
  can read V2 history but cannot load the panel's legacy `ses_eaaf58c60ffezDqmaNnSNyN5Fj`.
  The host bridge therefore keeps its installed V1 CLI and uses an isolated V1
  copy, `~/.local/share/opencode/opencode-acp-legacy.db`. The original
  `opencode.db` retains its V2 schema and both generations of history.

The database preparation script uses SQLite's online backup, refuses nonempty
or unknown workspace schemas, preserves every session/message table, and never
replaces an existing compatible ACP database. Copies have mode 0600. A production
check caught a WAL-publication defect in the first script version; a failing
WAL-mode regression now covers it. The final script converts the copy to DELETE
journal mode and closes connections before atomically publishing the main file.
The earlier `opencode-acp-v1.db` trial copy is unused and the original is unchanged.

The restored V1 and existing V2 histories are intentionally separate going
forward. A future move to V2 must import the legacy sessions rather than point
V1 back at the V2 database. Run preparation explicitly before selecting the new
host environment on an existing installation:

```sh
python3 deploy/prepare-opencode-v1-db.py
```

## Verification

- Runtime: 32 tests, including a red/green regression for stale Devin Working.
- History budgets: 3 tests, including the 71-serialization regression.
- Storage: 14 timeout/offline tests plus oversized snapshots, pending offline
  recovery and warning deduplication; final invocation recorded in
  `/tmp/acp-repair-storage-final.log`.
- Session inventory, UI store, shared cache and status: 23 tests.
- Bridge lifecycle/status: 4 tests, including two sockets, reused request IDs,
  orphan completion and replay isolation. Existing bridge source was activated;
  neither per-session routing nor request-ID namespacing changed in this repair.
- Database preparation: 4 tests, including WAL publication, both history
  generations, reruns and refusal of nonempty workspaces.
- Browser Queue recovery at 390/1440 px: accepted messages reconcile after
  socket loss, no resends, and subsequent Queue waits for fresh terminal evidence.
  These are deterministic ACP/state fixtures, not paid-provider runs.
- Real CLI against an isolated database: initialize, list and load the exact
  existing legacy OpenCode session succeeded; no prompt was submitted.
- Real deployed HTTPS browser: all seven saved tabs finished restoration in
  30–37 seconds across checks. OpenCode and Devin both connected with no transport errors.
  The final release run recorded zero page errors and RPC errors, and one
  deduplicated localStorage quota warning per page load for pending ledger data
  (two total, including reload). An earlier
  run had no warnings. OpenCode session/load completed in 1.13 s and Devin in
  1.38 s in the final run. Reload, Board navigation (50 visible cards), and
  opening the existing managed card drawer also worked. No user prompts were
  submitted. Large background histories still take time to replay; this is not
  a claim of instant restoration or of a real provider generation test.

## Release provenance

Release checkout: `/tmp/acp-panel-repair`, branch `main`. Earlier unrelated WIP
in `/tmp/acp-device-sync` was preserved unchanged under
`wip/panel-work-before-repair-20261019`; canonical checkout WIP was not committed.

Code commits: `315b4a6` (panel), `6f1650f` (isolated legacy database),
`a4ef0c1` (WAL publication), and `dea0765` (quota-warning deduplication).

Verified web bind source: `/home/hermes/projects/acp-ui/dist-web` mounted at
`/repo/dist-web`. Publish copies assets first, retains older hashed files and
replaces `index.html` last. Final frontend entry: `index-C-S1Tikt.js`, SHA-256
`ee32014450b64a3488e201cb2069b94245f1b31cfaa5232519841da0078f9cab`.

Only OpenCode and Devin bridges were restarted, through
`scripts/acp-bridges.mjs restart --bridge NAME --accept-interruption`, after
controller status and listener inspection. Both now answer
`GET /api/sessions/status`. Selected host mode remains unchanged. Hermes, Pi,
Codex, web, state, runner and other existing services were not restarted.

Unchanged image IDs:

- web: `sha256:2f17fc044b579bab302c2e8054d3a686e2cb9a83de48e70534b94cd8ebbe06a9`
- state: `sha256:66ec5b5f1e7db15f82f0bcde10ab1ae655e9484551e7575ae2cb6d318f22f9bd`

The final browser receipt is `/tmp/acp-panel-live-qa.json`; browser console,
restoration timings, affected RPC responses and script URLs are captured there.
Open pages need a reload to adopt the frontend fixes.
