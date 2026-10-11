// Errors from sendPrompt/steer thrown AFTER the user turn was appended to
// the transcript carry the `promptRecorded` flag: the text already lives in
// the feed, so the composer must not restore it as an unsent draft — a
// resend would duplicate a turn the agent may already have seen. Failures
// thrown before the append (no session, not connected) stay unflagged and
// keep the restore-the-draft behaviour.
export function markPromptRecorded(e: unknown): Error {
  const err = e instanceof Error ? e : new Error(String(e));
  (err as Error & { promptRecorded?: boolean }).promptRecorded = true;
  return err;
}

export function promptRecorded(e: unknown): boolean {
  return e instanceof Error && (e as Error & { promptRecorded?: boolean }).promptRecorded === true;
}
