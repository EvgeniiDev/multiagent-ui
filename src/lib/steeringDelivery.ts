/** Verified delivery profiles, independent of user-editable agent display names. */
export type SteeringDelivery = 'extension' | 'concurrent-prompt' | 'hermes-command' | null;
export function steeringDelivery(handshake: {
  _meta?: Record<string, unknown> | null;
  agentInfo?: { name?: string; title?: string | null } | null;
}): SteeringDelivery {
  const capability = handshake._meta?.steering as { supported?: boolean } | undefined;
  if (capability?.supported === true) return 'extension';
  const { name, title } = handshake.agentInfo ?? {};
  // OpenCode ACP joins the existing run, as does Porch's prompt_async route.
  if (name === 'OpenCode') return 'concurrent-prompt';
  // Verified on the installed Devin handshake; display name alone is not proof.
  if (name === 'affogato' && title === 'Devin Agent') return 'concurrent-prompt';
  // Hermes's ordinary concurrent prompt may redirect/cancel. Only /steer is safe.
  if (name === 'hermes-agent') return 'hermes-command';
  return null;
}
