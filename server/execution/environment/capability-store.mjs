// server/execution/environment/capability-store.mjs — search capability ledger.
//
// Web-search enablement is gated on PROOF, not configuration: for the digest
// of the full effective AgentProfile the ledger records whether the search
// capability exists, HOW it is enabled (extension/tool/provider), and the
// result of a REAL probe against a public source run inside the constrained
// worker. Egress availability alone never marks a profile capable.
//
// requireSearchAllowed() is the pre-start gate: when a profile declares
// search.enabled, its exact digest must hold a positive probe — an unprobed
// combination (including "same image/model minus the search tool", which is
// a different digest) is rejected before launch.
//
// Store: <envRoot>/capability/<digest>.json, atomic writes, append-free
// (latest record wins; history lives in the probe evidence fields).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  RuntimeError, atomicWriteJson, ensureDir, SAFE_ID_RE,
} from '../common.mjs';

const DIGEST_RE = /^[0-9a-f]{64}$/;

export function createCapabilityStore({ dir }) {
  if (typeof dir !== 'string' || !dir.startsWith('/')) {
    throw new RuntimeError('invalid_argument', 'capability store dir must be absolute');
  }
  const fileFor = (digest) => {
    if (!DIGEST_RE.test(digest)) {
      throw new RuntimeError('invalid_argument', `bad profile digest: ${digest}`);
    }
    return path.join(dir, `${digest}.json`);
  };

  async function load(digest) {
    const f = fileFor(digest);
    let raw;
    try { raw = await fs.readFile(f, 'utf8'); }
    catch (e) {
      if (e?.code === 'ENOENT') return null;
      throw e;
    }
    let rec;
    try { rec = JSON.parse(raw); }
    catch {
      // A corrupt record is unproven, never silently usable.
      return { digest, corrupt: true, capable: false, probe: null };
    }
    if (rec?.digest !== digest) return { digest, corrupt: true, capable: false, probe: null };
    return rec;
  }

  // record({digest, capable, enablement, probe}) — probe: {ok, at, runId,
  // attemptId, source, evidence} or {ok:false, at, error}.
  async function record(rec) {
    if (!DIGEST_RE.test(rec?.digest || '')) {
      throw new RuntimeError('invalid_argument', 'capability record needs a sha256 digest');
    }
    const doc = {
      schemaVersion: 1,
      digest: rec.digest,
      profileId: typeof rec.profileId === 'string' && SAFE_ID_RE.test(rec.profileId)
        ? rec.profileId : null,
      capable: rec.capable === true,
      enablement: rec.enablement ?? null,
      probe: rec.probe ?? null,
      recordedAt: new Date().toISOString(),
    };
    await ensureDir(dir);
    await atomicWriteJson(fileFor(rec.digest), doc);
    return doc;
  }

  // Pre-start gate. Returns the record on success; throws RuntimeError
  // (search_unproven | search_uncapable) when the combination is not proven.
  async function requireSearchAllowed(profile, digest) {
    if (!DIGEST_RE.test(digest || '')) {
      throw new RuntimeError('invalid_argument', `bad digest: ${digest}`);
    }
    const rec = await load(digest);
    if (!rec || rec.corrupt || !rec.probe || rec.probe.ok !== true) {
      throw new RuntimeError('search_unproven',
        `profile digest ${digest.slice(0, 12)}… has no positive search probe on record — `
        + 'the combination is unprobed and may not launch with search enabled');
    }
    if (rec.capable !== true) {
      throw new RuntimeError('search_uncapable',
        `profile digest ${digest.slice(0, 12)}… probe marked the combination not capable`);
    }
    return rec;
  }

  async function list() {
    let names;
    try { names = await fs.readdir(dir); }
    catch (e) { if (e?.code === 'ENOENT') return []; throw e; }
    const out = [];
    for (const n of names.filter((n) => DIGEST_RE.test(n.slice(0, -5)) && n.endsWith('.json'))) {
      const rec = await load(n.slice(0, -5));
      if (rec) out.push(rec);
    }
    return out;
  }

  return { dir, load, record, requireSearchAllowed, list };
}
