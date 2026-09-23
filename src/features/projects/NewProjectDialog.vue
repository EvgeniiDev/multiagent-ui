<script setup lang="ts">
// "New project" dialog — launched from the Projects view header.
//
// Two modes: (a) create a new folder on the agent host at the given path,
// (b) register an existing folder (picked with DirectoryPicker).
//
// Works against the real projects store
// (`src/stores/projects.ts`): `createProjectFolder({ name, path })` for the
// new-folder mode, `addProject({ name, path })` for the existing-folder mode.
// On success the new project becomes the active scope
// (`setActiveProject(newProject.id)`) and the parent opens its detail pane.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useConfigStore } from '../../stores/config';
import { useProjectsStore } from '../../stores/projects';
import DirectoryPicker from '../../components/DirectoryPicker.vue';

const emit = defineEmits<{
  close: [];
  /** Id of the created project — the parent selects it and opens its detail. */
  created: [projectId: string];
}>();

const configStore = useConfigStore();
const projectsStore = useProjectsStore();

const name = ref('');
const path = ref('');
/** 'new' = create the folder on the host; 'existing' = register as-is. */
const mode = ref<'new' | 'existing'>('new');
const busy = ref(false);
const error = ref('');

/** HTTP base URL of the first configured remote agent's bridge (same origin
 * as its ws URL). The DirectoryPicker lists directories through `/api/fs/*`
 * on this bridge; with no ws URL the browse button has nothing to talk to
 * and the plain text input still works. */
const fsBaseUrl = computed(() => {
  for (const agentName of configStore.agentNames) {
    const u = (configStore.getAgent(agentName)?.url ?? '').trim();
    if (u.startsWith('ws://') || u.startsWith('wss://')) {
      return (
        (u.startsWith('wss://') ? 'https://' : 'http://') +
        u.slice(u.indexOf('://') + 3).replace(/\/+$/, '')
      );
    }
  }
  return '';
});

function isAbsolute(p: string): boolean {
  return p.trim().startsWith('/');
}

function validate(): string | null {
  if (!name.value.trim()) return 'Project name is required';
  if (!path.value.trim()) return 'Project path is required';
  if (!isAbsolute(path.value)) return 'Project path must be absolute';
  return null;
}

