STATUS: DONE

## What was built

**F3 — Kanban over locally stored cards**

- `src/stores/board.ts` — new pinia store. `BoardCard` (title, description,
  project, agent, priority `high|medium|low`, acceptance, verification,
  `links[]`, attached `session { agentName, sessionId }`, `blockedBy`,
  `status`, `order`, created/updated). Persists to `loadKvStore('board.json')`
  under keys `version` (currently 1) and `cards`; writes are debounced 600 ms
  and also flushed on `pagehide` so nothing is lost to a quick reload.
  Malformed persisted cards are sanitized on load (`sanitizeCard`).
- Columns `inbox · ready · blocked · active · review · done · cancelled` in
  that order (`src/features/board/columns.ts`). Column header = label + count;
  the `blocked` header additionally shows `N blocked` — the count of its
  cards that name a blocker in the `blockedBy` field.
- Header summary line in `BoardView.vue`: `inbox N · ready N (M blocked) ·
  active N · review N · done N · cancelled N`, matching the reference
  (`ready (6 blocked)` folds the blocked count into the ready entry). All
  counters reflect the active filter.
- `src/features/board/KanbanTab.vue` — the Tasks tab: filter bar, columns,
  responsive switcher, empty state. New cards always land in `inbox`
  (per the brief) from any column's `+` button; if a session is live, the
  project field defaults to the last segment of its cwd.
- `src/features/board/BoardColumn.vue` — column chrome + the HTML5 DnD drop
  target (drop on a card inserts before it, accent insertion line; drop on
  empty space appends).
- `src/features/board/BoardCardItem.vue` — the card: title, meta chips
  (project / agent / priority / `blocked` / attached session / link count /
  updated stamp), 2-line description clamp, and a "Move to" menu
  (columns + Duplicate + Delete) which is the no-mouse/touch path. Keyboard:
  `Enter` opens the drawer, `Alt+←/→` moves between columns, `Alt+↑/↓`
  reorders inside the column, `Esc` closes the menu.
- `src/features/board/CardDrawer.vue` — right side drawer (not a modal),
  autosaves with a 400 ms debounce + flush on close. Edits every field,
  including a links editor and a session picker fed by
  `sessionStore.savedSessions`. `Open session` appears when the attached
  session still exists and calls `sessionStore.resumeSession(saved)`, then
  switches the rail to Chat. Delete is `confirm()`-gated in both the drawer
  and the card menu.
- `src/features/board/BoardFilters.vue` — free-text search + project / agent
  / priority selects + Clear. Filtered state shows `Tasks n/m` on the tab.
- Empty state: centered panel over the still-rendered columns explaining how
  to create the first card; "Add example card" inserts one clearly labelled
  example only when the store is empty. No fake demo data otherwise.

**F4 — secondary tabs (all fed by `stores/activity.ts`, nothing invented)**

- `AgentsTab.vue` — one row per configured agent: transport chip
  (`ws`/`http`/`stdio`), reachability label (`remote` / `local`, `local ·
  n/a on web` when stdio on a restricted host), `connected` / `idle` /
  `turn in flight` from `isConnected` + `currentSession.agentName` +
  `isLoading`, current session title, last ledger activity (stamp + text),
  and `N locks`/`N errors` chips for the last 24 h.
- `LocksTab.vue` — every `lock` ledger entry newest-first: timestamp, agent,
  session title, cwd, `pid N` chip extracted from the detail text when the
  agent reported one, full detail. Hint line about the holder process;
  explicit empty state.
- `TimelineTab.vue` — last 14 days via `dayRange(14)`: numbers from
  `usageByDay`, events/session-count from `entriesInRange`. Dense row per
  day (`YYYY-MM-DD · Nt · Ntok · $cost · Nsess`), click expands that day's
  events. Day keys use UTC like the ledger so rows never split.
- `EventsTab.vue` — live `activity.recent(200)` stream (windowed per N4),
  kind chip (mono uppercase, red for `error`/`lock`), agent, session title,
  detail, `HH:MM:SS`. Kind + agent filters, `aria-live` count.
- Card lifecycle events (create/move/duplicate/delete) are mirrored into the
  ledger as `kind: 'sync'` entries (`agentName` = card agent or `board`),
  so Events shows card status changes next to agent events as F4 requires.

**Design (N2):** only `App.vue` tokens used, flat surfaces + hairlines, no
shadows/gradients/emoji, stroke SVGs in `currentColor`, mono for machine
text, 26–30 px dense rows, ≥44 px touch targets under 768 px.

