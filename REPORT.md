STATUS: DONE

## Defect A — click on a project row now always produces a visible change

Root cause: `.project-detail` was rendered as the last child of the scrolling
`.pane-body`, so on any list longer than the viewport the click only flipped a
ref — the mounted detail sat below the fold.

Fix in `src/components/ProjectsView.vue` (detail extracted to
`src/features/projects/ProjectDetail.vue`):

- `.pane-body` no longer scrolls. It is a horizontal flex frame holding two
  independently scrolling panes: `.list-col` (`flex: 0 0 auto`,
  `width: clamp(340px, 30vw, 420px)`, `overflow-y: auto`) and `.detail-col`
  (`flex: 1`, `overflow-y: auto`). Agents/tokens collapse out of list rows in
  the narrow column; they remain in the detail pane.
- Selected row: `.open` now paints `--tint-active` background + a 3px accent
  bar (`inset 3px 0 0 var(--bg-primary)`), heavier name weight,
  `aria-current="true"`, `tabindex="0"` + Enter/Space activation.
- `<800px` (same matchMedia breakpoint as the sidebar drawer): single column.
  The detail mounts as `li.project-inline-detail` — the clicked row's
  `nextElementSibling` — and `openProject` calls
  `scrollIntoView({ block: 'nearest' })` on it after `nextTick`. Exactly one
  `.project-detail` exists in the DOM at a time (the detail column is `v-if`'d
  off while narrow and `display:none` besides).
- Close affordance: `.detail-close` (SVG ✕, `aria-label="Close project
  detail"`) in the detail header; kept "New session here", metrics and the
  per-project session list.
- Placeholder ("Select a project to see its sessions and usage.") when nothing
  is selected.

Measured `.project-detail` bounding-box `y` after clicking row 20 of a seeded
26-row list (probe numbers from the brief, "before"):

| viewport   | before (probe, deployed build)              | after (this build, e2e)      |
|------------|---------------------------------------------|------------------------------|
| 1440×900   | y = 1297 (invisible; scrollTop stayed 0)    | y = 63 (inside viewport)     |
| 1024×768   | — (same defect shape: last child of list)   | y = 63                       |
| 390×844    | end of list, no scroll                      | y = 583, inline under row    |

At 390 the detail's `<li>` is `clickedRow.nextElementSibling`
(`compareDocumentPosition` FOLLOWING, sibling distance 1) and is pulled into
view by `scrollIntoView`.

## Defect B — session creation no longer requires a project

One shared implementation: `src/features/projects/NewSessionDialog.vue`
(agent `<select>` fed by `configStore.agentNames` — stdio already filtered out
on web/mobile — plus a working-directory field that reuses the existing
`DirectoryPicker`, so ws agents also get the bridge-backed directory tree for
free; the field may stay empty, `''` is passed through to
`sessionStore.createSession` and the agent uses its own default). Confirm →
`createSession(agent, cwd)` → `uiStore.setView('chat')` — the same path as
"New session here". Esc / overlay click / Cancel dismiss; failure keeps the
dialog open with the error inline (the store's error banner also fires).

Two entry points:

- `ProjectsView` header: primary `.new-session-cta` button — works with no
  project selected and no session connected.
- `ChatView` header: `.chat-new-session` — always rendered while the chat view
  is mounted (the sidebar's own New Session button is untouched per the
  brief), disabled only while a turn is streaming / a reconnect is in flight.

## Evidence

`npm run build:web` (vue-tsc + vite, green):

```
dist-web/assets/index-DYJcA_3A.js   452.02 kB │ gzip: 160.29 kB
✓ built in 2.52s
```

`~/.hermes/tools-venv/bin/python scripts/e2e_projects_ux.py` (self-serves
dist-web on 127.0.0.1:25989, seeds 26 sessions with distinct `cwd` into
`acp-ui:sessions.json`, reloads, mocks the ACP handshake via
`page.route_web_socket`):

```
PASS  seeded long project list  (26 rows)
PASS  Projects header New session opens dialog (no project selected)
PASS  dialog offers the configured agents  (,E2E Mock,E2E Mock B)
PASS  dialog confirm creates session and lands on Chat
PASS  dialog closes after confirm
PASS  chat header has a New session control
PASS  chat header control opens the same dialog
PASS  1440: detail pane inside viewport after click  (y=63 vh=900)
PASS  1440: detail shows the clicked project's path  ('/home/hermes/projects/proj-19')
PASS  selected row carries .open
PASS  selected row has aria-current='true'
PASS  selected row is unmistakable (tint bg + accent bar)  (bg=rgba(194, 83, 47, 0.1) shadow=rgb(194, 83, 47) 3px 0px 0px 0px inset)
PASS  1024: detail pane still inside viewport  (y=63 vh=768)
PASS  390: detail rendered immediately after the clicked row  (nextIsDetail=True, follows=True)
PASS  390: inline detail inside viewport after scrollIntoView  (y=583 vh=844)
PASS  390: inline detail shows the clicked project  ('proj-19')
PASS  390: exactly one .project-detail in DOM
PASS  390: selected row still marked
PASS  zero pageerror events

19/19 assertions passed
```

Re-run, unchanged, against this worktree's build:

- `scripts/e2e_board.py`     — **16/16** (dist-web served on 25999)
- `scripts/e2e_touch.py`     — **17/17** (self-served on 25996)
- `scripts/e2e_dashboard.py` — **11/16 — pre-existing time-bomb, not caused by
  this change.** Its fixture dates the `beta` rows "today at 12:00 UTC";
  between 00:00 and 12:00 UTC those rows are in the future and
  `usageInRange(from, to=Date.now())` drops them (summary reads 2,000 instead
  of 2,500, by-agent has 1 row, quota-warning rows 0). Verified by stashing
  this change, rebuilding HEAD and re-running: identical 11/16 failure. The
  script is in the forbidden set so it was not edited; it should go green if
  re-run after 12:00 UTC, or its `ts(0, 12)` fixture should be anchored to a
  guaranteed-past hour.

Screenshots: `docs/ux-projects-1440x900.png`, `docs/ux-projects-1024x768.png`,
`docs/ux-projects-390x844.png`, `docs/ux-newsession-1440x900.png`.

## Integration requests / Left as is

- **`App.vue` gates `<ChatView>` on `isConnected`** (the welcome screen
  renders instead while disconnected). The chat-header "New session" is
  therefore present whenever the chat view exists — including while the
  sidebar button is hidden — but a literal "available while disconnected"
  header control cannot exist without touching `App.vue`. Request: either
  mount `ChatView` unconditionally, or add the same one-line trigger +
  `<NewSessionDialog v-if … @close>` to `.welcome-screen`. The dialog is a
  drop-in component (`src/features/projects/NewSessionDialog.vue`, emits
  `close`, owns the whole create → switch-to-chat flow).
- `e2e_dashboard.py` fixture time-bomb described above (file is out of
  scope).
- Sidebar `.new-session-btn` left exactly as is, per the brief.