async function confirm(): Promise<void> {
  if (busy.value) return;
  error.value = '';
  const problem = validate();
  if (problem) {
    error.value = problem;
    return;
  }
  busy.value = true;
  try {
    const input = { name: name.value.trim(), path: path.value.trim() };
    // Reject a path another project already owns with a visible message —
    // the store itself registers blindly, so the guard lives here.
    const taken = projectsStore.projects.find((p) => p.path === input.path);
    if (taken) {
      error.value = `Path is already used by project "${taken.name}"`;
      return;
    }
    const project =
      mode.value === 'new'
        ? await projectsStore.createProjectFolder(input, fsBaseUrl.value || undefined)
        : await projectsStore.addProject(input);
    await projectsStore.setActiveProject(project.id);
    emit('created', project.id);
    emit('close');
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.stopPropagation();
    emit('close');
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div class="np-overlay" @click.self="emit('close')">
    <div class="np-dialog" role="dialog" aria-modal="true" aria-label="New project">
      <header class="np-head">
        <h3>New project</h3>
        <button
          class="np-close"
          type="button"
          aria-label="Close"
          :disabled="busy"
          @click="emit('close')"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </header>

      <div class="np-body">
        <div class="np-modes" role="group" aria-label="Creation mode">
          <button
            type="button"
            :class="{ active: mode === 'new' }"
            :disabled="busy"
            @click="mode = 'new'"
          >
            New folder
          </button>
          <button
            type="button"
            :class="{ active: mode === 'existing' }"
            :disabled="busy"
            @click="mode = 'existing'"
          >
            Existing folder
          </button>
        </div>

        <label class="np-label" for="np-name">Name</label>
        <input
          id="np-name"
          v-model="name"
          class="np-input"
          type="text"
          placeholder="My project"
          :disabled="busy"
          data-testid="new-project-name"
        />

        <label class="np-label" for="np-path">Folder path</label>
        <DirectoryPicker
          :base-url="fsBaseUrl"
          v-model="path"
          :disabled="busy"
        />
        <p class="np-hint">
          {{ mode === 'new'
            ? 'The folder is created on the agent host, then registered.'
            : 'The folder must already exist on the agent host.' }}
          Absolute path required.
        </p>

        <p v-if="error" class="np-error" data-testid="new-project-error">{{ error }}</p>
      </div>

      <footer class="np-foot">
        <button class="np-cancel" type="button" :disabled="busy" @click="emit('close')">
          Cancel
        </button>
        <button
          class="np-confirm"
          type="button"
          :disabled="busy"
          data-testid="new-project-confirm"
          @click="confirm"
        >
          {{ busy ? 'Creating…' : 'Create project' }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.np-overlay {
  position: fixed;
  inset: 0;
  background: rgba(43, 39, 35, 0.28);
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
}

.np-dialog {
  width: min(460px, 92vw);
  max-height: 82vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-main, #fbf8f3);
  color: var(--text-primary, #2b2723);
  border: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  border-radius: 10px;
  overflow: hidden;
  box-shadow: 0 10px 32px rgba(43, 39, 35, 0.14);
}

.np-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
}

.np-head h3 {
  margin: 0;
  font-size: 0.875rem;
  font-weight: 600;
}

.np-close {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: var(--radius-md, 6px);
  background: transparent;
  color: var(--text-secondary, #6b6259);
  cursor: pointer;
}

.np-close:hover {
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
  color: var(--text-primary, #2b2723);
}

.np-body {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  padding: 0.875rem 1rem;
  overflow-y: auto;
}

.np-modes {
  display: flex;
  border: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  border-radius: var(--radius-md, 6px);
  overflow: hidden;
  margin-bottom: 0.5rem;
}

.np-modes button {
  flex: 1;
  height: 30px;
  padding: 0 0.5rem;
  border: none;
  background: transparent;
  color: var(--text-muted, #a39a8e);
  font-family: inherit;
  font-size: 0.75rem;
  font-weight: 600;
  cursor: pointer;
}

.np-modes button.active {
  background: var(--tint-active, rgba(194, 83, 47, 0.10));
  color: var(--text-accent, #c2532f);
}

.np-label {
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted, #a39a8e);
}

.np-label:not(:first-child) {
  margin-top: 0.5rem;
}

.np-input {
  height: 30px;
  padding: 0 0.5rem;
  border: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  border-radius: var(--radius-md, 6px);
  background: var(--bg-main, #fbf8f3);
  color: var(--text-primary, #2b2723);
  font-family: inherit;
  font-size: 0.8125rem;
}

.np-hint {
  margin: 0;
  font-size: 0.6875rem;
  color: var(--text-muted, #a39a8e);
}

.np-error {
  margin: 0.25rem 0 0;
  font-size: 0.75rem;
  color: var(--bg-danger, #b3402e);
}

.np-foot {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  border-top: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
}

.np-cancel {
  height: 30px;
  padding: 0 0.875rem;
  border: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  border-radius: var(--radius-md, 6px);
  background: transparent;
  color: var(--text-secondary, #6b6259);
  font-family: inherit;
  font-size: 0.8125rem;
  cursor: pointer;
}

.np-cancel:hover:not(:disabled) {
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
}

.np-confirm {
  height: 30px;
  padding: 0 0.875rem;
  border: none;
  border-radius: var(--radius-md, 6px);
  background: var(--bg-primary, #c2532f);
  color: var(--text-on-accent, #fbf8f3);
  font-family: inherit;
  font-size: 0.8125rem;
  font-weight: 600;
  cursor: pointer;
}

.np-confirm:hover:not(:disabled) {
  background: var(--bg-primary-hover, #a8431f);
}

.np-confirm:disabled,
.np-cancel:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

@media (max-width: 800px) {
  .np-input,
  .np-modes button,
  .np-cancel,
  .np-confirm {
    min-height: 44px;
  }

  .np-close {
    width: 44px;
    height: 44px;
  }

  .np-body :deep(.cwd-input),
  .np-body :deep(.browse-btn) {
    min-height: 44px;
  }
}
</style>
