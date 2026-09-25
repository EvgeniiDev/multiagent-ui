# Chat scroll — land on the newest message when a session opens

Workstream `cc/w16-scroll`. Fix for: opening a session from the sidebar shows the
FIRST message while the rest "loads lazily"; the owner wants the NEWEST
immediately, without breaking the user's ability to scroll up during replay.

## The bug

`resumeSession` sets `messages.value = []`. The feed collapses, the container's
`scrollTop` clamps to 0, and `ChatView`'s auto-follow watch only re-pinned a feed
that was ALREADY within 40px of the bottom. The first replayed chunk taller than
40px killed the pin permanently — the view sat at the top while history streamed
in below.

F5/auto-resume recreated `ChatView` and was unaffected.

## The change — `src/components/ChatView.vue`

Replaced the "is it currently pinned" heuristic with an explicit **follow
intent** that survives the clear:

- `followBottom = ref(true)` — "the user wants the newest in view".
- Goes **true** on: mount, `currentSession.sessionId` change, right after the
  user sends a message, and when the message list is emptied (every
  open/switch path clears the feed first — the `sessionId` watch only lands
  after `session/load` resolves, too late to follow the replay itself).
- Goes **false** only when the user scrolls away from the bottom (distance >
  40px), **true** again when they scroll back.
- `onFeedWheel` flips it false on `deltaY < 0` — the wheel's scroll event
  lands a frame late, so a chunk arriving in between would otherwise read a
  stale "at bottom" and yank the feed back under the cursor.
- `pinFeedToBottom` records the `scrollTop` it wrote; `onFeedScroll` treats
  an event landing on that exact position as the pin (follow stays armed),
  not user intent. Position matching instead of a timed flag so a
  render-saturated replay can't stretch a guard window over a real user
  scroll.
- The messages watch pins whenever `followBottom` is true — no threshold
  check on where the feed currently sits. Deep watch, one `nextTick`, no
  debounce.

## The test — `scripts/e2e_session_restore.py`

Extended the mock agent to replay three long histories (28/30/26 turn pairs,
B and C dripped at 60/80ms so the test can scroll mid-replay) and added:

- F5: feed at bottom (`fromBottom <= 2`), last replayed message inside the
  viewport.
- Sidebar open while `ChatView` stays mounted: same two assertions (the
  failing case before the fix).
- Scroll-up mid-replay: wheel up, then `fromBottom` must stay positive and
  non-shrinking while more chunks arrive — no yank-back.
- Replay end: bottom + last message in viewport.
- Send from a scrolled-up position: returns to the bottom.
- Zero `pageerror` events.

Synchronization note: `page.wait_for_function` uses rAF-driven polling, which
starves while Vue saturates the main thread re-rendering the drip (the mock
agent replays ~60 markdown-parsed messages — O(n²) work per chunk). The
script polls with `page.evaluate` + `wait_for_timeout` instead, and waits on
session-specific text (`'C turn 12'`) rather than a raw message count, which
can observe the previous session's leftover DOM before the clear renders.

## Commands

```
npm run build:web
~/.hermes/tools-venv/bin/python scripts/e2e_session_restore.py
```

## Before — buggy build (tail)

```
PASS  F5: feed pinned to the bottom  (fromBottom=0px)
PASS  F5: last replayed message inside the viewport  (True)
PASS  sidebar open: replayed a long history  (60 messages)
FAIL  sidebar open: feed lands on the bottom  (fromBottom=3499px)
FAIL  sidebar open: last replayed message inside the viewport  (False)
...
FAIL  replay end lands on the newest message  (fromBottom=2935px)
FAIL  replay end: last message inside the viewport  (False)
PASS  scrolled up before sending  (fromBottom=2935px)
FAIL  sending a message returns the feed to the bottom  (fromBottom=3076px)
...
18/23 assertions passed
```

## After — fixed build (tail, two consecutive clean runs)

```
PASS  F5: feed pinned to the bottom  (fromBottom=0px)
PASS  F5: last replayed message inside the viewport  (True)
PASS  sidebar open: replayed a long history  (60 messages)
PASS  sidebar open: feed lands on the bottom  (fromBottom=0px)
PASS  sidebar open: last replayed message inside the viewport  (True)
PASS  replay streams in (enough messages to scroll)
PASS  scroll up mid-replay leaves the bottom  (fromBottom=756px right after the wheel)
PASS  scroll up mid-replay is not yanked back  (fromBottom 756px -> 1264px while chunks arrived)
PASS  replay end lands on the newest message  (fromBottom=0px)
PASS  replay end: last message inside the viewport  (True)
PASS  scrolled up before sending  (fromBottom=700px)
PASS  sending a message returns the feed to the bottom  (fromBottom=0px)
PASS  disconnect + reload stays on the welcome screen
PASS  disconnect clears the persisted pointer  (None)
PASS  zero pageerror events

23/23 assertions passed
```

| Assertion                              | Before             | After              |
| -------------------------------------- | ------------------ | ------------------ |
| F5 feed at bottom                      | 0px (already fine) | 0px                |
| Sidebar open lands at bottom           | 3499px off         | 0px                |
| Sidebar open last msg in viewport      | False              | True               |
| Scroll up mid-replay respected         | 332px → 811px      | 756/841px → 1264px |
| Replay end at bottom                   | 2935px off         | 0px                |
| Replay end last msg in viewport        | False              | True               |
| Send from scrolled-up returns to bottom| 3076px off         | 0px                |
| pageerror events                       | 0                  | 0                  |

## Not verified

- Mouse scrollbar drag mid-replay — the e2e drives a synthetic wheel. The
  scroll handler is gesture-agnostic (`onFeedScroll` derives intent from
  position), but no test drags the actual scrollbar.
- Touch scrolling on mobile viewports — same reasoning; `wheel`/`scroll`
  coverage is desktop-simulated.
- Real agent (`server/acp-runner.mjs`) replay timing — verified against the
  mock's 60–80ms drip only.
- Very large histories beyond ~60 messages — the mock replays 26–30 turn
  pairs; no stress beyond that.
- Scroll anchoring while images/iframes load asynchronously — not covered.
