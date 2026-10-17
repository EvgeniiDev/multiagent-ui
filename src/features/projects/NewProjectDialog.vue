<script setup lang="ts">
import UiButton from '../../components/ui/UiButton.vue';
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
        <UiButton variant="ghost" icon
          class="np-close"
          type="button"
          aria-label="Close"
          :disabled="busy"
          @click="emit('close')"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </UiButton>
      </header>

      <div class="np-body">
        <div class="np-modes" role="group" aria-label="Creation mode">
          <UiButton variant="ghost"
            type="button"
            :aria-pressed="mode === 'new'"
            :disabled="busy"
            @click="mode = 'new'"
          >
            New folder
          </UiButton>
          <UiButton variant="ghost"
            type="button"
            :aria-pressed="mode === 'existing'"
            :disabled="busy"
            @click="mode = 'existing'"
          >
            Existing folder
          </UiButton>
        </div>

        <label class="np-label" for="np-name">Name</label>
        <input
          id="np-name"
          v-model="name"
          class="ui-input np-input"
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
        <UiButton variant="secondary" class="np-cancel" type="button" :disabled="busy" @click="emit('close')">
          Cancel
        </UiButton>
        <UiButton variant="primary"
          class="np-confirm"
          type="button"
          :disabled="busy"
          data-testid="new-project-confirm"
          @click="confirm"
        >
          {{ busy ? 'Creating…' : 'Create project' }}
        </UiButton>
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
}

.np-confirm {
  height: 30px;
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
