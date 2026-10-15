# Live voice dictation — 15 October 2026

The user reported that recognition began only after Stop, unlike the previous
pause-based streaming input, and asked to restore visible progress without
fragments overwriting one another.

## Cause and implementation

The API migration in `5af8874` replaced WebSocket streaming with a client that
buffered the complete take and sent a single WAV at Stop. `VoiceInput` and
ChatView still supported partial snapshots, but the HTTP client never emitted
any. The live service matches the sibling project's app.py and engine.py hashes.
Its transcription route decodes every uploaded file independently: the loaded
model weights are cached, but there is no cross-request audio-prefix cache.
No recognizer source, image, lifecycle or deployment changes were required.

- PCM16/16kHz is framed in 20ms blocks, independent of capture packet boundaries.
  A pause of 800ms seals an utterance. Up to 200ms of leading/trailing silence is
  retained, and continuous speech has a hard 20s boundary. Final utterance audio
  partitions never overlap and finalized phrases are never re-decoded at Stop.
- During a continuous utterance, every 3s schedules a replaceable snapshot of
  only that utterance. There is one serial request and one latest pending preview;
  pending finalized phrases take priority. Sealing a phrase aborts its obsolete
  in-flight preview. The service may still finish inference after HTTP abort;
  this client does not claim to cancel its CPU work or reuse encoded prefixes.
- Committed phrases append in capture order; only the current hypothesis can be
  replaced. Epoch/utterance identity and disposed guards ignore stale results
  after seal/reset/close. Textual overlap heuristics are deliberately unnecessary;
  legitimate repeated words/phrases remain intact.
- Stop switches the mic off immediately and drains queued phrases and the tail.
  The aggregate is inserted into the draft once, at the moving dictation anchor.
  Existing edits on either side are retained. An error preserves the last visible
  text, reports an incomplete dictation, and prevents a Send in progress from
  submitting it automatically. A later explicit Send can submit the reviewed draft.
- Individual requests retain their timeout through body consumption. More than
  ten minutes of unmatched queued PCM stops recording with an explicit error,
  bounding memory if recognition cannot keep up. A synchronously completed Stop
  does not leave a redundant five-minute finalization timer.

## Verification

`node --test scripts/test_stt_stream.mjs scripts/test_chat_send.mjs
scripts/test_dictation_text.mjs` passed 30 checks. Coverage includes early phrase
recognition, replaceable hypotheses, serial ordering, stale replies, reset/close,
preview cancellation, timeout, bounded backlog, subframe/transport boundaries,
exactly-once final PCM partitions, intentional repeated text, failed final chunks,
and Send waiting or retaining incomplete dictation for review. The initial new
phrase tests failed against the old Stop-only client.

The browser regression `scripts/test_voice_stream_browser.cjs` uses actual audio
capture with a local WAV speech/pause/speech fixture, mocks ACP/state and never
prompts a model. It runs at 390px and 1440px, verifying two recognized phrases
before Stop, manual draft edits during recording, ordered final insertion, mic
state, graphite tokens and page errors. Mock inference tests additionally fail
the last phrase during Send and check that recognized text stays in the draft and
no model prompt is sent.

A separate mode uses the real HTTPS recognizer and OpenAPI probe on port 25906.
The synthetic Russian speech was generated locally with an extracted test-only
espeak-ng binary; no host package installation was performed. Both widths passed
with the candidate, showing nonempty committed words while the mic remained on
and preserving intentional repeated phrases. This verifies timing/integration,
not general ASR accuracy, word error rate, or a physical phone microphone.

Scoped reuse, quality and efficiency reviews completed. The efficiency findings
(obsolete preview blocking finals and unbounded queued PCM) were resolved and
rechecked. Isolated vue-tsc/Vite build passed with existing chunk advisories;
scoped CRLF-aware diff checks passed. Unrelated repository WIP was excluded.

## Publication

Implementation `a615af9c4eede17ea623557219435501a70715b3` on
`feature/pi-session-image-cleanup`. Compiled frontend inputs matched committed
sources byte for byte. Mount `/home/hermes/projects/acp-ui/dist-web` →
`/repo/dist-web` was inspected before publication; old hashed assets were retained
and index.html replaced last. Served index and entry assets matched build bytes.
No service/bridge was restarted.

Web image: `sha256:2f17fc044b579bab302c2e8054d3a686e2cb9a83de48e70534b94cd8ebbe06a9`.
Recognizer image unchanged: `sha256:186941f83f3924f2b590bf434d99ac080a77528d3a44f974f66dca3dbe29b45e`.

- `/assets/index-fGOG3ltu.js` — SHA-256 `16a6bc1362760706d6104984881fde4a96e65dcc140ff9e13be2579e25f56cd6`.
- `/assets/index-DjfPg1CA.css` — SHA-256 `176c09c8d691ff1ae24fab34db60c6c6d7453f5480c990fa1153152a61ed7272`.

The published-assets browser suite passed both widths in mocked mode (including
failure during Send) and in real-recognizer mode. Real transcription responses
were HTTP 200, no page errors or voice error state remained after successful
dictation, and recognized speech appeared before Stop. These tests use the
actual deployed assets with ACP/state mocked, not a paid model/conversation run.

Evidence: `.agent-tmp/voice-stream-release/`. Open tabs need reload. Actual phone
microphone/noise behavior and hard-boundary word accuracy remain device/model
checks; no claim of physical-device or general recognition-quality verification.
