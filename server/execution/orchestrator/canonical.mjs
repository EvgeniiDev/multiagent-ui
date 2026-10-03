// server/execution/orchestrator/canonical.mjs — O1-private canonical codec.
//
// The committed O1 graph contract must load from a clean checkout on its
// own: the canonical-JSON serializer, the SHA-256 digest helper, and the
// digest pattern live here instead of being borrowed from core/F1 modules.
//
// canonicalJson: recursively lexicographic object keys, compact separators,
// array order preserved, scalar serialization identical to JSON.stringify
// (undefined object properties drop, array holes stringify as null) — so the
// same value under any key order produces the same string. sha256: lowercase
// hex of the UTF-8 digest. Together they pin the command fingerprint in
// service.mjs and the no-op change check / inputs_changed detection in
// graph.mjs.

import { createHash } from 'node:crypto';

export const SHA256_RE = /^[0-9a-f]{64}$/;

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item) ?? 'null').join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const parts = [];
    for (const key of Object.keys(value).sort()) {
      const s = canonicalJson(value[key]);
      if (s !== undefined) parts.push(`${JSON.stringify(key)}:${s}`);
    }
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value);
}
