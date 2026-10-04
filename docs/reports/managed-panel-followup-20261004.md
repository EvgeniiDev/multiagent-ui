# Managed card panel and Pi session recovery — 4 October 2026

The Reddit/Camoufox card (`962d16ed-be41-4c0a-857f-7d1481d9141a`) exposed an initial-state bug: the ExecutionPanel treated its `idle` state as unmanaged before the server answered. Opening an already managed card could therefore briefly offer Enable, whose authoritative preflight reported already managed. Enable is now rendered only after an actual unmanaged response; pending activation shows Enabling and aria-busy.

The card drawer's scoped button styles never reached its nested execution/preparation panels. Its existing design tokens, hover/focus states and mobile target size now apply to their buttons through scoped deep selectors. A production browser measured the enable button at 28px minimum height, 12px font and 6px radius instead of browser-default styling.

The top Internal error / Reconnecting banner was a separate Pi-session failure. Production bridge logs showed session/load failing with `pi process exited (code=143, signal=null)`. The pinned pi-acp 0.0.33 adapter closed both its own and other sessions while loading; restoring multiple tabs consequently killed live subprocesses. The Docker image now applies a version/shape-checked adapter patch that preserves healthy processes, coalesces identical loads, replaces only proven terminated processes and rejects changed cwd/MCP options without disturbing live sessions. Bridge request-id namespacing and per-session ownership/routing are unchanged. Adapter shutdown still disposes all sessions.

The browser retains concrete ACP error details and clears a prior failure only after successful recovery. Deployment rebuilt the host web bundle and recreated only bridge-pi through the existing production Compose project.

Validation:

- 74 execution UI/API/store tests passed, including initial loading vs confirmed unmanaged, in-flight button state, and unmanaged404 → exactly one enable POST → managed state.
- Actual pinned production and host adapter bundles reproduced the old own/peer eviction; patched method tests covered live/dead processes, identical-load single flight, failure cleanup, retries and changed cwd/MCP rejection.
- Real bridge handler and runtime resume tests preserve failure details during pending/failed recovery and clear them on success.
- Host `npm run build:web` passed.
- LAN browser check of the exact Reddit card, holding its state request, showed loading with no Enable button; releasing the request restored preparation and all three mode controls with no card command/fetch error or JavaScript pageerror.
- LAN browser parallel session restoration exercised the screenshot's Pi session and a second existing session, including concurrent restoration of the same session. All requested session/load responses succeeded; no final error/reconnect banners or JavaScript pageerrors.

The Reddit card is managed and has no requirements yet. No model prompt, preparation session or development run was started as part of this repair. A failed historical enable POST404 was not reproduced: the observed unmanaged404 belongs to the authoritative GET preflight and is consumed normally by the store. The misleading initial Enable offer and repeat-activation error were reproduced and fixed.
