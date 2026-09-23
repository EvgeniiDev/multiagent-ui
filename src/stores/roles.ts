// Roles store: a role binds a CLI + args + a prompt file, and can be
// assigned to a pipeline stage.
//
// The registry lives in `roles.json` (keys `version` + `roles` +
// `stageRoles`) via the host KV abstraction — localStorage on web,
// plugin-store on Tauri — and is persisted debounced on every mutation, so
// a reload restores roles and stage assignments.
//
// The panel is loosely coupled to prompts on purpose: a role is data only
// ({id, label, cli, args, promptFile, limits}). The prompt text itself is a
// file inside the project directory (`.acp/roles/<role>.md`) read/written
// through the bridge fs API (`src/lib/fsApi.ts`) — no prompt text ever
// enters this store or the panel code.
//
// Guarantees:
//  - `id` is unique; `cli` is one of KNOWN_CLIS; `maxConcurrent >= 1`,
//    `pollIntervalSec >= 5`, `timeoutMin >= 1` — enforced on every write,
//    with thrown Errors the UI surfaces verbatim.
//  - a role assigned to a stage cannot be removed without `force`; without
//    it removeRole throws a visible error instead of silently orphaning the
//    stage pointer.
//  - malformed persisted entries are sanitized on load, same as board.ts
//    `sanitizeCard`.
import { defineStore } from 'pinia';
import { ref, type Ref } from 'vue';
import { loadKvStore, type KVStore } from '../lib/host/storage';
import { BOARD_STAGE_IDS, type BoardStageId } from './board';
import { useConfigStore } from './config';

/** CLIs the panel knows how to launch. A role whose `cli` is not in this
 * set (or has no configured agent running it) shows the `no runner for
 * role` badge on the board. */
export const KNOWN_CLIS = ['hermes', 'opencode', 'devin', 'pi', 'codex'] as const;
export type KnownCli = (typeof KNOWN_CLIS)[number];

export interface Role {
  /** Unique slug, e.g. `dev`. Immutable after creation. */
  id: string;
  /** Display name, e.g. `Developer`. */
  label: string;
  /** CLI the runner executes — one of KNOWN_CLIS. */
  cli: string;
  /** Extra CLI arguments (model, permission mode, ...). */
  args: string[];
  /** Prompt file path — relative to the project dir or absolute. */
  promptFile: string;
  maxConcurrent: number;
  pollIntervalSec: number;
  timeoutMin: number;
}

const STORE_PATH = 'roles.json';
const STORE_VERSION = 1;

const MIN_CONCURRENT = 1;
const MIN_POLL_SEC = 5;
const MIN_TIMEOUT_MIN = 1;

function strList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
}

function intAtLeast(raw: unknown, min: number, dflt: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= min
    ? Math.floor(raw)
    : dflt;
}

/** Restore a persisted role, coercing anything malformed into a safe shape.
 * Returns null for entries that cannot be salvaged. Loading is permissive —
 * a hand-edited `cli` outside KNOWN_CLIS survives (it simply has no runner);
 * the KNOWN_CLIS check only gates writes through validateRole. */
function sanitizeRole(raw: unknown): Role | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<Role>;
  if (typeof r.id !== 'string' || !r.id.trim()) return null;
  const id = r.id.trim();
  return {
    id,
    label: typeof r.label === 'string' && r.label.trim() ? r.label.trim() : id,
    cli: typeof r.cli === 'string' ? r.cli.trim() : '',
    args: strList(r.args),
    promptFile: typeof r.promptFile === 'string' ? r.promptFile.trim() : '',
    maxConcurrent: intAtLeast(r.maxConcurrent, MIN_CONCURRENT, 1),
    pollIntervalSec: intAtLeast(r.pollIntervalSec, MIN_POLL_SEC, 15),
    timeoutMin: intAtLeast(r.timeoutMin, MIN_TIMEOUT_MIN, 45),
  };
}