## Evidence

`npm run build:web` tail:

```
vite v6.4.1 building for web...
✓ 243 modules transformed.
dist-web/assets/index-BTZMxrl_.js   407.99 kB │ gzip: 148.30 kB
✓ built in 2.37s
```

E2E (`cd dist-web && python3 -m http.server 25999` + `~/.hermes/tools-venv/bin/python scripts/e2e_board.py`):

```
PASS  rail switches to Board view
PASS  all seven columns render  (found 7)
PASS  column order inbox..cancelled  (inbox,ready,blocked,active,review,done,cancelled)
PASS  create opens the side drawer
PASS  new card appears in inbox
PASS  card moved to ready via menu
PASS  ready count incremented  (1 -> 2)
PASS  summary line updates  (inbox 0 · ready 2 (1 blocked) · active 0 · review 0 · done 0 · cancelled 0)
PASS  card survives reload
PASS  Events tab shows rows  (9 rows)
PASS  Agents tab lists configured agents  (4 rows)
PASS  Locks tab shows lock rows  (1 rows)
PASS  Timeline tab shows day rows  (3 rows)
PASS  day expands to events
PASS  phone layout shows column switcher
PASS  zero pageerror events

16/16 assertions passed
```

Real HTML5 drag & drop was additionally verified by a separate playwright
probe (drag card → drop on column body → card lands + count updates).

Screenshots: `docs/board-1440x900.png`, `docs/board-1024x768.png`,
`docs/board-390x844.png`, plus `docs/board-drawer-1440x900.png`,
`docs/board-events-1440x900.png`, `docs/board-timeline-1440x900.png`.

## Deliberate stubs

- Reachability in the Agents tab is transport-derived (per the brief), not a
  live probe — no extra network calls were added. `connected`/`turn in
  flight` are only knowable for the session currently attached to the
  session store; other agents show `idle`/`—`.
- `blockedBy` is free text (a note naming the blocker), not a card-to-card
  dependency graph — it powers the `(N blocked)` marker honestly.
- The E2E seeds `acp-ui:activity.json` / `acp-ui:board.json` in localStorage
  (guarded, first navigation only) so Events/Locks/Timeline have real rows
  without live agents; nothing is mocked inside the app itself.
- Drawer autosave means no explicit "unsaved changes" state; `saved HH:MM`
  is shown in the footer line.

## Integration requests

1. **`src/App.vue` — phone rail.** Under `@media (max-width: 800px)` the
   `.view-rail` becomes `flex-direction: row; width: auto`, but
   `.app-container` stays `flex-direction: row`, so the rail renders as a
   ~210 px left strip instead of a horizontal bar above the content; the
   board (and every view) is squeezed into the remainder. Fix would be
   `.app-container { flex-direction: column }` in that media block — owned
   by the shell workstream, not touched here.
2. **`src/App.vue` — backdrop on resize.** Resizing a loaded page to <800 px
   while the sidebar is open leaves `.drawer-backdrop` visible over
   non-chat views (`v-show="isNarrowLayout && showSidebar"` doesn't check
   `activeView`). Fresh phone loads are unaffected.
3. **`src/stores/activity.ts` — event kind.** Card lifecycle is recorded as
   `kind: 'sync'` because `ActivityKind` has no card/board kind. A
   dedicated `card` (or `board`) kind would render a cleaner chip in the
   Events tab and let filters distinguish card moves from agent syncs.
4. **`src/stores/ui.ts` (optional).** A registered "close topmost overlay"
   hook would let the card drawer participate in the global `Esc` chain
   instead of binding its own capture listener.

## How to review

```
cd /home/hermes/projects/acp-ui-cc-board
npm run build:web
cd dist-web && python3 -m http.server 25999 &   # serve the real build
~/.hermes/tools-venv/bin/python scripts/e2e_board.py
```

Then open `http://127.0.0.1:25999/`, click the Board icon in the rail:

- Tasks: `+` in a column header creates a card in Inbox and opens the
  drawer; drag a card between columns or use its `⋮` menu → "Move to …";
  try `Alt+←/→` on a focused card; reload — cards persist.
- Filters: type in the search box / pick project-agent-priority and watch
  the column counts and the header summary change.
- Agents/Locks/Timeline/Events tabs show live ledger data; click a day row
  in Timeline to expand its events.
- Phone layout: narrow to <768 px — a column switcher appears; the drawer
  goes full-width.
