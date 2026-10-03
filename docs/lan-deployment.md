# LAN deployment (web build + filesystem-aware ACP bridges)

This fork adds everything needed to run ACP UI as a **self-hosted web panel on a
LAN box**, driving agents that live on that same machine — including a directory
tree picker for the working directory and relative paths.

Upstream's web build can only talk to remote agents over `ws://`, and its working
directory field is free text interpreted on the agent's host. That works, but you
have to remember absolute paths and there is nothing to browse. The bridge in
`deploy/` closes both gaps:

```
browser ──HTTP──▶ acp-ui-web (:25808, static dist-web/)
   │
   └──WS───────▶ acp-ws-bridge (:25901..04) ──stdio──▶ hermes acp / opencode acp / devin acp / pi-acp
                      │
                      └──HTTP /api/fs/* (directory listing for the tree picker)
```

## Layout

| Component | Port | Unit |
|---|---|---|
| Web bundle (static) | 25808 | `acp-ui-web.service` |
| Bridge → Hermes (`hermes acp`) | 25901 | `acp-bridge-hermes.service` |
| Bridge → OpenCode (`opencode acp`) | 25902 | `acp-bridge-opencode.service` |
| Bridge → Devin (`devin acp`) | 25903 | `acp-bridge-devin.service` |
| Bridge → Pi (`pi-acp` adapter) | 25904 | `acp-bridge-pi.service` |
| Bridge → Codex (`codex-acp` adapter) | 25907 | `acp-bridge-codex.service` |

Codex needs its own auth on the box (`codex login` or `OPENAI_API_KEY` in
the bridge environment) — without it the bridge starts but every session
fails.

Ports are arbitrary; if you change them, update `BRIDGE_PORTS` in
`src/lib/host/index.ts` so the seeded default agents point at the right sockets.

## Install

```bash
# 1. Build the web bundle (dist-web/)
npm install
npm run build:web

# 2. The bridge needs a WebSocket server implementation
npm install -g ws

# 3. Agent CLIs must be on PATH. Pi has no ACP mode — install the adapter:
npm install -g pi-acp

# 4. Install the bridge, units, and start everything
./deploy/install.sh

# 5. Open http://<lan-ip>:25808
```

The units are **user-scope** (`systemctl --user`) and need `loginctl enable-linger
<user>` to survive logout / start at boot:

```bash
loginctl enable-linger "$USER"
```

## Working directory: tree picker + relative paths

* The **📂 button** next to the path field opens a directory tree rooted at the
  bridge's `--root` (default: the agent user's home). It lists directories only,
  hides dot-directories behind a *hidden* toggle, and scopes every request to the
  root subtree — a path outside the root returns `403`.
* **Relative paths** are accepted in the field (`projects/notes`, `.hermes`,
  `../srv/app`). The bridge resolves them against `--root` when it sees
  `session/new` and forwards an absolute `cwd` to the agent. Absolute paths pass
  through untouched.
* `session/new` for a cwd is not cached by the app: switching the folder and
  creating a new session is enough.

HTTP API exposed by each bridge (same port as its WebSocket, CORS `*`):

| Endpoint | Response |
|---|---|
| `GET /api/fs/root` | `{ root, home }` |
| `GET /api/fs/list?path=<abs or rel>&hidden=1` | `{ path, parent, root, dirs: [{name, path}] }` |

## Pitfalls this fork already handles

1. **`@rebornix/stdio-to-ws` splits large frames.** It forwards each raw stdout
   chunk as one WebSocket frame; a JSON-RPC line larger than the 64 KiB pipe
   buffer arrives split mid-JSON across two frames, and clients that parse one
   JSON-RPC frame per message silently drop it (the request then hangs to its 60 s
   timeout). Pi's `session/new` carries a ~113 KB model catalog and trips this
   reliably. `deploy/acp-ws-bridge.mjs` buffers stdout and emits exactly one
   complete NDJSON line per frame.
2. **Frames to the agent must end with `\n`.** The bridge appends it when missing
   (the agent's stdin reader is line-oriented).
3. **`crypto.randomUUID` is unavailable on plain-HTTP LAN origins.** Only
   `https://`, `localhost` and `file://` are secure contexts, so on
   `http://192.168.1.x:25808` the browser hides it and session creation died with
   `TypeError: crypto.randomUUID is not a function`. `src/lib/uuid.ts` provides a
   `getRandomValues`-based fallback.
4. **A deleted systemd unit file keeps restarting its processes.** If you replace
   a unit, `systemctl --user stop <name>` before (or right after) deleting the
   file — the user manager keeps `Restart=always` state in memory and will
   resurrect the old process, holding your port.
5. **`python3 -m http.server` is enough** for the bundle, but it is plain HTTP and
   has no auth: anyone on the LAN can drive these agents. Bind it to a trusted
   network or put it behind a reverse proxy with auth if that matters.

## PM wakeup timer (optional, off by default)

`server/acp-pm-wakeup.mjs` runs one `pm` role session when — and only when —
the board changed since the last run and has been quiet for `PM_QUIET_MIN`
(default 10 min): unchanged or still-settling ticks cost a hash compare and
no model calls. Reference user units ship as `docs/acp-pm-wakeup.service`
(oneshot) and `docs/acp-pm-wakeup.timer` (every 30 min). To arm it:

```bash
install -m 0644 docs/acp-pm-wakeup.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now acp-pm-wakeup.timer   # owner's decision
```

Requires a `pm` entry in `roles.json` (its `cli`+`args` are what gets
spawned, cwd = the checkout). Every fired run lands in `activity.json` as
`kind: "pm"` entries with `role: "pm"`; artefacts live in
`.acp/pm/wakeup/<session>/`. Manual runs are untouched — a live pm claim
or fresh pm ledger activity makes the timer skip its tick.

## Updating

```bash
git fetch upstream
git merge upstream/main        # or: git rebase upstream/main
npm install && npm run build:web
systemctl --user restart acp-ui-web acp-bridge-hermes acp-bridge-opencode \
  acp-bridge-devin acp-bridge-pi
```
