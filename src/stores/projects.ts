// Projects registry store: project = a folder on the agent host.
//
// The registry lives in `projects.json` (keys `version` + `projects` +
// `activeProjectId`) via the host KV abstraction — localStorage on web,
// plugin-store on Tauri — and is persisted eagerly on every mutation, so a
// reload restores the list and the selection.
//
// Guarantees:
//  - a `Common` project pointing at `/home/hermes/projects` always exists
//    (owner decision, §A/§F); created on first load when missing. When the
//    bridge fs API is reachable the folder is created too (POST /api/fs/mkdir);
//    when the bridge is unreachable the registry entry is still created —
//    the folder is best-effort, the registry is authoritative.
//  - `Common` cannot be removed (removeProject throws).
//  - malformed persisted entries are sanitized on load, same as board.ts
//    `sanitizeCard`.
import { defineStore } from 'pinia';
import { computed, ref, type ComputedRef, type Ref } from 'vue';
import { loadKvStore, type KVStore } from '../lib/host/storage';
import { uuid } from '../lib/uuid';

export interface Project {
  /** uuid */
  id: string;
  name: string;
  /** absolute path, no trailing slash */
  path: string;
  notes?: string;
  createdAt: number;
}

const STORE_PATH = 'projects.json';
const STORE_VERSION = 1;

/** Owner decision (§A/§F): the default "chat without a project" project. */
export const COMMON_PROJECT_NAME = 'Common';
export const COMMON_PROJECT_PATH = '/home/hermes/projects';

function normalizePath(p: string): string {
  let out = p.trim().replace(/\\/g, '/');
  if (out.length > 1) out = out.replace(/\/+$/, '');
  return out;
}

/** Restore a persisted project, coercing anything malformed into a safe
 * shape. Returns null for entries that cannot be salvaged. */
function sanitizeProject(raw: unknown): Project | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Partial<Project>;
  if (typeof p.id !== 'string' || !p.id) return null;
  if (typeof p.name !== 'string' || !p.name.trim()) return null;
  if (typeof p.path !== 'string' || !p.path.trim()) return null;
  const project: Project = {
    id: p.id,
    name: p.name.trim(),
    path: normalizePath(p.path),
    createdAt: typeof p.createdAt === 'number' ? p.createdAt : Date.now(),
  };
  if (typeof p.notes === 'string' && p.notes) project.notes = p.notes;
  return project;
}

function makeCommonProject(): Project {
  return {
    id: uuid(),
    name: COMMON_PROJECT_NAME,
    path: COMMON_PROJECT_PATH,
    createdAt: Date.now(),
  };
}

/** Best-effort folder creation through the bridge fs API. Never throws:
 * the registry is authoritative, the folder is a convenience. */
