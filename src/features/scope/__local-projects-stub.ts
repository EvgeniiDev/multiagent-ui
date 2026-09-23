// LOCAL STUB of the projects registry — stands in for src/stores/projects.ts
// while W1 (cc/v2-projects) has not merged yet. Implements the frozen contract
// literally — same Pinia id, same KV document (`projects.json`:
// `{ version: 1, projects: [...], activeProjectId: 'all' }`), same Common
// auto-provision — so scope code is exercised exactly the way it will run
// against the real store. Every consumer imports it through
// `./registry.ts`, the single seam; after the merge that file flips to the
// real module and this stub is deleted. Do NOT import this file directly.
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { loadKvStore, type KVStore } from '../../lib/host/storage';
import { uuid } from '../../lib/uuid';

export interface Project {
  id: string;
  name: string;
  path: string;
  notes?: string;
  createdAt: number;
}

const STORE_PATH = 'projects.json';
const STORE_VERSION = 1;
const COMMON_NAME = 'Common';
// Owner decision (requirements §F.3): the "chat without a project" bucket
// points at ~/projects.
const COMMON_PATH = '/home/hermes/projects';

/** Strip trailing slashes so prefix matching compares canonical paths. */
function normalizePath(path: string): string {
  const trimmed = (path || '').trim().replace(/[\\/]+$/, '');
  return trimmed || '/';
}

/** True when `cwd` is the project path itself or sits inside it. */
export function cwdInProject(cwd: string | undefined, projectPath: string): boolean {
  const base = normalizePath(projectPath);
  const target = normalizePath(cwd ?? '');
  if (!target || target === '/') return base === '/';
  return target === base || target.startsWith(base === '/' ? '/' : base + '/');
}

export const useProjectsStore = defineStore('projects', () => {
  const projects = ref<Project[]>([]);
  const activeProjectId = ref<string>('all');
  let store: KVStore | null = null;
  let initialized = false;

  const activeProject = computed<Project | null>(() =>
    activeProjectId.value === 'all'
      ? null
      : projects.value.find((p) => p.id === activeProjectId.value) ?? null
  );

  const projectNames = computed<string[]>(() => projects.value.map((p) => p.name));

  /** Longest-prefix match: the project owning a cwd is the deepest
   *  registered path that contains it. `/projects/a` vs `/projects/ab`
   *  never collide — the boundary is a path separator. */
  function projectIdForCwd(cwd: string): string | null {
    const target = normalizePath(cwd ?? '');
    if (!target || target === '/') return null;
    let best: Project | null = null;
    let bestLen = -1;
    for (const p of projects.value) {
      const base = normalizePath(p.path);
      if (target === base || target.startsWith(base === '/' ? '/' : base + '/')) {
        if (base.length > bestLen) {
          best = p;
          bestLen = base.length;
        }
      }
    }
    return best?.id ?? null;
  }

  /** Sessions whose cwd lies inside the active project's path.
   *  'all' (or a dangling id) passes the list through untouched. */
  function sessionsOfProject<T extends { cwd?: string }>(sessions: T[]): T[] {
    const active = activeProject.value;
    if (!active) return sessions;
    return sessions.filter((s) => cwdInProject(s.cwd, active.path));
  }

  async function persist(): Promise<void> {
    if (!store) return;
    await store.set('version', STORE_VERSION);
    await store.set('projects', projects.value);
    await store.set('activeProjectId', activeProjectId.value);
    await store.save();
  }

  function sanitizeProject(raw: unknown): Project | null {
    if (!raw || typeof raw !== 'object') return null;
    const p = raw as Partial<Project>;
    if (typeof p.name !== 'string' || !p.name.trim()) return null;
    if (typeof p.path !== 'string' || !p.path.trim()) return null;
    return {
      id: typeof p.id === 'string' && p.id ? p.id : uuid(),
      name: p.name.trim(),
      path: normalizePath(p.path),
      notes: typeof p.notes === 'string' ? p.notes : undefined,
      createdAt: typeof p.createdAt === 'number' ? p.createdAt : Date.now(),
    };
  }

  async function initProjectsStore(): Promise<void> {
    if (initialized) return;
    initialized = true;
    store = await loadKvStore(STORE_PATH);
    const saved = (await store.get<unknown[]>('projects')) ?? [];
    projects.value = saved
      .map(sanitizeProject)
      .filter((p): p is Project => p !== null);

    // Common is the always-present default project (requirements §A/§F).
    if (!projects.value.some((p) => p.name === COMMON_NAME || normalizePath(p.path) === COMMON_PATH)) {
      projects.value.unshift({
        id: uuid(),
        name: COMMON_NAME,
        path: COMMON_PATH,
        createdAt: Date.now(),
      });
    }

    const savedActive = await store.get<string>('activeProjectId');
    activeProjectId.value =
      savedActive && (savedActive === 'all' || projects.value.some((p) => p.id === savedActive))
        ? savedActive
        : 'all';
    await persist();
  }

  async function addProject(input: { name: string; path: string }): Promise<Project> {
    const project: Project = {
      id: uuid(),
      name: input.name.trim(),
      path: normalizePath(input.path),
      createdAt: Date.now(),
    };
    projects.value.push(project);
    await persist();
    return project;
  }

  /** Create the folder on the agent host (best effort — the web build goes
   *  through the bridge `/api/fs/mkdir`, which the e2e mocks), then register
   *  it like `addProject`. */
  async function createProjectFolder(input: { name: string; path: string }): Promise<Project> {
    const path = normalizePath(input.path);
    try {
      await fetch('/api/fs/mkdir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
    } catch {
      /* folder creation is best-effort in the stub */
    }
    return addProject(input);
  }

  async function updateProject(id: string, patch: Partial<Omit<Project, 'id'>>): Promise<void> {
    const project = projects.value.find((p) => p.id === id);
    if (!project) return;
    if (typeof patch.name === 'string') project.name = patch.name.trim() || project.name;
    if (typeof patch.path === 'string' && patch.path.trim()) project.path = normalizePath(patch.path);
    if ('notes' in patch) project.notes = patch.notes;
    await persist();
  }

  async function removeProject(id: string): Promise<void> {
    const project = projects.value.find((p) => p.id === id);
    if (!project || project.name === COMMON_NAME) return;
    projects.value = projects.value.filter((p) => p.id !== id);
    if (activeProjectId.value === id) activeProjectId.value = 'all';
    await persist();
  }

  async function setActiveProject(id: string): Promise<void> {
    activeProjectId.value =
      id === 'all' || projects.value.some((p) => p.id === id) ? id : 'all';
    await persist();
  }

  return {
    projects,
    activeProjectId,
    activeProject,
    projectNames,
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
