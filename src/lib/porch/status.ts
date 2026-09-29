// Run liveness for the banner + stepper, ported from Paseo's readRunStatus
// with `pidAlive` replaced by silence detection: the browser cannot prove a
// pid is dead, only that nothing was written for a while.
//
//   meta.status terminal → failed / done
//   running + meta.updated_at older than staleAfterMs AND audit.size did not
//     grow since the previous poll → stale ("no output for N min")
//   otherwise → active (missing meta → active, Paseo parity)
//
// `final` is accepted but never gates `done` — this host writes final.txt
// unreliably (present on only some terminal runs), so Paseo's done-pending
// distinction is deliberately dropped.

import type { PorchAudit, PorchRunDetail, RunStatus } from './types.ts';

export type { RunStatus };

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

const DEFAULT_STALE_AFTER_MS = 3 * 60 * 1000;

export interface DeriveStatusInput {
  meta?: PorchRunDetail['meta'] | null;
  state?: Record<string, unknown> | null;
  audit?: PorchAudit | null;
  final?: string | null;
}

export interface DeriveStatusOpts {
  staleAfterMs?: number;
  /** Did audit.size grow since the previous poll? First poll counts as
   * grown — a single observation can never prove silence. */
  auditGrew?: boolean;
}

function isFailure(meta: PorchRunDetail['meta']): boolean {
  const status = typeof meta.status === 'string' ? meta.status : '';
  if (status === 'failed' || status === 'cancelled') return true;
  if (typeof meta.exit_code === 'number' && meta.exit_code !== 0) return true;
  return typeof meta.error === 'string' && meta.error.length > 0;
}

export function deriveRunStatus(
  d: DeriveStatusInput,
  nowMs: number,
  opts: DeriveStatusOpts = {},
): RunStatus {
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const auditGrew = opts.auditGrew ?? true;
  const meta = d.meta ?? null;
  if (meta === null) return 'active';

  const status = typeof meta.status === 'string' ? meta.status : '';
  if (TERMINAL_STATUSES.has(status)) {
    return isFailure(meta) ? 'failed' : 'done';
  }

  const updatedMs =
    typeof meta.updated_at === 'string' ? Date.parse(meta.updated_at) : NaN;
  if (!auditGrew && Number.isFinite(updatedMs) && nowMs - updatedMs > staleAfterMs) {
    return 'stale';
  }
  return 'active';
}
