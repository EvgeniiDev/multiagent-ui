# Speech stream release — 8 October 2026

Fixed frontend transcript assembly and recording lifecycle races. Partial
responses are full committed/volatile snapshots, not incremental chunks.
The overlay previously joined words without separators; the deployed baseline
reproduced `До Распознавание речиработает стабильноПосле`. Word boundaries now
match the inserted final text, preserving typed text on both sides of the caret.
Anchor updates follow actual text edits rather than total length/caret guesses.

StreamingStt ignores duplicate finals and messages after final/close. VoiceInput
checks the recording generation and session identity in microphone, WebSocket,
audio and final-timeout callbacks. An old permission request or connection cannot
stop a newer recording. Sending still waits for the final/fallback transcript
before clearing the composer. The microphone uses the shared UiButton primitive.

PCM sends now respect an Int16Array view rather than its entire backing buffer.
This is a verified robustness fix; the current producer uses fresh buffers, so
it was not established as the cause of the reported repeated fragments.
Chunking and resampling tests found no duplicated samples at 44.1/48 kHz.
The recognition service itself was unchanged.

## Verification

- 13 regression checks passed: four stream lifecycle/PCM-view checks, three text
  insertion/anchor checks, two audio continuity checks and four send checks.
  The original stream implementation failed the terminal-state and PCM-view
  regressions. Type checking and the web build passed.
- Actual deployed frontend at https://192.168.1.222:25809, Chromium with a fake
  microphone exercising capture/resampling/PCM transport and controlled STT
  WebSocket responses: revised hypotheses, final exactly once, repeated takes,
  delayed final during send, late permission rejection, connection loss and
  missing-final timeout all passed. PCM packets were at most 100 ms.
- Light/dark overlay font, line height and padding match the input; microphone
  touch target is 44 × 44 px. No page or ACP RPC errors. One activity PUT409
  recovered with PUT200. ACP reads were real; send/steer were stubbed and live
  model prompts blocked. Human-voice recognition accuracy was not tested.

## Publication

Built inside the agent container with
`npm run build:web -- --outDir .agent-tmp/voice-stream-release/dist-web`.
Source checkout: main, base dc31163094eaa92a846bf4c8f05c3d11e7c14e33 plus
uncommitted source hashes recorded in the deployment evidence. Affected sources
were synchronized to /home/hermes/projects/acp-ui-lead-integration on
ship/agent-modes-20261003. Its dist-web is the running web container's bind mount.
Published via the existing bridge's writable mount; old hashed assets retained,
index replaced last. No service restart. Served HTTPS bytes matched the build.

- JavaScript: index-DDS8gTrk.js, SHA-256
  9f63be66e2d3be5fc7cb08f271316fe76daf601f9ceee7ffc73464c6950a19c9.
- CSS: index-DP5_e0aj.css, SHA-256
  6e559f2cb6c6f60cede3966f88e3c15090d79406fbe71a9bacd5d46cbdaaf13e.

Detailed browser evidence, build assets and deployment metadata are in
.agent-tmp/voice-stream-release/. Existing tabs need a reload.
