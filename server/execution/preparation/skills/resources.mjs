// server/execution/preparation/skills/resources.mjs — P2 original-resource
// loading and version snapshots (plan KTD3–KTD4).
//
// The runtime must execute the skill's ORIGINAL pinned resources — the
// files the probe actually exercised — never a rewritten prompt or a
// textual imitation (R9). loadBindingResources() re-verifies the full
// pinned set (missing/changed/added all fail closed via verifyManifest)
// AND re-hashes every file as it is read, so the bytes handed to the
// caller are provably the pinned bytes. Skill content is returned
// verbatim, as data — it is never interpreted here.

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { RuntimeError } from '../../common.mjs';
import { verifyManifest, bindingConfigDigest } from './registry.mjs';

function fail(code, msg, extra = {}) {
  throw new RuntimeError(code, msg, extra);
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// Minimal SKILL.md frontmatter reader — entry metadata for diagnostics.
// Only `name`/`description` are surfaced; the document body is kept
// verbatim in `text`.
function skillEntryMeta(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (kv && (kv[1] === 'name' || kv[1] === 'description')) {
      out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return out;
}

// Load the binding's pinned resources. Returns:
//   { bindingId, digest, configDigest, pinnedAt, files, entries, loadedAt }
// files[]   — {path, sha256, bytes} for every pinned resource (re-hashed
//             on read).
// entries[] — the skill entry points: SKILL.md under each declared
//             skillDir, with verbatim text + frontmatter metadata.
// Throws structured refusals: resources_unpinned / resource_missing /
// resource_mismatch. A file that changed between verifyManifest and the
// read is still caught by the per-file re-hash.
export async function loadBindingResources(binding, { includeText = true } = {}) {
  if (!binding.resourceManifest) {
    fail('resources_unpinned',
      `binding ${binding.bindingId} has no pinned resource manifest`,
      { bindingId: binding.bindingId });
  }
  await verifyManifest(binding);
  const pinned = binding.resourceManifest;
  const files = [];
  const fileSet = new Set();
  for (const f of pinned.files) {
    let buf;
    try {
      buf = await fs.readFile(f.path);
    } catch (e) {
      fail('resource_missing',
        `binding ${binding.bindingId}: pinned resource unreadable: ${f.path} (${e.code ?? e.message})`,
        { bindingId: binding.bindingId, path: f.path });
    }
    const sha = sha256(buf);
    if (sha !== f.sha256 || buf.length !== f.bytes) {
      fail('resource_mismatch',
        `binding ${binding.bindingId}: resource content drifted: ${f.path}`,
        { bindingId: binding.bindingId, path: f.path });
    }
    fileSet.add(f.path);
    files.push({ path: f.path, sha256: sha, bytes: buf.length, ...(includeText ? { text: buf.toString('utf8') } : {}) });
  }
  // Entry points: every skillDir's SKILL.md, proven from the pinned set —
  // an entry missing from the manifest cannot be smuggled in by a stray
  // file on disk (verifyManifest's added-file check already covers that).
  const entries = [];
  for (const dir of binding.skillDirs) {
    const entry = path.join(path.resolve(dir), 'SKILL.md');
    const rec = files.find((f) => f.path === entry);
    if (!rec) continue; // dir without a pinned SKILL.md — unusual but honest
    const text = includeText ? rec.text : (await fs.readFile(rec.path)).toString('utf8');
    entries.push({ path: rec.path, sha256: rec.sha256, text, ...skillEntryMeta(text) });
  }
  return {
    bindingId: binding.bindingId,
    digest: pinned.digest,
    configDigest: bindingConfigDigest(binding),
    pinnedAt: pinned.pinnedAt ?? null,
    fileCount: files.length,
    files,
    entries,
    loadedAt: new Date().toISOString(),
  };
}

// The compact version snapshot a session/ledger records to pin the
// binding's identity: both digests plus provenance. Two snapshots with the
// same digests are the same binding version; any resource or contract
// change moves one of them.
export function resourceSnapshot(binding) {
  return {
    bindingId: binding.bindingId,
    adapterId: binding.adapterId ?? null,
    adapterVersion: binding.adapterVersion ?? null,
    digest: binding.resourceManifest?.digest ?? null,
    configDigest: bindingConfigDigest(binding),
    fileCount: binding.resourceManifest?.files?.length ?? 0,
    pinnedAt: binding.resourceManifest?.pinnedAt ?? null,
  };
}
