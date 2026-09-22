# BRIEF — Board (kanban + live tabs) for the acp-ui control center

You are implementing ONE workstream in a Vue 3 app. Work only inside this worktree
(`/home/hermes/projects/acp-ui-cc-board`, branch `cc/board`). When you are done, `REPORT.md`
must exist at the worktree root and your work must be committed on this branch.

## Read first (in this order)

1. `docs/control-center-requirements.md` — the requirements this workstream implements
   (**F3** kanban + **F4** secondary tabs; also relevant: N1–N10).
2. `src/App.vue` — the shell: a vertical view rail (Chat · Projects · Board · Dashboard).
   The Board view is already wired to `src/components/BoardView.vue`.
3. `src/stores/activity.ts` — the factual ledger you read. Its header comment lists the whole
   API (`recent`, `entriesInRange`, `usageInRange`, `totalUsage`, `usageByAgent`,
   `usageByProject`, `usageByDay`, `dayRange`, `recordEntry`, `recordUsage`, `liveSessions`).
4. `src/stores/session.ts` — sessions/agents (read the exported names; do not edit the file).
5. `src/lib/types.ts`, `src/lib/host/storage.ts` (KV store), `src/lib/uuid.ts`.
6. `src/components/SessionList.vue` and `src/components/ChatView.vue` — the visual language
   in practice (dense rows, hairline separators, mono for machine text, no emoji).

## Ownership — files you may change

- `src/components/BoardView.vue` (replace the placeholder)
- new files under `src/features/board/**`
- new file `src/stores/board.ts` (your own pinia store)
- `scripts/e2e_board.py` (your E2E script)
- `REPORT.md` at the worktree root

**Forbidden:** `src/App.vue`, `src/stores/session.ts`, `src/stores/activity.ts`,
`src/stores/ui.ts`, other views/stores, `package.json` dependencies, `vite.config.ts`,
`docs/**`. If you need a change in one of those, do NOT make it: describe the need in
`REPORT.md` under `## Integration requests`.

Never run `systemctl`, never touch other worktrees or the main checkout
(`/home/hermes/projects/acp-ui`), and serve your test build only on port 25999.

## What to build (F3)

A kanban board over locally stored cards, in the app's own design language.

- Columns, in this order with these ids: `inbox`, `ready`, `blocked`, `active`, `review`,
  `done`, `cancelled`. Column header: label + count; `blocked` shows how many of its cards
  are blocked by something else. The header row also shows a summary line like
  `ready (6 blocked) · active · review · done · cancelled` (see the reference screenshot
  description in the requirements doc).
- Card fields: title, description, project (free text, default = last path segment),
  agent (pick from configured agents), priority `high|medium|low`, acceptance criteria
  (multi-line text), verification steps (multi-line text), links (array of `{label, url}`),
  attached session (`agentName` + `sessionId`, chosen from the session store's known
  sessions), created/updated timestamps.
- Interactions:
  - drag & drop between columns (HTML5 DnD is fine; also provide keyboard/menu fallback:
    each card has a "move to …" menu so the board works without a mouse and on touch).
  - create card (button in the column header; a new card lands in `inbox`), edit card in a
    side drawer (not a centered modal), delete with confirmation, duplicate.
  - clicking a card opens the drawer; a card with an attached session shows an "Open session"
    action that resumes it via the session store (`resumeSession(savedSession)`).
  - filter by project, agent, priority + free-text search; counters must reflect the filter.
- Persistence: `loadKvStore('board.json')`, key `cards`, plus a `version` key. Persist on
  change (debounced), restore on mount. Cards must survive a reload.
- Empty state: explains how to create the first card, no fake demo data — except: if the store
  is empty AND the user clicks "Add example card", you may insert one clearly labelled example.

## What to build (F4 — secondary tabs inside the Board view)

Tabs inside the Board view, same page: `Tasks` (the kanban), `Agents`, `Locks`, `Timeline`,
`Events`.

- **Agents**: one row per configured agent — reachability (from the config store: is the
  transport a websocket/http agent), current session if any (`isConnected`,
  `currentSession.agentName`), whether a turn is in flight (`isLoading`), last activity time
  and last event text from the ledger, and the count of locks/errors in the last 24 h.
