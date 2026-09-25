# History tail cache — open on the newest instantly

Branch `cc/w17-https` · repo `acp-ui-w17-https`.

## The problem

ACP `session/load` accepts only `{cwd, mcpServers, sessionId}` — no offset,
limit, or tail parameter — and replayed `*_message_chunk` notifications carry
no sequence numbers (verified against
`node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts`). The
agent always streams the whole transcript top-down, so "show the newest
message immediately" cannot come from the protocol — only from a client-side
copy.

## What changed

**`src/lib/historyCache.ts` (new)** — localStorage tail cache.

- Key: `acp-ui:history:<agent>::<sessionId>`.
- Entry: `{version: 1, savedAt, userTurnBase, messages}` capped to the last
  **100** messages, oldest dropped first.
- `userTurnBase` records how many user turns lived below the tail —
  `attachmentHistory.ts` correlates files by full-session user-turn ordinal,
  so a truncated tail needs the offset or images would merge onto the wrong
  turns.
- Attachment bytes are stripped on write (`previewUrl`/`body` removed —
  a handful of data-URL images would blow the budget alone); `cachePath`
  pointers survive and resolve lazily on open, exactly like a replay.
- Every read/write is wrapped — quota-full, private mode, corrupt JSON all
  degrade to "no cache", never to a broken chat.
- `evictHistoryCaches()` (run once at store init) drops entries older than
  **7 days** or corrupt, then caps the whole cache at **2 MiB**, evicting
  oldest sessions first. Returns `{removed, entries, chars}` for reporting.

**`src/stores/session.ts`** — wiring.

- `resumeSession` reads the cache synchronously **before** the network work:
  the tail renders immediately under a "Loading history…" marker, and
  `replayMerge` is armed so `handleSessionUpdate` routes the coming replay
  into a side buffer instead of appending it under the cache.
- On `session/load` resolve, `settleReplayMerge` runs the reconciliation:
  the replay is the truth. It searches for the cached tail as one contiguous
  slice aligned on the last cached user message; on a match it swaps the
  replayed transcript in wholesale (reusing cached message ids so identical
  rows keep their DOM nodes — no flicker, no duplicates, tool calls matched
  by `toolCallId`), so an extended tail from a second device just grows
  below. No alignment = diverged history (compressed, rewound): the entry
  is dropped and only the fresh replay renders.
- `abortReplayMerge` (transport drop / `session/load` reject) keeps the
  cached tail on screen, honestly marked `stale`.
- Write-through: `throttledHistoryFlush` (≤1 write/2 s) follows streamed
  chunks, `watch(isLoading)` flushes on every settled turn, `disconnect`
  flushes once before dropping the transcript.
- `createSession` drops any tail for the new id (agents may recycle
  sessionIds) so an old cache can't resurrect as a fresh session's history.

**`src/components/ChatView.vue`** — a quiet centered `.history-note` at the
top of the feed (`Loading history…` / `Couldn’t reach the agent — showing
the cached copy`, `data-state` for tests); composer textarea, attach, voice
and send are disabled while `!isConnected`, so a stale cached view can't be
sent into. Follow/scroll intent is untouched — only what feeds it changed.

**`src/App.vue`** — `ChatView` mounts when `isConnected || historyCacheNote`
(a cached tail must render even when the connection never came up).

**`scripts/e2e_history_cache.py` (new, port 25977)** + registration in
`scripts/e2e_all.py`.

Untouched as required: `server/acp-runner.mjs`, `server/acp-state-server.mjs`,
`server/https-front.mjs`, the voice pipeline, `src/lib/attachmentHistory.ts`.

## Commands run (output tails)

### `npm run build:web`

```
dist-web/assets/index-3_4LkRB8.js   569.93 kB │ gzip: 198.13 kB
✓ built in 3.67s
```

(`vue-tsc --noEmit` phase: exit 0.)

### `~/.hermes/tools-venv/bin/python scripts/e2e_history_cache.py`

40 assertions, mock agent (`session/load` drips a 62-pair transcript at
~22 ms/message; modes switch between reloads: `full`, `kill10` = ws dies
after 10 pairs, `extra` = +2 newer turns + tool call, `diverged` = 4-message
compressed transcript without the cached anchor).

