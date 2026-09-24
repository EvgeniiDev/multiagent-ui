# W14 — Images from a session's history are not restored on replay

Branch: `cc/w14-images` · tree: `/home/hermes/projects/acp-ui-w14-images`

## Root cause — two separate losses, proven independently

**Panel side (proven by the e2e "before" run below).** On `session/load` the
agent replays history as `session/update` notifications whose
`user_message_chunk` / `agent_message_chunk` carry a `ContentBlock`
(`{type:'image', data, mimeType, uri}` for images). `handleSessionUpdate` in
`src/stores/session.ts` only handled `content.type === 'text'` — every
non-text block was silently dropped. An image block with real base64 bytes
arrived and nothing rendered.

**Agent side (matches the owner's observation).** Agents that flatten history
into message text echo a text file's body but not image bytes — the existing
`extractReplayedAttachments` comment already documented "only text
attachments survive a replay". For those, the panel kept no record of its own
and nothing could be restored.

## Changes

- `src/lib/types.ts` — `AttachmentMeta` gains `unavailableReason` (explicit
  "which file + why" placeholder) and `cachePath` (pointer to local-cached
  bytes).
- `src/lib/attachments.ts` — image markers recovered from echoed text now
  carry `unavailableReason` instead of a junk `body` (the text after an image
  marker is prose, not bytes). New `attachmentFromContentBlock()` turns any
  non-text `ContentBlock` into attachment metadata: `image`/`resource`(blob)
  with bytes → renderable preview; empty image block, image-ish
  `resource_link`, and `audio` → named placeholder with a reason.
- `src/lib/attachmentHistory.ts` (new) — the panel's own record of which
  files rode on each user turn, persisted in `attachments.json` (the shared
  KV doc every device reads). Keyed `agent::sessionId` → user-turn ordinal →
  attachment metas. Bytes go inline while the serialized doc stays under
  3 MiB (the state server 413s at 5 MiB); larger payloads are written to a
  local cache — `cache:` under the OS cache dir via plugin-fs on Tauri,
  `local:` localStorage key on web (the browser build has no fs) — and the
  record keeps `cachePath`. When neither fits, metadata + a reason remain, so
  history still says WHICH image is missing. `prune()` evicts oldest bytes
  first if the doc grows past budget.
- `src/stores/session.ts` — `initStore` loads the attachment history;
  `sendPrompt` records the turn's files against its user-turn ordinal;
  `handleSessionUpdate` routes non-text content blocks on `user_`/`agent_`
  `message_chunk` into `message.attachments` and merges the persisted record
  into each new replayed user turn (ordinal correlation — works while
  `currentSession` is still null mid-replay); `deleteSession` drops the
  session's records.
- `src/components/ChatView.vue` — `renderedMessages` dedupes marker-derived
  attachments against real/recorded ones by name+kind (keeps the entry with
  bytes); the attachment line renders `unavailableReason` as an explicit
  missing placeholder, and "no preview in history" now only shows when there
  is genuinely no preview (previously it printed under every image).
- `scripts/e2e_history_images.py` (new, own port **25980**) — stub WS agent
  owns `session/list` + per-session `session/load` replays; asserts real
  `naturalWidth > 0` bytes for a replayed image block, named placeholders for
  three unrecoverable shapes (marker, empty image block, resource_link), zero
  placeholders for text-only, and that an image the panel sent survives a
  full page reload restored from the panel record (the agent replays the turn
  text-only). Prints transcript contents on failure; exits non-zero on
  failure. Registered in `scripts/e2e_all.py`.

## Verify — before (honest failure)

`npm run build:web && ~/.hermes/tools-venv/bin/python scripts/e2e_history_images.py`

```
FAIL  replayed image block renders an <img>  ({"messages": ["Youwhat is in this image?", "E2E Mockit is a cat."], "blocks": [], "imgs": [], ...})
FAIL  3 lost images each render a named placeholder  (blocks=[{"text": "imageghost.pngno preview in history", "note": "no preview in history"}] msgs=[...])
PASS  no lost image pretends to render  ([])
PASS  text-only session has no attachment blocks  (...)
PASS  sent image block reached the agent  (...)
FAIL  after reload the panel record restores the <img>  ({"messages": [... "Youdescribe it" ...], "blocks": [], "imgs": [], ...})
PASS  zero pageerrors  ([])

4/7 assertions passed
```

The agent offered a real image block (`imgs: []` — panel-side drop proven),
the empty-block/link cases vanished entirely (not even placeholders), and the
sent image was lost on reload (no record).

## Verify — after

`npm run build:web` → `vue-tsc --noEmit` clean, `✓ built in ~3s`.

`~/.hermes/tools-venv/bin/python scripts/e2e_history_images.py`

```
PASS  replayed image block renders an <img>
PASS  replayed <img> has real bytes (naturalWidth > 0)  (w: 64)
PASS  replayed <img> is the sent file (cat.png)
PASS  3 lost images each render a named placeholder  (ghost.png / gone.png / shot.png, each with a reason)
PASS  no lost image pretends to render
PASS  text-only session has no attachment blocks
PASS  sent image block reached the agent
PASS  after reload the panel record restores the <img>  (w: 32, alt cat.png)
PASS  zero pageerrors

9/9 assertions passed
```

Regression spot-checks on neighbouring suites:

```
e2e_live_stream.py   8/8 assertions passed
e2e_auto_approve.py 15/15 assertions passed
```

## Not verified live (honest list)

- **Real Hermes replay shape.** The stub asserts the panel honours whatever
  the agent sends — bytes as `image` blocks → rendered; markers/links/empty
  blocks → named placeholders; nothing → restored only via the panel's own
  record (which covers panel-sent turns). If the real agent replays images in
  yet another shape (e.g. a URI scheme the panel could actually resolve), the
  placeholder names it rather than fetching — by design.
- **Both cache paths (`cache:` Tauri / `local:` web).** Code-reviewed only —
  no e2e fixture exceeds the inline budget, so neither cache write nor
  `resolveCachedBytes` ran. The plugin-fs `AppCache` write/read is
  straightforward but ran in no desktop shell here.
- **>768 KiB / doc-cap images.** The size-cap eviction and cache-dir path are
  unit-level logic; the e2e uses small PNGs (the assertable surface — img vs
  named placeholder — is identical).
- `e2e_composer.py` currently fails on this host — **pre-existing and
  unrelated**: it doesn't block :25900, the live `preferences.json` has
  `activeView: "board"`, so the suite opens on the Board view with the
  sidebar hidden and times out on `.new-session-btn`. It is not in
  `e2e_all.py`. Verified via `curl :25900/api/state/preferences.json`.
