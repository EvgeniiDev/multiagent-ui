STATUS: PARTIAL

All six `color: white` rules were replaced with `var(--text-on-accent, #fbf8f3)`
(each confirmed to sit on an accent/danger fill), `npm run build:web` is green,
the new `scripts/e2e_white_text.py` runs end-to-end on both schemes with zero
`pageerror`, and `scripts/e2e_touch.py` still passes 17/17. However the
mandated ≥4.5:1 gate **fails on the four elements that sit on `--bg-primary`**
in BOTH schemes, so this cannot honestly be reported as DONE. Root cause is
upstream of the six edited lines; details below.

## Replaced

| file:line | rule | old -> new | element's background |
|---|---|---|---|
| src/App.vue:709 | `.new-session-btn` | `color: white` -> `var(--text-on-accent, #fbf8f3)` | same-rule `background: var(--bg-primary)` |
| src/App.vue:794 | `.disconnect-btn` | `color: white` -> `var(--text-on-accent, #fbf8f3)` | same-rule `background: var(--bg-danger)` |
| src/components/ChatView.vue:980 | `.send-btn` | `color: white` -> `var(--text-on-accent, #fbf8f3)` | same-rule `background: var(--bg-primary, #c2532f)` |
| src/components/SettingsView.vue:457 | `.add-btn:hover:not(:disabled)` | `color: white` -> `var(--text-on-accent, #fbf8f3)` | hover `background: var(--bg-primary)` |
| src/components/SettingsView.vue:524 | `.save-btn` | `color: white` -> `var(--text-on-accent, #fbf8f3)` | same-rule `background: var(--bg-primary)` |
| src/components/SettingsView.vue:621 | `.delete-btn:hover` | `color: white` -> `var(--text-on-accent, #fbf8f3)` | hover `background: var(--bg-danger)` |

## Measured

Computed `color` vs composited background (ancestor walk, alpha-aware,
bottom-up), real chromium via playwright, 1440×900:

| element | fill | dark before -> after | light before -> after |
|---|---|---|---|
| `.new-session-btn` | `--bg-primary` | 3.10 -> **2.92 FAIL** | 4.59 -> **4.34 FAIL** |
| `.send-btn` | `--bg-primary` | 3.10 -> **2.92 FAIL** | 4.59 -> **4.34 FAIL** |
| `.add-btn` (:hover) | `--bg-primary` | 3.10 -> **2.92 FAIL** | 4.59 -> **4.34 FAIL** |
| `.save-btn` | `--bg-primary` | 3.10 -> **2.92 FAIL** | 4.59 -> **4.34 FAIL** |
| `.disconnect-btn` | `--bg-danger` | 5.69 -> 5.37 PASS | 5.69 -> 5.37 PASS |
| `.delete-btn` (:hover) | `--bg-danger` | 5.69 -> 5.37 PASS | 5.69 -> 5.37 PASS |

Why the four `--bg-primary` elements fail:

1. **Dark scheme — missing token override.** The brief describes
   `--text-on-accent` as becoming `#211d1a` in the dark block. In this
   worktree the token is defined exactly once (`src/App.vue:568`,
   `#fbf8f3`) and `@media (prefers-color-scheme: dark)` never redefines it,
   so the replaced rules resolve to the light "paper" value on the light
   `#e07450` accent -> 2.92:1 (worse than the old white, 3.10:1). That
   override exists only as *uncommitted* work in the sibling `cc/dark2`
   worktree (`git diff` there shows `+ --text-on-accent: #211d1a;` plus
   `--text-muted`/`--text-accent` retunes). Once merged, these four
   elements measure 5.40:1 in dark.
2. **Light scheme — token value itself below threshold.** Even the
   correct light value `#fbf8f3` on `--bg-primary #c2532f` is 4.34:1 —
   below 4.5 regardless of the dark2 merge (white was 4.59:1, a bare pass).
   The same pair already ships in CardDrawer.vue, KanbanTab.vue,
   PermissionDialog.vue, DashboardView.vue and SessionList.vue, so this is a
   token-calibration gap, not something these six call sites introduced.
   Reaching ≥4.5 needs `--text-on-accent: #ffffff` in `:root` (4.59:1) or a
   darker `--bg-primary` — both are token changes outside this brief's
   scope ("own only those six CSS lines").
