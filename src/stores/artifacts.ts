// Card artifacts store — the "card as pipeline" view (W6-A).
//
// A card's run lives on the host filesystem at
//   <projectPath>/.acp/cards/<cardId>/
// with fixed names: 00_brief.md, 01_spec.md, 02_plan.md, 03_plan_review.md,
// 04_impl_log.md, 05_review_r<N>.md rounds, 06_handoff.md, plus run-<N>.log
// runner logs. The last non-empty line of a pipeline artifact may be a
// status token: `STATUS: APPROVE | CHANGES_REQUIRED | DONE | BLOCKED`
// (trailing text after the token is kept as its detail — e.g. the BLOCKED
// reason).
//
// The web build reaches the files through the agent host bridge
// (`GET /api/fs/list`, `GET /api/fs/read`) — same seam as the role prompt
// editor. Bridge errors surface verbatim in `state.error`; a missing card
// directory is an honest empty state, not an error.
//
// Listing caveat: today's bridge `list` returns directories only, so the
// store discovers artifacts by probing the pipeline's fixed names plus the
// numbered `05_review_rN` / `run-N` families. When a newer `list` response
// carries `files[]`, it is taken as the listing instead and its
// size/mtime fields enrich the records — otherwise mtime stays null (the
// read API exposes none) and the UI shows a dash.
import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { BoardStageId, CardStatus } from './board';
import { stageLabel } from '../features/board/columns';
import { useConfigStore } from './config';
import {
  bridgeBaseUrlForAgentUrl,
  defaultBridgeBaseUrl,
} from '../features/settings/fsApi';

export type StatusToken = 'APPROVE' | 'CHANGES_REQUIRED' | 'DONE' | 'BLOCKED';

export interface CardArtifact {
  /** File name inside the card dir, e.g. `05_review_r2.md`. */
  name: string;
  /** Absolute path on the host, as resolved by the bridge. */
  path: string;
  bytes: number;
  /** Epoch ms; null — today's bridge does not expose mtimes. */
  mtime: number | null;
  /** STATUS token parsed from the last non-empty line, if any. */
  token: StatusToken | null;
  /** Text after the token on the status line (e.g. the BLOCKED reason). */
  tokenDetail: string;
  /** Full file content (the drawer's read-only viewer shows it verbatim). */
  content: string;
  /** Per-file bridge error (415 binary, 403 outside root, …). */
  error?: string;
}

export interface CardArtifactsState {
  phase: 'idle' | 'loading' | 'ready' | 'error';
  /** Last bridge error, verbatim from `{error}` — kept next to stale data. */
  error: string;
  /** Resolved `<projectPath>/.acp/cards/<cardId>` this state belongs to. */
  dir: string;
  artifacts: CardArtifact[];
  loadedAt: number | null;
}

// ---- pure helpers -----------------------------------------------------------

const STATUS_LINE =
  /^\s*STATUS:\s*(APPROVE|CHANGES_REQUIRED|DONE|BLOCKED)\b[\s:—–-]*(.*)$/;

/** Parse the last non-empty line of an artifact into a status token. */
export function parseStatusToken(
  content: string
): { token: StatusToken; detail: string } | null {
  const lines = content.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    const m = STATUS_LINE.exec(lines[i]);
    return m ? { token: m[1] as StatusToken, detail: m[2].trim() } : null;
  }
  return null;
}

const REVIEW_RE = /^05_review_r(\d+)\.md$/;
const RUN_RE = /^run-(\d+)\.log$/;
const PIPELINE_DOC_RE = /^\d{2}_.*\.md$/;

