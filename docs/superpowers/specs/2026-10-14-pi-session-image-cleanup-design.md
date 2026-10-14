# Pi session image cleanup — design specification

**Status:** Awaiting user review
**Scope:** Current Pi session only. This is a design; no implementation or deployment is included here.

## Problem and goal

Long Pi session histories can contain many image blocks. Hiding the panel's thumbnails is insufficient because Pi owns the persisted conversation and may continue sending those image blocks to the model. Add a manual action that removes image content from the active Pi session while retaining its text conversation, reasoning, and tool history.

The inspected session JSONL had 30 `type: "image"` blocks with about 8.81 million encoded data characters. This confirms the stored image count and size for that session, but does **not** establish that the provider has a 30-image limit or that this caused its HTTP 400 responses.

## User-facing behavior

- Show **Clear images** only for an open Pi session. It is disabled while that session is loading or has a request in flight.
- Clicking opens a confirmation that states the operation affects only this Pi session, the active history will lose its images, and the backup will retain the originals.
- On confirmation, the operation does not invoke a model and does not add a user-visible transcript message.
- On success, show the number of image blocks removed and the backup path. Reload the current transcript from Pi so the panel no longer renders stale thumbnails.
- If there are no images, report that and make no history change.

## Data and runtime behavior

1. The Pi-specific adapter identifies the persisted JSONL path for the requested ACP `sessionId`; the browser never chooses an arbitrary filesystem path.
2. Reject the operation if the selected Pi session is running or has queued turns. Hold a per-session cleanup lock so a second cleanup, prompt, or history reload cannot race it. Other Pi session IDs remain available.
3. Validate the complete JSONL before changing anything. Count and remove every Pi image content block (`type: "image"`), including an image block with missing/empty data; do not infer counts from panel thumbnails.
4. Create a timestamped backup beside the session file with restrictive permissions. The backup is an exact copy and intentionally retains the original image data until the user deletes the backup.
5. Strip image data from image content blocks in the active session. Replace each removed block with the plain-text marker `[Image removed manually]`, keeping the message and its position. Preserve all non-image message fields and records, including text, reasoning, tool calls/results, timestamps, IDs, and session metadata.
6. Write to a same-directory temporary file and atomically replace the session file. Close only the selected session's Pi RPC child, wait for it to exit, then let the existing `session/load` path reopen that session from the sanitized file. Do not restart the shared Pi ACP bridge or another session's child.
7. After the sanitized load succeeds, remove image-only cached attachment data for this session in acp-ui (preserving non-image/text attachments) and replace the cached transcript with the replayed history. The UI must not leave old image previews in its local or shared history cache.
8. If validation, backup, or replacement fails, leave the active session file unchanged. If reopening/replay fails after replacement, attempt to restore the exact backup atomically and reopen the original. Report both the failure and backup location; never show success unless the sanitized history was loaded.

## Integration boundary

The capability is Pi-specific and must not be exposed as a generic ACP operation for other agents. The current Pi adapter is version-pinned (`pi-acp` 0.0.33) and patched by `deploy/patch-pi-acp-multisession.mjs`; any adapter change must preserve its existing multi-session behavior. A front-end-only cache deletion is explicitly not an implementation of this feature.

The adapter action must use an internal control path intercepted before calling Pi's model-facing prompt operation. The panel calls it through a dedicated runtime action rather than ordinary `sendPrompt`, so it is not shown as a user message or counted as a model turn. The bridge's estimate meter must also exclude this maintenance action. After it completes, the runtime reloads the same selected session and preserves the user's current session selection.

## Failure and concurrency cases

- Busy or queued selected session: refuse without touching the session file or backup.
- A second click/request while cleanup is in progress: refuse or join the same operation; never run two rewrites.
- Malformed/truncated JSONL, missing file, or unknown `sessionId`: fail closed before mutation.
- Backup/temporary-file/atomic-replace error: keep the original active file and show an actionable error.
- Reload failure: attempt rollback from backup; keep the backup and report the final state explicitly.
- Other Pi sessions: their processes, histories, and cached transcripts must remain unchanged.
- Non-Pi agent: no cleanup action is shown and no Pi-specific request is sent.

## Verification and acceptance criteria

### Unit/contract tests

- Fixture JSONL with multiple image blocks, including image-only user messages, mixed text/image messages, reasoning, assistant messages, tool calls/results, and non-message records.
- Verify the sanitized file has no active image data blocks; image locations contain the marker; all non-image fields/records are preserved; the backup is byte-for-byte identical to the original.
- Verify zero-image input makes no change; malformed JSONL, missing sessions, active/queued sessions, failed backup, and failed atomic write do not report success or silently destroy the original.
- Verify repeated/concurrent operation cannot double-rewrite or race a prompt/load.
- Verify the UI cache removes image previews for the selected session only and preserves text attachments and other sessions' cache data.

### Local integration and browser acceptance

- Use a dedicated disposable Pi session/fixture, never the user's existing conversation, and do not call a paid model for the cleanup test.
- Verify initialize → create/load session → image cleanup → load the same session ID; confirm sanitized history is replayed and the image blocks are absent.
- Run two independent Pi sessions and verify cleanup of one leaves the other session process and history intact. Also test the busy-session refusal.
- In the actual browser, verify Pi-only visibility, confirmation, disabled/loading state, success count/backup path, failure state, focus/keyboard behavior, narrow viewport, and absence of stale previews.
- Verify the bridge remains running throughout; no other Pi session or bridge is restarted.
- Run the checks required by `TESTING.md`, `AGENTS.md`, and `docs/design-system.md`; report unit, protocol, browser, and live-runtime evidence separately.

## Out of scope

- Cleaning every Pi session or any non-Pi agent.
- Deleting backups automatically; they contain the original image data by design.
- Compaction, summarization, model retries, or automatic cleanup at a provider limit.
- Claiming this feature fixes the reported upstream HTTP 400 until a subsequent request succeeds and the upstream error is observed.

## Review gate

This document must be reviewed and approved before creating an implementation plan or changing application code, the installed Pi adapter, or live services.