3. `--bg-danger #b3402e` is not redefined in dark mode, so the two
   danger-fill elements pass both schemes (5.37:1).

Net effect of the change as committed: `--bg-danger` text stays compliant
(5.69 -> 5.37), `--bg-primary` text adopts the token but the token's
current values don't reach 4.5 in either scheme (dark blocked on the
cc/dark2 merge; light blocked on a token-value decision).

## Left as is

None — all six rules sit on accent/danger fills (`--bg-primary` / `--bg-danger`)
and were replaced.

## Evidence

`npm run build:web` tail:

```
✓ 247 modules transformed.
dist-web/index.html                   0.96 kB │ gzip:   0.50 kB
dist-web/assets/index-BSieIKyG.css   93.44 kB │ gzip:  13.47 kB
dist-web/assets/index-CEPlik6c.js   446.45 kB │ gzip: 158.78 kB
✓ built in 2.65s
```

`~/.hermes/tools-venv/bin/python scripts/e2e_white_text.py` (serves dist-web
on :25992; ACP handshake mocked via `route_web_socket` so `.send-btn` /
`.disconnect-btn` render connected; fs API stubbed; telemetry disabled via
seeded prefs):

```
FAIL  dark .new-session-btn (App.vue:709): contrast >= 4.5  (after 2.92:1, before 3.10:1, fg rgb(251,248,243) on rgb(224,116,80))
PASS  dark .disconnect-btn (App.vue:794): contrast >= 4.5  (after 5.37:1, before 5.69:1, fg rgb(251,248,243) on rgb(179,64,46))
FAIL  dark .send-btn (ChatView.vue:980): contrast >= 4.5  (after 2.92:1, before 3.10:1, fg rgb(251,248,243) on rgb(224,116,80))
FAIL  dark .add-btn (SettingsView.vue:457 :hover): contrast >= 4.5  (after 2.92:1, before 3.10:1, fg rgb(251,248,243) on rgb(224,116,80))
PASS  dark .agent-item .delete-btn (SettingsView.vue:621 :hover): contrast >= 4.5  (after 5.37:1, before 5.69:1, fg rgb(251,248,243) on rgb(179,64,46))
FAIL  dark .agent-form .save-btn (SettingsView.vue:524): contrast >= 4.5  (after 2.92:1, before 3.10:1, fg rgb(251,248,243) on rgb(224,116,80))
PASS  dark rail: Projects view mounts (.view-pane .head-controls)
PASS  dark rail: Board view mounts (.view-pane .tab-bar)
PASS  dark rail: Dashboard view mounts (.view-pane[data-testid="dashboard"])
PASS  dark rail: Chat view mounts (.chat-view)
FAIL  light .new-session-btn (App.vue:709): contrast >= 4.5  (after 4.34:1, before 4.59:1, fg rgb(251,248,243) on rgb(194,83,47))
PASS  light .disconnect-btn (App.vue:794): contrast >= 4.5  (after 5.37:1, before 5.69:1, fg rgb(251,248,243) on rgb(179,64,46))
FAIL  light .send-btn (ChatView.vue:980): contrast >= 4.5  (after 4.34:1, before 4.59:1, fg rgb(251,248,243) on rgb(194,83,47))
FAIL  light .add-btn (SettingsView.vue:457 :hover): contrast >= 4.5  (after 4.34:1, before 4.59:1, fg rgb(251,248,243) on rgb(194,83,47))
PASS  light .agent-item .delete-btn (SettingsView.vue:621 :hover): contrast >= 4.5  (after 5.37:1, before 5.69:1, fg rgb(251,248,243) on rgb(179,64,46))
FAIL  light .agent-form .save-btn (SettingsView.vue:524): contrast >= 4.5  (after 4.34:1, before 4.59:1, fg rgb(251,248,243) on rgb(194,83,47))
PASS  light rail: Projects view mounts (.view-pane .head-controls)
PASS  light rail: Board view mounts (.view-pane .tab-bar)
PASS  light rail: Dashboard view mounts (.view-pane[data-testid="dashboard"])
PASS  light rail: Chat view mounts (.chat-view)
PASS  zero pageerror events

13/21 assertions passed
```

`~/.hermes/tools-venv/bin/python scripts/e2e_touch.py` (unchanged,
self-serves :25996): **17/17 assertions passed**, exit 0.