export function reviewRoundOf(artifacts: CardArtifact[]): number | null {
  let max = 0;
  for (const a of artifacts) {
    const m = REVIEW_RE.exec(a.name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max || null;
}

/** Pipeline display order: 00 → 06 by prefix (reviews ordered by round),
 * then other docs, then run logs. */
function artifactRank(name: string): [number, number, string] {
  const rev = REVIEW_RE.exec(name);
  if (rev) return [5, Number(rev[1]), name];
  const run = RUN_RE.exec(name);
  if (run) return [8, Number(run[1]), name];
  const pfx = /^(\d+)_/.exec(name);
  if (pfx) return [Number(pfx[1]), 0, name];
  return [7, 0, name];
}

function rankCmp(a: CardArtifact, b: CardArtifact): number {
  const ra = artifactRank(a.name);
  const rb = artifactRank(b.name);
  return ra[0] - rb[0] || ra[1] - rb[1] || ra[2].localeCompare(rb[2]);
}

/** The artifact whose STATUS token speaks for the card right now: the
 * stage's own output first (the `05_review_rN` max round in reviewtest),
 * else the furthest-along token-bearing pipeline doc. Run logs never
 * speak — they echo other files' tokens. */
export function pickStatusArtifact(
  stage: BoardStageId,
  artifacts: CardArtifact[]
): CardArtifact | null {
  const docs = artifacts.filter((a) => a.token && PIPELINE_DOC_RE.test(a.name));
  if (!docs.length) return null;
  if (stage === 'reviewtest') {
    const revs = docs.filter((a) => REVIEW_RE.test(a.name));
    if (revs.length)
      return revs.sort(
        (a, b) => Number(REVIEW_RE.exec(b.name)![1]) - Number(REVIEW_RE.exec(a.name)![1])
      )[0];
  }
  for (const name of STAGE_TOKEN_PREF[stage] ?? []) {
    const hit = docs.find((a) => a.name === name);
    if (hit) return hit;
  }
  return [...docs].sort((a, b) => rankCmp(b, a))[0];
}

const STAGE_TOKEN_PREF: Record<BoardStageId, string[]> = {
  backlog: [],
  spec: ['01_spec.md', '00_brief.md'],
  plan: ['03_plan_review.md', '02_plan.md'],
  dev: ['04_impl_log.md'],
  reviewtest: [],
  done: ['06_handoff.md'],
};

// ---- stage transitions ------------------------------------------------------

export type TransitionProposal =
  | { kind: 'move'; to: BoardStageId; label: string }
  | { kind: 'status'; status: CardStatus; label: string }
  | { kind: 'flag'; flag: 'blocked'; reason: string; label: string }
  | { kind: 'none'; label: string };

const BACK_ON_CHANGES: Partial<Record<BoardStageId, BoardStageId>> = {
  plan: 'spec',
  dev: 'plan',
  reviewtest: 'dev',
};

/**
 * The transition the STATUS token proposes, by the pipeline table:
 * `spec+APPROVE→plan`, `plan+APPROVE→dev`, `dev+DONE→reviewtest`,
 * `reviewtest+DONE→agent_tested` (a status, not a stage),
 * `CHANGES_REQUIRED`→ one stage back, `BLOCKED` → the blocked flag with the
 * token line's trailing text as the reason. Anything else → `none`.
 * `reviewRound` (the max `05_review_rN` round present) is informational —
 * it annotates the label; the badge names the actual source artifact.
 */
export function proposeTransition(
  stage: BoardStageId,
  reviewRound: number | null,
  token: StatusToken | null,
  detail = ''
): TransitionProposal {
  if (!token) return { kind: 'none', label: 'no STATUS token yet' };
  const via = reviewRound ? ` (round ${reviewRound})` : '';
  switch (token) {
    case 'APPROVE':
      if (stage === 'spec')
        return { kind: 'move', to: 'plan', label: `approve spec → ${stageLabel('plan')}` };
      if (stage === 'plan')
        return { kind: 'move', to: 'dev', label: `approve plan → ${stageLabel('dev')}` };
      return { kind: 'none', label: `APPROVE has no step from ${stage}` };
    case 'DONE':
      if (stage === 'dev')
        return {
          kind: 'move',
          to: 'reviewtest',
          label: `dev done → ${stageLabel('reviewtest')}`,
        };
      if (stage === 'reviewtest')
        return {
          kind: 'status',
          status: 'agent_tested',
          label: `review done${via} → agent_tested`,
        };
      return { kind: 'none', label: `DONE has no step from ${stage}` };
    case 'CHANGES_REQUIRED': {
      const to = BACK_ON_CHANGES[stage];
      return to
        ? { kind: 'move', to, label: `changes required${via} → back to ${stageLabel(to)}` }
        : { kind: 'none', label: `CHANGES_REQUIRED has no back-step from ${stage}` };
    }
    case 'BLOCKED':
      return {
        kind: 'flag',
        flag: 'blocked',
        reason: detail,
        label: detail ? `flag blocked — ${detail}` : 'flag blocked',
      };
  }
}

// ---- bridge plumbing --------------------------------------------------------

interface FsFileEntry {
  name: string;
  path?: string;
  bytes?: number;
  size?: number;
  mtime?: number | string;
}

interface FsListResponse {
  path: string;
  dirs?: { name: string; path: string }[];
  files?: FsFileEntry[];
}

async function readError(resp: Response): Promise<string> {
  try {
    const body = (await resp.json()) as { error?: string };
    if (body?.error) return body.error;
  } catch {
    /* not JSON — fall through to the status */
  }
  return `HTTP ${resp.status}`;
}

/** The card dir listing. `null` = the directory does not exist (the bridge
 * answers 500 `ENOENT` for that); other failures throw the bridge's own
 * `{error}` text. `files` is a forward-compat field — today's bridge sends
 * `dirs` only. */
async function bridgeList(base: string, dir: string): Promise<FsListResponse | null> {
  let resp: Response;
  try {
    const q = new URLSearchParams({ path: dir, hidden: '1' });
    resp = await fetch(`${base.replace(/\/+$/, '')}/api/fs/list?${q.toString()}`);
  } catch (e) {
    throw new Error(
      `Cannot reach the host bridge: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  if (!resp.ok) {
    const msg = await readError(resp);
    if (resp.status === 404 || /ENOENT|no such file|not found/i.test(msg)) return null;
    throw new Error(msg);
  }
  return (await resp.json()) as FsListResponse;
}

/** One file read. `null` = 404 (the fixed-name probe's "absent" answer);
 * other statuses throw with the bridge's `{error}` verbatim. */
async function bridgeRead(
  base: string,
  path: string
): Promise<{ path: string; bytes: number; content: string } | null> {
  let resp: Response;
  try {
    const q = new URLSearchParams({ path });
    resp = await fetch(`${base.replace(/\/+$/, '')}/api/fs/read?${q.toString()}`);
  } catch (e) {
    throw new Error(
      `Cannot reach the host bridge: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(await readError(resp));
  const d = (await resp.json()) as { path?: string; bytes?: number; content?: string };
  if (typeof d.content !== 'string') throw new Error('malformed read response');
  return {
    path: d.path ?? path,
    bytes: typeof d.bytes === 'number' ? d.bytes : d.content.length,
    content: d.content,
  };
}

function coerceMtime(raw: number | string | undefined): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const t = Date.parse(raw);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

const FIXED_FILES = [
  '00_brief.md',
  '01_spec.md',
  '02_plan.md',
  '03_plan_review.md',
  '04_impl_log.md',
  '06_handoff.md',
];
const MAX_SEQ = 50;

// ---- store ------------------------------------------------------------------

export const useArtifactsStore = defineStore('artifacts', () => {
  /** Per-card session cache — `refresh` re-reads on demand only. */
  const byCard = ref<Record<string, CardArtifactsState>>({});
  const pending = new Map<string, Promise<void>>();

  /** Same bridge resolution as Settings → Projects / the role prompt
   * editor: first configured remote agent, else the default bridge port. */
  function bridgeBaseUrl(): string {
    const config = useConfigStore();
    for (const name of config.allAgentNames) {
      const base = bridgeBaseUrlForAgentUrl(config.getAgent(name)?.url);
      if (base) return base;
    }
    return defaultBridgeBaseUrl();
  }

  function stateFor(cardId: string): CardArtifactsState {
    let st = byCard.value[cardId];
    if (!st) {
      st = { phase: 'idle', error: '', dir: '', artifacts: [], loadedAt: null };
      byCard.value[cardId] = st;
    }
    return st;
  }

  function dirFor(projectPath: string, cardId: string): string {
    return `${projectPath.replace(/\/+$/, '')}/.acp/cards/${cardId}`;
  }

  /** Load once per card; re-probes when the project path moved or the last
   * attempt failed. */
  function ensureLoaded(cardId: string, projectPath: string): void {
    const st = stateFor(cardId);
    if (
      st.phase === 'idle' ||
      st.phase === 'error' ||
      st.dir !== dirFor(projectPath, cardId)
    ) {
      void refresh(cardId, projectPath);
    }
  }

  async function refresh(cardId: string, projectPath: string): Promise<void> {
    const inFlight = pending.get(cardId);
    if (inFlight) return inFlight;
    const p = doRefresh(cardId, projectPath).finally(() => pending.delete(cardId));
    pending.set(cardId, p);
    return p;
  }

  async function readInto(
    base: string,
    dir: string,
    name: string,
    meta: Map<string, FsFileEntry>,
    out: CardArtifact[]
  ): Promise<'ok' | 'missing'> {
    const m = meta.get(name);
    const path = m?.path ?? `${dir}/${name}`;
    try {
      const r = await bridgeRead(base, path);
      if (!r) return 'missing';
      const tok = parseStatusToken(r.content);
      out.push({
        name,
        path: r.path,
        bytes: r.bytes,
        mtime: coerceMtime(m?.mtime),
        token: tok?.token ?? null,
        tokenDetail: tok?.detail ?? '',
        content: r.content,
      });
      return 'ok';
    } catch (e) {
      out.push({
        name,
        path,
        bytes: m?.bytes ?? m?.size ?? 0,
        mtime: coerceMtime(m?.mtime),
        token: null,
        tokenDetail: '',
        content: '',
        error: e instanceof Error ? e.message : String(e),
      });
      return 'ok';
    }
  }

  async function doRefresh(cardId: string, projectPath: string): Promise<void> {
    const st = stateFor(cardId);
    const dir = dirFor(projectPath, cardId);
    st.phase = 'loading';
    st.error = '';
    st.dir = dir;
    try {
      const base = bridgeBaseUrl();
      if (!base) throw new Error('no bridge reachable — no remote agent configured');
      const listing = await bridgeList(base, dir);
      if (listing === null) {
        st.artifacts = [];
        st.phase = 'ready';
        st.loadedAt = Date.now();
        return;
      }
      const meta = new Map((listing.files ?? []).map((f) => [f.name, f]));
      const out: CardArtifact[] = [];
      if (meta.size) {
        // Newer bridge: the listing itself names the files — read them all.
        for (const name of meta.keys()) await readInto(base, dir, name, meta, out);
      } else {
        // Today's bridge lists directories only — probe the fixed pipeline
        // names, then the numbered families until the first gap.
        for (const name of FIXED_FILES) await readInto(base, dir, name, meta, out);
        for (let n = 1; n <= MAX_SEQ; n++) {
          if ((await readInto(base, dir, `05_review_r${n}.md`, meta, out)) === 'missing') break;
        }
        for (let n = 1; n <= MAX_SEQ; n++) {
          if ((await readInto(base, dir, `run-${n}.log`, meta, out)) === 'missing') break;
        }
      }
      st.artifacts = out.sort(rankCmp);
      st.phase = 'ready';
      st.loadedAt = Date.now();
    } catch (e) {
      // Honest failure: keep any previously loaded artifacts visible and
      // put the bridge's own message on the record.
      st.error = e instanceof Error ? e.message : String(e);
      st.phase = st.artifacts.length ? 'ready' : 'error';
    }
  }

  return {
    byCard,
    stateFor,
    dirFor,
    ensureLoaded,
    refresh,
  };
});
