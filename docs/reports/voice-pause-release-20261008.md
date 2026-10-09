# Speech pause follow-up — 8 October 2026

The previous frontend release did not cover long pauses against the real STT
backend. The reported failure was reproduced in the server contract tests and
with the actual recognizer. The old stream re-decoded the latest six seconds;
its stable-prefix rule compared word counts, allowing an unrelated phrase with
an equal or greater settled word count to replace previously committed text.
It also suppressed later phrases when they did not contain the old prefix.

The user's latest stream at 14:27 failed its final pass after crossing 24 seconds:
GigaAM longform imported pyannote/Lightning/Torch code that called `os.getcwd()`
and raised FileNotFoundError. The old fallback only caught RuntimeError. The
browser then displayed its generic connection-loss banner, obscuring this cause.
The real baseline fixture (36.58 seconds, including a 14-second silent pause)
reproduced the backend error and failure to accumulate the second spoken copy.

## Change

Replaced the rolling window/prefix heuristic with bounded PCM phrases. A pause
of 0.8 seconds below the energy threshold finalizes a phrase; only finalized
phrases enter the cumulative committed string. The current phrase remains a
replaceable volatile hypothesis. Stop decodes only the outstanding phrase and
appends it to earlier committed phrases, rather than re-transcribing the entire
take. Each phrase is capped at 20 seconds, avoiding the longform dependency in
streaming. The separate one-shot longform fallback now also handles import and
OS failures. Disconnected clients no longer trigger an unnecessary final decode.

The segmenter processes 20 ms PCM frames independently of WebSocket packet size,
retains 200 ms leading/trailing padding, and preserves the final short tail.
Silent recordings receive a clean empty final without invoking the recognizer.
Audio reception now runs independently from inference. A repeated real browser
run exposed a further failure: sequential partial inference delayed reading stop
until after the frontend’s nine-second final timeout. The receiver now keeps
consuming PCM and stop while one inference worker coalesces obsolete snapshots.
All audio is retained, finalized phrases are decoded once, and hypotheses from
before a pause/reset cannot replace the next phrase.

The model and frontend bundle are unchanged. Fixed energy thresholds and forced
20-second boundaries remain limitations for continuous speech or background
noise; this verifies pause retention, not unrestricted recognition accuracy.

## Verification

- Eight server regression tests passed. Before the fix the pause-retention,
  long-take, bounded-decode, silent-take and offline-import fallback checks failed.
  Checks also cover subsecond stop tails, arbitrary transport boundaries and
  reading stop while a deliberately blocked decoder is still running.
- All 13 existing client audio/text/stream/send regressions passed. The send
  failure test deliberately logs its simulated error.
- Real GigaAM/TLS stream: official example.wav spoken twice with a 14-second
  pause, total 36.58 seconds. Baseline ended with an error; updated service
  returned one normal final containing both copies and a monotonically growing
  committed prefix.
- Actual deployed mobile frontend in Chromium: the same speech WAV supplied
  through the microphone capture path, real WebSocket and recognizer, no STT
  mocks. The first phrase remained throughout the pause and second phrase;
  both copies landed exactly once, typed prefix/suffix survived, and stopping
  produced a normal final without a voice error. No model prompts were sent.
  Latest capture: 38.14 seconds; normal final at 40.28 seconds from connection
  start. No page, RPC or STT errors. One independent activity PUT409 recovered
  with PUT200. Detailed observations are in the browser evidence.

Official audio fixture source:
https://cdn.chatwm.opensmodel.sberdevices.ru/GigaAM/example.wav
(as referenced by the installed GigaAM helper).

## Deployment

Source: /home/hermes/projects/acp-ui, main, base commit
`dc31163094eaa92a846bf4c8f05c3d11e7c14e33`, with uncommitted source hashes in
.agent-tmp/voice-pause-release/deployment.json. Updated server source and tests
were also synchronized to the release checkout on ship/agent-modes-20261003.

Only STT was recreated using Compose:
`/tmp/acp-docker-compose --project-directory /home/hermes/projects/acp-ui -p acp-ui up -d --no-deps --force-recreate stt`.
A subsequent `docker compose restart stt` applied the inference-queue fix while
retaining the downloaded checkpoint. The first recreate attempt omitted the explicit project directory and resolved the
compose file's mounted path to /repo, producing a wrong host bind and startup
failure. Corrected before acceptance checks; the final container retains the
original host checkout → /repo mount. Recreating also required a fresh checkpoint
download into the container cache; /health was confirmed loaded before testing.

Running container ID:
`880683d6ab6c9832819fb91c2f470dc9eee6b1ace4e58fdf868db630c766419d`.
Image unchanged:
`sha256:74eb3da0ed453ac5c375d93ab51148e9134be267cb3c03475776e6ed7b3db0f2`.
Runtime source hashes matched the checkout. Health reports segmentation=pause,
window_s=20, pause_s=0.8. Other Compose services were not updated. The frontend
continues serving index-DDS8gTrk.js from the previous verified release.

Commands and evidence: scripts/test_stt_server.py,
.agent-tmp/voice-pause-release/{baseline,deployed,browser-evidence,deployment}.json.
