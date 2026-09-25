STATUS: DONE

# W16 fixes — contrast states + flag/stage consistency

Two board cards, one workstream (`cc/w16-fixes`, tree `acp-ui-w16-fixes`).

## Fix 1 — card `37ecd0db`: hover / send-button contrast

### What actually failed (baseline `scripts/e2e_white_text.py`, 17/21)

- `dark .disconnect-btn`: **2.94:1** — dark ink `rgb(33,29,26)` on
  `--bg-danger` `rgb(179,64,46)`. The fill kept the light-scheme value in
  dark mode; same failure on `.delete-btn:hover` (**2.94:1**).
- `.send-btn` in BOTH schemes (dark **3.32:1**, light **2.18:1**): the
  button was measured mid-transition — `transition: background|color
  0.15s` still ran at measure time (~80 ms in), so the fill was ~75–85 %
  alpha composited over the page and the ink was mid-way to its target.
  Any mid-flight frame of a disabled→armed fade is sub-contrast.

### Changes

- `src/App.vue` — new token `--bg-danger-hover` in both schemes; dark block
  now also carries `--bg-danger`. Same rule the accent already follows:
  the fill lightens in dark mode so the dark `--text-on-accent` ink stays
  ≥ 4.5:1 on it. Flat coffee palette, no gradients.
  - light: `--bg-danger: #b3402e` (unchanged), `--bg-danger-hover: #9c3524`
  - dark: `--bg-danger: #d9775f`, `--bg-danger-hover: #e08a70`
  - as a text/border ink the lighter dark red keeps ≥ 4.5:1 on the dark
    surfaces too (4.88:1 on `--bg-main`), so the ~30 `color:`/`border:`
    usages of `--bg-danger` improve rather than regress.
- Every danger-fill hover now goes through the token:
  `.disconnect-btn:hover` (was hardcoded `#c82333`),
  `.delete-btn:hover` (SettingsView + RolesSection),
  `.row-delete:hover` (SessionList), `.attach-remove:hover` (ChatView).
- `src/components/ChatView.vue` — `.send-btn` colour/background transition
  removed; the armed state snaps like every other flat control instead of
  spending 150 ms in an illegible in-between.

### Result — `scripts/e2e_white_text.py` → **21/21**

```
PASS  dark .disconnect-btn (App.vue:794): contrast >= 4.5  (after 5.38:1, fg rgb(33,29,26) on rgb(217,119,95))
PASS  dark .send-btn (ChatView.vue:980): contrast >= 4.5     (after 5.40:1, fg rgb(33,29,26) on rgb(224,116,80))
PASS  dark .agent-item .delete-btn (SettingsView.vue:621 :hover): contrast >= 4.5  (after 6.40:1, fg rgb(33,29,26) on rgb(224,138,112))
PASS  light .disconnect-btn: 5.69:1 · light .send-btn: 4.59:1 · light .delete-btn :hover: 7.12:1
21/21 assertions passed
```

## Fix 2 — card `b676d4d3`: block/unblock is one action

### The rule (one sentence)

`blocked` is a flag on the card, never a column: setting or clearing it is
one atomic write — flag and reason together — that does not move the card,
and a flagged card stays in its stage, visibly marked, refused by every
dispatcher until the flag clears.

### What was broken

- `setCardFlag` wrote the flag only; callers then wrote `blockedReason` in
  a second mutation (`review.ts` applyDerived, CardDrawer's Apply path and
  flush) — two writes between which the board showed the inconsistent pair
  (`blocked=true` with no reason, or a reason with no flag).
- `porch-dispatch` (the orchestrator's dispatch path) vetted only live
  claims — a `blocked`/`cancelled` card was still handed to an agent.
- `boardctl block/unblock`, `acp-runner.mjs` pickup (`if (card?.blocked ||
  card?.cancelled) continue`), `boardctl next/claim` and `pmgraph` already
  implemented the flag-not-column rule; the UI already renders the mark
  (badge, danger edge, `N blocked` column counter, Links tab).

### Changes

- `src/stores/board.ts` — `setCardFlag(id, flag, on, reason?)` writes flag
  and reason in the same mutation (reason overrides; clearing the flag
  clears the reason, mirroring `boardctl block/unblock`); a reason update
  on an already-flagged card still lands in one write.
- `src/stores/review.ts` — `applyDerived` uses the atomic call; clearing a
  review-owned mark clears flag+reason together.
- `src/features/board/CardDrawer.vue` — Apply-transition and flush pass
  the draft reason through `setCardFlag`; the trailing `updateCard` write
  can no longer resurrect a stale reason on a card that was just
  unblocked.
- `scripts/porch-dispatch` — `check_card_free` now refuses `blocked`
  (naming the reason) and `cancelled` cards, same as a foreign claim.

### Result — `scripts/e2e_dispatch.py` → **56/56** (new leg 5b)

```
PASS  flag rule: boardctl block exits 0
PASS  flag rule: block lands flag+reason, card keeps its stage      (blocked=true, "e2e hold", stage=dev, status=in_progress)
PASS  flag rule: dispatcher refuses the flagged card                ({"ok": true, "runs": []})
PASS  flag rule: no card dir was created for the flagged card
PASS  flag rule: still blocked in dev after the refused pass
PASS  flag rule: boardctl unblock exits 0
PASS  flag rule: unblock clears flag+reason, stage untouched        (blocked=false, reason="", stage=dev)
PASS  flag rule: dispatcher takes the card again once cleared       ([{"card": "card-flag", "exitCode": 0, ...}])
PASS  flag rule: run ended and claim released
PASS  flag rule: card is not flagged after the successful run
```

The block/unblock pair went through the real `boardctl` one-write path
against the suite's own state server; the card sat in `dev` the whole
time — flagged, refused, then eligible again — never an intermediate
"flag without stage/stage without flag" frame.

## Full suite — `scripts/e2e_all.py`

```
===== summary
all E2E scripts passed
```

21 suites green in this tree, including the extended dispatch suite and
the review suite that exercises the atomic flag path end-to-end.