- **Locks**: every `lock` event from the ledger (agent, session, cwd, detail text with the
  holder PID when the agent reported one, timestamp), newest first, with a hint that a locked
  session is held by another process and can be opened once that process exits. Empty state
  says clearly that no locks were observed.
- **Timeline**: activity grouped by day (last 14 days, from the ledger: `usageByDay` for
  numbers + events for content), each row dense: day, turns, tokens, cost, sessions touched.
  Clicking a day expands the events of that day.
- **Events**: live reverse-chronological stream from `activity.recent(n)` with a kind chip
  (mono, uppercase), agent, session title, time, and the detail text. Newest first, virtualised
  or windowed to the last 200 rows (N4). A filter by kind and by agent.

## Design rules (N2 — non-negotiable)

- Only colors/spacing from the tokens in `App.vue :root` (there is also a dark-mode block
  under `@media (prefers-color-scheme: dark)` — check it and use tokens that exist in both).
  No hardcoded hex values in your CSS (fallbacks inside `var(--token, #fallback)` are fine).
- One accent (terracotta). Flat surfaces, hairline borders, **no box-shadows, no gradients**.
- No emoji anywhere in the UI. Use inline stroke SVG icons in `currentColor`.
- Machine text (paths, ids, counts, kinds) in `var(--font-mono)`; body text in the UI font.
- Dense rows (26–30 px) for lists; cards may be taller but keep padding tight.
- UI strings in English, short. No walls of text.
- Accessibility: `aria-label` on icon buttons, focus-visible styles, keyboard support for the
  board (tab traversal, arrow keys to move a card between columns is a nice-to-have),
  `aria-live` where content loads asynchronously.

## Responsive (N1)

- ≥1280 px: all columns side by side, horizontally scrollable if needed (no page-level
  horizontal scroll).
- 768–1279 px: columns narrower, 2 visible, the rest via horizontal scroll.
- <768 px: columns stack vertically with a column switcher (segmented control) — never a
  horizontally scrolling board. Touch targets ≥44 px.

## Verification (required, N10)

1. `npm run build:web` must pass (it runs `vue-tsc --noEmit` + vite; a type error is a failure).
2. E2E against the real build:
   - `npm run build:web`
   - serve it: `cd dist-web && python3 -m http.server 25999` (background) — does not touch prod.
   - `~/.hermes/tools-venv/bin/python scripts/e2e_board.py` (playwright is installed in that
     venv; import `sync_playwright`, launch chromium headless with
     `context(ignore_https_errors=True)`, navigate to `http://127.0.0.1:25999/`).
   - The script must assert, at minimum: the rail switches to the Board view (click the
     Board icon), all seven columns render, a card can be created and appears in `inbox`,
     it can be dragged (or moved via the menu) to `ready` and the count updates, the card
     survives a page reload, the `Events` tab shows rows, and the page produces zero
     `pageerror` events. Print a short PASS/FAIL summary per assertion and exit non-zero on
     failure.
   - Take screenshots at 1440×900, 1024×768 and 390×844 into `docs/board-*.png` and mention
     them in the report.
3. Paste the real command output (build tail + E2E output) into `REPORT.md`.

Note: the app's agent bridges run at `ws://192.168.1.222:2590X/`; in the E2E you do not need
them — the Board works without any agent connection. Do not attempt to create real agent
sessions in the test.

## Report format (`REPORT.md`)

```
STATUS: DONE | PARTIAL | BLOCKED
## What was built          — feature by feature, with file paths
## Evidence                — build output tail, E2E output, screenshot paths
## Deliberate stubs        — what is mocked/not persisted/incomplete, honestly
## Integration requests    — anything you needed in a file you may not touch
## How to review           — exact commands + what to click
```

## Working rules

- Small, reviewable commits on `cc/board`; commit at least once when the build first passes,
  and again at the end. Do not create merge commits, do not rebase, do not touch other branches.
- Prefer a smaller thing that fully works over a large thing that half-works. If you run out of
  budget, leave the build green and note the rest in `REPORT.md` as `PARTIAL`.
- No new runtime dependencies (no chart libs, no date libs, no drag-and-drop libs).
- No network calls, no telemetry, no secrets in the repo.
