# W14 — View-switch shortcuts: one keydown owner (report)

STATUS: DONE

## What changed

Two places installed their own `window` `keydown` listener that mapped bare
digits 1–4 to views, each with its own "am I typing?" guard, so the same
keypress was handled twice, once, or not at all depending on focus:

- `src/stores/ui.ts` — `bindShortcuts()` inside `initUiStore()` guarded
  `INPUT`/`TEXTAREA`/`contentEditable` but not `SELECT` or `event.repeat`.
- `src/App.vue` — `handleViewShortcut` guarded `SELECT` and `event.repeat`
  but duplicated the whole mapping.

Now `src/stores/ui.ts` is the single owner: it keeps `bindShortcuts()` (it
also owns the Esc-closes-overlays path and `VIEWS`/`setView`) with the union
of both guards — `INPUT` (any type, so `type="number"` role-limit fields are
covered), `TEXTAREA`, `SELECT`, `isContentEditable`, plus `meta`/`ctrl`/`alt`
and `event.repeat`. `src/App.vue` no longer registers a keydown listener;
`handleViewShortcut` was deleted outright (not guarded twice). `VIEWS` stays
imported in App.vue for the rail template.

## E2E — `scripts/e2e_shortcuts.py` (new)

Self-serves `dist-web/` on its own port `25980` (free-listener check asks the
kernel via `ss -ltn` — a TIME_WAIT leftover does not block the run). Every
`:25900` call is aborted with `page.route`, so the panel falls back to
localStorage and never touches the live state server or `~/.hermes`. The ACP
agent is the usual `route_web_socket` stub so a session connects and the real
composer mounts.

The suite counts `localStorage.setItem('acp-ui:preferences.json', …)` calls
per keypress (wrapped `Storage.prototype.setItem` in an init script): each
`setView` persists exactly once, so a second keydown owner shows up as two
writes — this is what makes "switched exactly once" observable rather than
just "the right view is active".

Registered in `scripts/e2e_all.py` as `("shortcuts", …, None)` — it serves
itself, like `e2e_roles.py`/`e2e_touch.py`.

Asserted on a real page (one line per assertion, exit 1 on any failure):

- digits 1/2/3/4 each activate their view on the rail AND mount the matching
  pane (welcome/`.search`/`.board-col`/`[data-testid=dashboard]`), exactly
  one `.rail-btn.active`, exactly one persist write;
- same with focus on a rail button and on an ordinary (scope) button;
- digits typed into the Projects filter, the Board card search, a Board
  filter `<select>`, the composer textarea, the role `maxConcurrent`
  `type=number` input and the role id text input leave the view untouched
  (0 persist writes) and the digit lands in the field;
- focus order does not matter: field → button → field and button → field →
  button sequences guard/switch identically;
- zero `pageerror` events.

## Commands and output

```
$ npm run build:web
✓ 275 modules transformed.  ✓ built in ~2.9s   (vue-tsc clean)

$ ~/.hermes/tools-venv/bin/python scripts/e2e_shortcuts.py
PASS  booted on the Chat view  (active=Chat pane=chat)
PASS  '2' activates Projects on the rail
PASS  '2' mounts the Projects pane (no wrong view)  (pane=projects)
PASS  '2' persists the view exactly once  (prefWrites=1)
…
PASS  digit '3' in the Projects filter keeps Projects
PASS  digit '1' in the card search keeps Board
PASS  digit '2' in a board filter <select> keeps Board
PASS  digit '3' in the composer keeps Chat
PASS  digit '3' in the role maxConcurrent number input keeps Chat  (value='13')
PASS  digit '2' in the role id text input keeps Chat
PASS  zero pageerror events

54/54 assertions passed   (exit 0)
```

## Negative verification (suite actually catches the bug)

The fix was stashed, `dist-web` rebuilt from the buggy sources and the suite
re-run:

```
FAIL  '3' persists the view exactly once  (prefWrites=2)   # ×12 presses
FAIL  digit '2' in a board filter <select> keeps Board     # missing SELECT guard
…
40/53 assertions passed   (exit non-zero)
```

(that run predates the readiness-probe assertion; 13 assertions failed:
`prefWrites=2` on every non-field press, plus the `<select>` guard). i.e. on
the old code every non-field keypress persisted twice — two `setView` calls —
and a focused `<select>` still switched views, exactly the two bugs the fix
targets. Fix restored, rebuilt, suite green again (54/54).

## Not verified live

- `scripts/e2e_all.py` was updated but not run end-to-end here — several
  suites in it target live host services (e.g. `e2e_shell_projects.py` hits
  the deployed panel at 192.168.1.222:25808); `e2e_shortcuts.py` itself was
  run standalone against this tree's fresh `dist-web`.
- Tauri/desktop build not exercised — the change is a web-layer listener;
  `bindShortcuts` is host-agnostic (guards on `typeof window`) but no desktop
  run was done.