async function ensureFolderOnHost(path: string, baseUrl: string): Promise<void> {
  if (!baseUrl) return;
  try {
    await fetch(`${baseUrl.replace(/\/+$/, '')}/api/fs/mkdir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
  } catch {
    /* offline bridge / CSP-blocked fetch — registry entry still stands */
  }
}

function isCommon(p: Project): boolean {
  return p.name === COMMON_PROJECT_NAME;
}

/** `a` is inside project `p` when it equals the project path or lives
 * under it on a directory boundary (`/a` vs `/ab` must not confuse). */
function pathBelongsTo(projectPath: string, cwd: string): boolean {
  const base = normalizePath(projectPath);
  const target = normalizePath(cwd);
  return target === base || target.startsWith(`${base}/`);
}

export const useProjectsStore = defineStore('projects', () => {
  const projects: Ref<Project[]> = ref([]);
  /** 'all' | project id (persisted). */
  const activeProjectId: Ref<string> = ref('all');
  const ready = ref(false);
  let store: KVStore | null = null;

  const activeProject: ComputedRef<Project | null> = computed(
    () => projects.value.find((p) => p.id === activeProjectId.value) ?? null
  );

  const projectNames: ComputedRef<string[]> = computed(() =>
    projects.value.map((p) => p.name)
  );

  async function persist(): Promise<void> {
    if (!store) return;
    await store.set('version', STORE_VERSION);
    await store.set('projects', projects.value);
    await store.set('activeProjectId', activeProjectId.value);
    await store.save();
  }

  async function initProjectsStore(baseUrl?: string): Promise<void> {
    if (ready.value) return;
    store = await loadKvStore(STORE_PATH);
    const saved = await store.get<unknown[]>('projects');
    if (Array.isArray(saved)) {
      projects.value = saved
        .map(sanitizeProject)
        .filter((p): p is Project => p !== null);
    }
    const savedActive = await store.get<string>('activeProjectId');
    if (typeof savedActive === 'string' && savedActive) {
      activeProjectId.value = savedActive;
    }
    if (!projects.value.some(isCommon)) {
      const common = makeCommonProject();
      projects.value.unshift(common);
      await ensureFolderOnHost(COMMON_PROJECT_PATH, baseUrl ?? '');
    }
    if (activeProjectId.value !== 'all' && !projects.value.some((p) => p.id === activeProjectId.value)) {
      activeProjectId.value = 'all';
    }
    await persist();
    ready.value = true;
  }

  function validateName(name: string): string {
    const clean = name.trim();
    if (!clean) throw new Error('Project name is required');
    return clean;
  }

  function validatePath(path: string): string {
    const clean = normalizePath(path);
    if (!clean) throw new Error('Project path is required');
    if (!clean.startsWith('/')) throw new Error('Project path must be absolute');
    return clean;
  }

  async function addProject(input: { name: string; path: string }): Promise<Project> {
    const project: Project = {
      id: uuid(),
      name: validateName(input.name),
      path: validatePath(input.path),
      createdAt: Date.now(),
    };
    projects.value.push(project);
    await persist();
    return project;
  }

  /**
   * Create the folder on the host first (POST /api/fs/mkdir, surfaced as a
   * thrown Error on failure), then register the project.
   */
  async function createProjectFolder(
    input: { name: string; path: string },
    baseUrl?: string,
  ): Promise<Project> {
    const name = validateName(input.name);
    const path = validatePath(input.path);
    if (baseUrl) {
      let resp: Response;
      try {
        resp = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/fs/mkdir`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path }),
        });
      } catch (e) {
        throw new Error(`Cannot reach the host bridge: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!resp.ok) {
        let detail = `HTTP ${resp.status}`;
        try {
          const body = (await resp.json()) as { error?: string };
          if (body?.error) detail = body.error;
        } catch {
          /* keep the status */
        }
        throw new Error(`Cannot create folder: ${detail}`);
      }
    }
    const project: Project = { id: uuid(), name, path, createdAt: Date.now() };
    projects.value.push(project);
    await persist();
    return project;
  }

  async function updateProject(id: string, patch: Partial<Omit<Project, 'id'>>): Promise<void> {
    const project = projects.value.find((p) => p.id === id);
    if (!project) throw new Error('Project not found');
    if (patch.name !== undefined) project.name = validateName(patch.name);
    if (patch.path !== undefined) project.path = validatePath(patch.path);
    if (patch.notes !== undefined) {
      if (patch.notes) project.notes = patch.notes;
      else delete project.notes;
    }
    if (patch.createdAt !== undefined) project.createdAt = patch.createdAt;
    await persist();
  }

  async function removeProject(id: string): Promise<void> {
    const project = projects.value.find((p) => p.id === id);
    if (!project) throw new Error('Project not found');
    if (isCommon(project)) throw new Error('The Common project cannot be deleted');
    projects.value = projects.value.filter((p) => p.id !== id);
    if (activeProjectId.value === id) activeProjectId.value = 'all';
    await persist();
  }

  async function setActiveProject(id: string): Promise<void> {
    if (id !== 'all' && !projects.value.some((p) => p.id === id)) {
      throw new Error('Project not found');
    }
    activeProjectId.value = id;
    await persist();
  }

  /** Longest-prefix match of a cwd against registry paths, else null. */
  function projectIdForCwd(cwd: string): string | null {
    const target = normalizePath(cwd);
    if (!target) return null;
    let best: Project | null = null;
    for (const p of projects.value) {
      if (!pathBelongsTo(p.path, target)) continue;
      if (!best || p.path.length > best.path.length) best = p;
    }
    return best ? best.id : null;
  }

  /** Filter sessions by the active project (no-op when 'all'). */
  function sessionsOfProject<T extends { cwd?: string }>(sessions: T[]): T[] {
    if (activeProjectId.value === 'all') return sessions;
    const active = activeProject.value;
    if (!active) return sessions;
    return sessions.filter((s) => typeof s.cwd === 'string' && pathBelongsTo(active.path, s.cwd));
  }

  return {
    projects,
    activeProjectId,
    activeProject,
    projectNames,
    ready,
    projectIdForCwd,
    sessionsOfProject,
    initProjectsStore,
    addProject,
    createProjectFolder,
    updateProject,
    removeProject,
    setActiveProject,
  };
});
