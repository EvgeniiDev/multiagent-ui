STATUS: DONE

## Token changed

One line only — light `:root` block of `src/App.vue` (line 567):

- old: `--text-muted: #a39a8e` (2.62:1 on paper `#fbf8f3`, 2.49:1 on sidebar `#f6f2ec` — fails AA)
- new: `--text-muted: #786d62` (4.76:1 on paper, 4.52:1 on the sidebar — passes both)

`#786d62` is the lightest warm grey checked that clears 4.5:1 on both
surfaces (`#7d7268` next-lighter candidate fails at 4.43/4.20); it stays
visibly subdued and clear of `--text-secondary` (`#6b6259`, 5.64/5.35).
Dark block (`--text-muted: #b3a79b`, 6.44:1 / 7.10:1) untouched.

## Exceptions

Measured with composited backgrounds by `scripts/e2e_muted_contrast.py`
(light). Nothing else fails in either scheme. Proposals only — unapplied,
brand accent untouched:

1. Active segmented control — `rgb(194,83,47)` on the 16% accent tint
   `rgb(245,232,223)` → **3.82:1** (Projects `active '7d'`, Dashboard
   `seg-btn '7 days'`). Options: new `--text-accent-on-tint: #a8431f`
   (5.02:1 on the tint, hue recognisable) for text on tinted surfaces only;
   or deepen text-role accent to `#9c3f1e` (5.56:1).
2. Active tab `.tab-btn` — `rgb(194,83,47)` on paper → **4.34:1** (Board
   `tab-btn 'Tasks'`). Same text-role options: `#a8431f` (5.68:1 on paper)
   or `#9c3f1e` (6.31:1); fill/hover tokens stay `#c2532f`.
3. Paper on the accent fill — `rgb(251,248,243)` on `rgb(194,83,47)` →
   **4.34:1** (Board `empty-btn 'New card'`). Options: keep the fill, use a
   deeper fill for text-backing roles only (e.g. `#a8431f`, paper on it is
   5.68:1); or a separate `--bg-accent-strong` token so decorative fills
   keep the current terracotta.

Dark-mode note (pre-existing, also unapplied): `.new-session-btn`
`rgb(255,255,255)` on the dark fill `rgb(224,116,80)` → **3.10:1**
(hardcoded `color: white`, not a token; exists on `main` before this
change — the prior `e2e_dark_contrast.py` run fails identically on the
stashed baseline). Owner decision; the script lists it as an accent-fill
exception so the dark assertion stays honest.

## Evidence

Build tail (`npm run build:web`, from the script run):

```
dist-web/assets/stdio-Bv4HIoYX.js     1.63 kB │ gzip:   0.62 kB
dist-web/assets/index-CEBohnCT.js   446.45 kB │ gzip: 158.78 kB
✓ built in 2.62s
```

`scripts/e2e_muted_contrast.py` (builds, serves dist-web on 25991,
1440×900 light+dark × Chat/Projects/Board/Dashboard, composited
backgrounds, 4.5 / 3.0-large thresholds) — 6/6:

```
== light-mode accent exceptions (known, unapplied — see REPORT.md) ==
EXCEPTION  [Projects] active '7d' rgb(194, 83, 47) on rgb(245, 232, 223) -> 3.82:1 (needs 4.5)
EXCEPTION  [Board] tab-btn 'Tasks' rgb(194, 83, 47) on rgb(251, 248, 243) -> 4.34:1 (needs 4.5)
EXCEPTION  [Board] empty-btn 'New card' rgb(251, 248, 243) on rgb(194, 83, 47) -> 4.34:1 (needs 4.5)
EXCEPTION  [Dashboard] seg-btn '7 days' rgb(194, 83, 47) on rgb(245, 232, 223) -> 3.82:1 (needs 4.5)
PASS  light mode: zero failures outside the three accent cases  (0 non-accent failing)
PASS  light mode: accent exceptions observed (the known three classes)  (4 accent rows)
== dark-mode accent exceptions (paper-on-accent fill; same owner decision) ==
EXCEPTION  [Chat] new-session-btn 'New Session' rgb(255, 255, 255) on rgb(224, 116, 80) -> 3.10:1 (needs 4.5)
PASS  dark mode: zero failures outside the accent fill case  (0 non-accent failing)
BEFORE  --text-muted #a39a8e on paper #fbf8f3: 2.62:1
BEFORE  --text-muted #a39a8e on sidebar #f6f2ec: 2.49:1
AFTER  --text-muted on --bg-main: 4.76:1
AFTER  --text-muted on --bg-sidebar: 4.52:1
PASS  after: --text-muted on paper >= 4.5  (4.76:1)
PASS  after: --text-muted on sidebar >= 4.5  (4.52:1)
MEASURED  --text-accent on --bg-main (paper): 4.34:1
MEASURED  --text-on-accent on --bg-primary: 4.34:1
PASS  zero pageerror events

6/6 assertions passed
```

Re-run suites (unchanged, this worktree): `scripts/e2e_touch.py` 17/17
(25996), `scripts/e2e_board.py` 16/16 (25999), `scripts/e2e_dashboard.py`
16/16 (25998). Screenshots: `docs/muted-*.png` (light, 4 views).

## Left as is

- Dark block tokens (`--text-muted #b3a79b`, `--text-accent #f0a184`,
  `--text-on-accent #211d1a`) — already passing, not touched.
- Brand accent `#c2532f` and all three accent near-misses above —
  proposals only, per brief.
- Dark `.new-session-btn` white-on-fill (3.10:1) — pre-existing on `main`,
  reported as exception, not fixed.
- No other token, colour, layout or class changes. Files owned by this
  change only: the light `--text-muted` line, `scripts/e2e_muted_contrast.py`,
  `docs/muted-*.png`, `REPORT.md`.