export const useRolesStore = defineStore('roles', () => {
  const roles: Ref<Role[]> = ref([]);
  /** stage id -> role id. Absent key = unassigned ("any runner picks up"). */
  const stageRoles: Ref<Partial<Record<BoardStageId, string>>> = ref({});
  const ready = ref(false);
  let store: KVStore | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  // ---- persistence --------------------------------------------------------

  function scheduleSave(): void {
    if (!store || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void persist();
    }, 600);
  }

  async function persist(): Promise<void> {
    if (!store) return;
    await store.set('version', STORE_VERSION);
    await store.set('roles', roles.value);
    await store.set('stageRoles', stageRoles.value);
    await store.save();
  }

  async function initRolesStore(): Promise<void> {
    if (ready.value) return;
    store = await loadKvStore(STORE_PATH);
    const version = await store.get<number>('version');
    const saved = await store.get<unknown[]>('roles');
    if (Array.isArray(saved)) {
      roles.value = saved
        .map(sanitizeRole)
        .filter((r): r is Role => r !== null);
    }
    const savedStages = await store.get<Record<string, unknown>>('stageRoles');
    if (savedStages && typeof savedStages === 'object') {
      const clean: Partial<Record<BoardStageId, string>> = {};
      for (const [stage, roleId] of Object.entries(savedStages)) {
        // Drop pointers to stages that don't exist and to roles that are
        // gone — an orphaned assignment is the same as no assignment.
        if (
          BOARD_STAGE_IDS.includes(stage as BoardStageId) &&
          typeof roleId === 'string' &&
          roles.value.some((r) => r.id === roleId)
        ) {
          clean[stage as BoardStageId] = roleId;
        }
      }
      stageRoles.value = clean;
    }
    ready.value = true;
    if (version !== STORE_VERSION) void persist();

    // Flush a pending debounced write on unload (same as board.ts).
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', () => {
        if (saveTimer) {
          clearTimeout(saveTimer);
          saveTimer = null;
          void persist();
        }
      });
    }
  }

  // ---- queries ------------------------------------------------------------

  function roleById(id: string): Role | null {
    return roles.value.find((r) => r.id === id) ?? null;
  }

  /** The role assigned to a stage, or null when the stage is unassigned. */
  function roleForStage(stage: BoardStageId): Role | null {
    const id = stageRoles.value[stage];
    return id ? roleById(id) : null;
  }

  /** Stages this role is currently assigned to (usually 0 or 1). */
  function stagesForRole(id: string): BoardStageId[] {
    return BOARD_STAGE_IDS.filter((s) => stageRoles.value[s] === id);
  }

  /** A runner exists when a configured agent's name carries the cli as a
   * word — `Hermes Agent` runs `hermes`, `OpenCode` runs `opencode`. Word
   * matching (not substring) keeps `Pilot` from claiming `pi`. */
  function cliHasRunner(cli: string): boolean {
    const c = cli.trim().toLowerCase();
    if (!c || !(KNOWN_CLIS as readonly string[]).includes(c)) return false;
    return useConfigStore().allAgentNames.some((name) =>
      name
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .includes(c)
    );
  }

  function roleHasRunner(role: Role | null): boolean {
    return !!role && cliHasRunner(role.cli);
  }

  // ---- validation ---------------------------------------------------------

  /** Validate a full role record for add/update. Throws a human-readable
   * Error on the first violation; returns the normalized record. */
  function validateRole(input: Role, isUpdate: boolean): Role {
    const id = (input.id ?? '').trim();
    if (!id) throw new Error('Role id is required');
    if (/\s/.test(id)) throw new Error('Role id must not contain whitespace');
    if (!isUpdate && roles.value.some((r) => r.id === id)) {
      throw new Error(`Role id '${id}' already exists`);
    }
    const cli = (input.cli ?? '').trim();
    if (!(KNOWN_CLIS as readonly string[]).includes(cli)) {
      throw new Error(`cli must be one of: ${KNOWN_CLIS.join(', ')}`);
    }
    const promptFile = (input.promptFile ?? '').trim();
    if (!promptFile) throw new Error('Prompt file path is required');
    const maxConcurrent = Math.floor(Number(input.maxConcurrent));
    if (!Number.isFinite(maxConcurrent) || maxConcurrent < MIN_CONCURRENT) {
      throw new Error(`maxConcurrent must be >= ${MIN_CONCURRENT}`);
    }
    const pollIntervalSec = Math.floor(Number(input.pollIntervalSec));
    if (!Number.isFinite(pollIntervalSec) || pollIntervalSec < MIN_POLL_SEC) {
      throw new Error(`pollIntervalSec must be >= ${MIN_POLL_SEC}`);
    }
    const timeoutMin = Math.floor(Number(input.timeoutMin));
    if (!Number.isFinite(timeoutMin) || timeoutMin < MIN_TIMEOUT_MIN) {
      throw new Error(`timeoutMin must be >= ${MIN_TIMEOUT_MIN}`);
    }
    const label = (input.label ?? '').trim() || id;
    return {
      id,
      label,
      cli,
      args: strList(input.args).map((a) => a.trim()).filter(Boolean),
      promptFile,
      maxConcurrent,
      pollIntervalSec,
      timeoutMin,
    };
  }

  // ---- mutations ----------------------------------------------------------

  function addRole(input: Role): Role {
    const role = validateRole(input, false);
    roles.value.push(role);
    scheduleSave();
    return role;
  }

  /** Patch a role in place. `id` is immutable — a patch carrying a
   * different id is rejected. All other fields re-validate fully. */
  function updateRole(id: string, patch: Partial<Omit<Role, 'id'>>): void {
    const idx = roles.value.findIndex((r) => r.id === id);
    if (idx === -1) throw new Error('Role not found');
    const merged = validateRole(
      { ...roles.value[idx], ...patch, id },
      true
    );
    roles.value[idx] = merged;
    scheduleSave();
  }

  /** Remove a role. A role still assigned to a stage cannot be removed
   * without `force` — the thrown error names the stages so the user can
   * unassign first; with `force` the assignments are cleared with the role. */
  function removeRole(id: string, opts: { force?: boolean } = {}): void {
    const role = roleById(id);
    if (!role) throw new Error('Role not found');
    const assigned = stagesForRole(id);
    if (assigned.length && !opts.force) {
      throw new Error(
        `Role '${id}' is assigned to stage(s): ${assigned.join(', ')} — unassign it first or use force`
      );
    }
    roles.value = roles.value.filter((r) => r.id !== id);
    for (const s of assigned) delete stageRoles.value[s];
    scheduleSave();
  }

  /** Assign `roleId` to `stage`, or clear the assignment with null. */
  function setStageRole(stage: BoardStageId, roleId: string | null): void {
    if (!BOARD_STAGE_IDS.includes(stage)) throw new Error(`Unknown stage '${stage}'`);
    if (roleId !== null && !roleById(roleId)) {
      throw new Error(`Role '${roleId}' not found`);
    }
    if (roleId === null) delete stageRoles.value[stage];
    else stageRoles.value[stage] = roleId;
    scheduleSave();
  }

  return {
    roles,
    stageRoles,
    ready,
    roleById,
    roleForStage,
    stagesForRole,
    cliHasRunner,
    roleHasRunner,
    initRolesStore,
    addRole,
    updateRole,
    removeRole,
    setStageRole,
  };
});