```
PASS  cold open: full replay renders
PASS  cold open: all 62 pairs in the feed  (124 messages)
PASS  cold open: feed pinned to bottom  (fromBottom=0)
PASS  cache entry written under acp-ui:history:<agent>::<sid>
PASS  cache capped at the last 100 messages  (100 cached)
PASS  cache tail is the newest message  ('HC-LAST-MARKER')
PASS  cache tracks the tail's user-turn offset  (userTurnBase=12)
PASS  stale + corrupt entries evicted on init
PASS  cached open: tail paints before any replay chunk
PASS  cached open: last message in view <1s after first paint  (28ms)
PASS  cached open: newest visible WHILE the replay still streams  (note=loading)
PASS  cached open: loading-history marker shown
PASS  cached open: feed pinned to the cached newest  (fromBottom=0)
PASS  replayed replay settles (marker clears)
PASS  settled: full history rendered once  (124 messages)
PASS  settled: no duplicated rows  ('remember me (cache turn 30)' x1)
PASS  settled: cached tool-call chip not duplicated  (1)
PASS  killed replay: tail stays, marked 'stale'  (note=stale)
PASS  killed replay: cached 100 messages render  (100 messages)
PASS  killed replay: newest known message still last  (True)
PASS  killed replay: feed pinned to cached newest  (fromBottom=0)
PASS  killed replay: error banner instead of a fake 'live' view
PASS  killed replay: composer disabled while offline
PASS  cache renders while extended replay streams
PASS  second device: replay settles
PASS  second device: tail grew below the cache  (128 messages)
PASS  second device: newest turn is last and in view
PASS  second device: no duplicated rows  (mid x1 anchor x1)
PASS  second device: both tool-call chips, no dupes
PASS  second device: cache rewritten to the extended tail
PASS  diverged: replay settles
PASS  diverged: fresh transcript renders  (4 messages)
PASS  diverged: newest live text visible
PASS  diverged: stale anchor text is GONE  (anchor x0)
PASS  diverged: stale cache entry replaced by the fresh tail
PASS  cache does not grow unboundedly (one live entry)  (['acp-ui:history:E2E Mock::e2e-cache-session'])
PASS  quota-full setItem: chat still opens and replays
PASS  quota-full: full replay rendered  (124 messages)
PASS  quota-full: no history entry written, no crash
PASS  zero pageerror events

40/40 assertions passed
```

(One harness-level `greenlet.error` line appears in stderr when the drip
thread's `ws.send` races a page reload — playwright internal noise, not a
page error; the assertion count is unaffected.)

### `~/.hermes/tools-venv/bin/python scripts/e2e_session_restore.py`

```
PASS  replay end lands on the newest message  (fromBottom=0px)
PASS  replay end: last message inside the viewport  (True)
PASS  disconnect + reload stays on the welcome screen
PASS  disconnect clears the persisted pointer  (None)
PASS  zero pageerror events

23/23 assertions passed
```

### `~/.hermes/tools-venv/bin/python scripts/e2e_session_url.py`

```
PASS  reload with ?s=<good> replays THAT session's transcript
PASS  disconnect clears ?s from the URL  (None)
PASS  zero pageerror events

8/8 assertions passed
```

## Open latency — own run

Same mock, same 124-message transcript, measured in the e2e itself:

| open | metric | value |
|---|---|---|
| cold (no cache) | `page.goto` → last message rendered & replay done | **3.09–3.17 s** |
| warm (cached) | first message paint → LAST message in viewport, replay still streaming | **23–28 ms** |

The mock drips at a fixed 22 ms/message; a real agent's replay is slower to
serialize, so the delta widens on real sessions — the cached tail is painted
before the connect even resolves, independent of replay length.

## Bound-cache evidence

The e2e seeds two bait entries (`acp-ui:history:…::e2e-stale-old` — 8 days
old — and `…::e2e-corrupt` — invalid JSON). After init:

```
PASS  stale + corrupt entries evicted on init
PASS  cache does not grow unboundedly (one live entry)
      (['acp-ui:history:E2E Mock::e2e-cache-session'])
```

Per-session cap demonstrated by `cache capped at the last 100 messages`
(124 replayed → 100 cached, `userTurnBase=12` for the 12 user turns below
the tail). The 2 MiB whole-cache cap path is exercised by
`evictHistoryCaches` (oldest `savedAt` first) but not driven over budget in
the e2e — see below.

## Not verified (honestly)

- **Real-agent replay duration.** Latency numbers are against the mock's
  22 ms/message drip. The mechanism doesn't depend on replay speed (the
  cache paints before `session/load` resolves), but the absolute "before"
  number will differ against a real agent.
- **>2 MiB multi-session eviction.** The size cap is implemented and the
  oldest-first ordering is in `evictHistoryCaches`, but the e2e only proves
  age/corruption eviction and the single-entry steady state — not a real
  over-budget sweep across many sessions.
- **Attachment bytes in the cached tail.** Ordinal correctness
  (`userTurnBase`) is asserted numerically and the lazy `cachePath`
  resolution path is the same code replay uses, but no image turn was run
  through the cache in the e2e.
- **Scroll-up into the head beyond the tail.** Out of scope by design —
  the replayed transcript swaps in wholesale, so up-scroll works after
  settle; paging an unseen head is a follow-up.
