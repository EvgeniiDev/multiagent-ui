# Visible preparation progress — 2026-10-04

After Start brainstorming the drawer retained its scroll position. The longer
live panel put documents and settings in view while the discussion was above
the viewport. The first provider turn took approximately 25 seconds; there was
no prominent waiting indicator. Production state confirmed the Reddit session
was active and had successfully recorded its first question, awaiting an answer.

The panel now shows a sticky, accessible waiting indicator while the lead is
working, and a jump-to-discussion button while a question awaits an answer.
After a successful start it scrolls to the discussion, including when the
session arrives through a delayed refresh. Boolean progress is no longer
printed as a user-facing message. No backend or conversation data was changed.

Verification:

- Two regression assertions failed before the fix; preparation UI suite now
  passes 28 tests. Host frontend build passes; deployed asset:
  `index-Bjpo652Q.js`.
- Actual Chromium on the production Reddit card: its real saved question is
  visible, and the sticky button returns from the settings to that question.
  No answer or command was submitted to the user's session.
- Browser-only mocked slow kickoff verifies the wait indicator and automatic
  scroll after delayed session loading, without invoking a paid provider or
  changing production state. Computed sticky/background styles verified; no
  browser errors.
- Local browser evidence:
  `.agent-tmp/autonomous/browser-production/check_prep_wait.py` and
  `prep-user-question.png`.

Frontend deployed through the existing host `dist-web` mount, on branch
`ship/agent-modes-20261003`. No container restart was needed. Existing browser
tabs require reload.
