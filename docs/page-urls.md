# Page URLs

| URL | Page |
|---|---|
| `/board` | Kanban board |
| `/chat?s=Pi%3A%3A<sessionId>` | Chat with the specified session |
| `/projects` | Projects |
| `/dashboard` | Dashboard |

An explicit page path selects the view synchronously, before preferences load, and wins over the saved `activeView`. Switching views creates a browser history entry. Back/Forward restores the view and, for a chat link with `s`, the corresponding known session.

The root `/` retains compatibility with saved preferences: after loading them it replaces its address with the chosen page path. Existing `/?s=<agent>::<sessionId>` links retain their session parameter and select that session while restoring the saved page. Session parameters and other query fields survive page navigation; a board link can therefore also carry a session context. Background session restoration does not rewrite explicit non-chat addresses.

The production Compose web service uses `server/web-server.py`: GET and HEAD for the four entry paths (including trailing slashes) serve the built index. Assets and unknown routes retain ordinary static-server responses, including 404. Frontend builds still run on the host. These page paths apply to the browser, not the Tauri host.

Verified on the LAN production URL: direct entry, refresh, Back/Forward, delayed real preferences, legacy session links and successful actual Pi session/load. Regression commands:

```sh
node --experimental-strip-types --test scripts/test_view_routes.mjs scripts/test_ui_store.mjs scripts/test_board_loading.mjs
python3 scripts/test_web_routes.py
npm run build:web
```
