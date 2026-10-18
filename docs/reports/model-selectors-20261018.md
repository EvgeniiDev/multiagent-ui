# Pi model selection and separate Codex reasoning

Code revision: `b0833e28f89c3311ef685edd9079e8b971172534` on `main`.
Built from the isolated checkout `/tmp/acp-model-selectors`, based on
`d69e36e`. The original working tree's unrelated bridge/server edits were
neither committed nor deployed.

## Confirmed causes

- Pi ACP 0.0.33 advertises model configuration but rejects
  `session/set_model` with JSON-RPC `-32601`, `Method not found`.
  A direct request to `session/set_config_option` succeeds. The frontend
  always used the rejected method; its handler only logged errors.
- Codex advertises both legacy combined model IDs such as
  `gpt-6.1-sol[medium]` and separate `configOptions` for `model` and
  `reasoning_effort` (`thought_level`). The frontend used the legacy list
  and ignored configuration updates.

The runtime now prefers the advertised model configuration and sends its
actual configuration ID to `session/set_config_option`. It consumes config
options on new/load, change responses and agent notifications. Agents without
model configuration keep the legacy method. Reasoning uses shared `UiSelect`,
with duplicate Pi legacy thinking modes hidden. Pending config requests disable
settings, failures keep confirmed values and show a visible error. Late RPC
responses cannot replace configuration on a disconnected runtime.

## Verification

- `npm run build:web`: shared UI policy, TypeScript and production build pass.
- `git diff --check` and `node --check scripts/test_model_config_browser.cjs`: pass.
- `scripts/test_model_config_browser.cjs`: six browser cases, Pi/Codex/legacy
  at 1440 and 390 pixels, light/dark themes. Passed against the candidate and
  then against published assets at `https://192.168.1.222:25809`.
  ACP/state fixtures exercise real UI controls: model selection, separate
  reasoning, pending disabled state, keyboard focus, touch size, notification
  updates, rejected changes with a visible error, and reload. Pi's duplicate
  legacy thinking selector is absent. No JavaScript page errors.
- The same regression against the old published bundle timed out waiting for
  the selected Pi model to change after clicking another model. Direct live
  RPC reproduced the exact method-not-found response.
- Real browser/bridges, isolated test inventory and no prompts: Pi selected
  `opencode/gpt-6.1-sol`, reported thinking `high`, and restored both after
  reload. Test session `01a14fcf-d9cb-7537-b2ea-bd58f7480e1a`.
- Real Codex accepted `gpt-6-astra` and reasoning `high` independently, with
  both returned in configuration responses and shown in their own controls.
  Test session `01a14fd0-b518-7ad0-8d40-076244b84b58`. Zero page/JSON-RPC
  errors; the two HTTP404s were reads of the absent test-session shared
  history cache (`history-3ea10c2-a9c2b5e0.json`), handled as a cache miss.

The first live Pi thinking check requested high on
`zen-relay/mimo-v2.6-flash-free`; Pi returned `off` because it clamps thinking
to model capabilities. The UI correctly showed that confirmed value. The
check was then performed on a reasoning-capable model.

Empty Codex test sessions returned the adapter defaults (`gpt-6.1-sol`,
`medium`) after reload despite accepting changed settings beforehand. The UI
shows that server state. Durable Codex selection after a real prompt was not
tested; no provider generations or user-session prompts were sent. This change
does not alter adapter persistence.

## Publication

Published only frontend files to the inspected bind mount
`/home/hermes/projects/acp-ui/dist-web`; retained old hashed assets and replaced
`index.html` last. Served index and entry assets match the release byte for
byte (HTTP200):

- `/assets/index-DSp0Uu7y.js`: SHA256
  `657cbd485ff5db4aae1d499893425a113cd9161c4953a68ca84eeff994868332`
- `/assets/index-BCZrzSMv.css`: SHA256
  `1678764873919c5017113e029bba27b31ea010f301f12bce762a2e2706e29e3a`

Web image unchanged:
`sha256:2f17fc044b579bab302c2e8054d3a686e2cb9a83de48e70534b94cd8ebbe06a9`.
No services were restarted. Bridge PIDs before and after publication:
Hermes 1901671, OpenCode 1902227, Devin 1902451, Pi 1664757, Codex 1024589.
Reload an existing panel tab to load the new frontend.
