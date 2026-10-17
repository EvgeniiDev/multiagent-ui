<script setup lang="ts">
import UiButton from '../../components/ui/UiButton.vue';
import { computed, onMounted, ref } from 'vue';
import DirectoryPicker from '../../components/DirectoryPicker.vue';
import { useConfigStore } from '../../stores/config';
import { COMMON_PROJECT_NAME, useProjectsStore, type Project } from '../../stores/projects';
import {
  bridgeBaseUrlForAgentUrl,
  defaultBridgeBaseUrl,
  fsMkdir,
} from './fsApi';

// Settings → Projects: the project registry admin (project = a folder).
// Create = make the folder on the host, then register. Add existing =
// pick the folder with DirectoryPicker, then register. No GitHub/GitLab
// links (owner decision) — no fields or buttons for that here.

const projectsStore = useProjectsStore();
const configStore = useConfigStore();

/** Bridge base URL: first configured remote agent's bridge, else the
 * default Hermes bridge on the page host (covers the bare dist-web
 * harness with no agents configured). */
const fsBaseUrl = computed(() => {
  for (const name of configStore.allAgentNames) {
    const base = bridgeBaseUrlForAgentUrl(configStore.getAgent(name)?.url);
    if (base) return base;
  }
  return defaultBridgeBaseUrl();
});

const newName = ref('');
const newPath = ref('');
const busy = ref(false);
const error = ref('');
const editingId = ref<string | null>(null);
const editName = ref('');
const editPath = ref('');
const editNotes = ref('');
const notesDrafts = ref<Record<string, string>>({});

function isCommon(p: Project): boolean {
  return p.name === COMMON_PROJECT_NAME;
}

async function handleCreate(): Promise<void> {
  error.value = '';
  if (!newName.value.trim() || !newPath.value.trim()) {
    error.value = 'Name and folder path are required';
    return;
  }
  busy.value = true;
  try {
    // Create-then-register (not the store helper): without a configured
    // agent fsBaseUrl may still resolve via the default fallback, and the
    // folder must be created first either way.
    const created = await fsMkdir(fsBaseUrl.value, newPath.value.trim());
    await projectsStore.addProject({ name: newName.value.trim(), path: created });
    newName.value = '';
    newPath.value = '';
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function handleAddExisting(): Promise<void> {
  error.value = '';
  if (!newName.value.trim() || !newPath.value.trim()) {
    error.value = 'Name and folder path are required';
    return;
  }
  busy.value = true;
  try {
    await projectsStore.addProject({ name: newName.value.trim(), path: newPath.value.trim() });
    newName.value = '';
    newPath.value = '';
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

function startEdit(p: Project): void {
  editingId.value = p.id;
  editName.value = p.name;
  editPath.value = p.path;
  editNotes.value = p.notes ?? '';
  error.value = '';
}

function cancelEdit(): void {
  editingId.value = null;
}

async function saveEdit(p: Project): Promise<void> {
  error.value = '';
  busy.value = true;
  try {
    await projectsStore.updateProject(p.id, {
      name: editName.value.trim(),
      path: editPath.value.trim(),
      notes: editNotes.value,
    });
    editingId.value = null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function handleRemove(p: Project): Promise<void> {
  error.value = '';
  if (isCommon(p)) {
    error.value = 'The Common project cannot be deleted';
    return;
  }
  if (!confirm(`Delete project "${p.name}"? The folder stays on disk.`)) return;
  busy.value = true;
  try {
    await projectsStore.removeProject(p.id);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function saveNotes(p: Project): Promise<void> {
  error.value = '';
  try {
    await projectsStore.updateProject(p.id, { notes: notesDrafts.value[p.id] ?? '' });
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

onMounted(async () => {
  await projectsStore.initProjectsStore(fsBaseUrl.value);
  for (const p of projectsStore.projects) notesDrafts.value[p.id] = p.notes ?? '';
  // Exposed for the e2e contract check (real projectIdForCwd etc.).
  (window as unknown as { __projects: unknown }).__projects = projectsStore;
});
</script>

<template>
  <section class="projects-section" data-testid="settings-projects">
    <div class="section-header">
      <h3>Projects</h3>
    </div>
    <p class="section-hint">A project is a folder on the agent host.</p>

    <div v-if="error" class="form-error" data-testid="projects-error">{{ error }}</div>

    <div class="project-form" data-testid="projects-form">
      <div class="form-group">
        <label for="proj-name">Name</label>
        <input class="ui-input"
          id="proj-name"
          v-model="newName"
          type="text"
          placeholder="My project"
          data-testid="projects-name"
        />
      </div>
      <div class="form-group">
        <label>Folder</label>
        <DirectoryPicker
          v-model="newPath"
          :base-url="fsBaseUrl"
          data-testid="projects-picker"
        />
      </div>
      <div class="form-actions">
        <UiButton
          class="save-btn"
          type="button"
          :disabled="busy"
          data-testid="projects-create"
          @click="handleCreate"
          variant="primary"
        >
          Create project (new folder)
        </UiButton>
        <UiButton
          class="cancel-btn"
          type="button"
          :disabled="busy"
          data-testid="projects-add"
          @click="handleAddExisting"
        >
          Add existing folder
        </UiButton>
      </div>
    </div>

    <ul class="projects-list" data-testid="projects-list">
      <li
        v-for="p in projectsStore.projects"
        :key="p.id"
        class="project-item"
        :data-testid="`project-${p.id}`"
        :data-project="p.name"
      >
        <template v-if="editingId === p.id">
          <div class="form-group">
            <label>Name</label>
            <input class="ui-input" v-model="editName" type="text" data-testid="project-edit-name" />
          </div>
          <div class="form-group">
            <label>Path</label>
            <input class="ui-input" v-model="editPath" type="text" data-testid="project-edit-path" />
          </div>
          <div class="form-group">
            <label>Notes</label>
            <input class="ui-input" v-model="editNotes" type="text" data-testid="project-edit-notes" />
          </div>
          <div class="form-actions">
            <UiButton class="save-btn" type="button" :disabled="busy" data-testid="project-save" @click="saveEdit(p)" variant="primary">
              Save
            </UiButton>
            <UiButton class="cancel-btn" type="button" data-testid="project-cancel" @click="cancelEdit">
              Cancel
            </UiButton>
          </div>
        </template>
        <template v-else>
          <div class="project-info">
            <div class="project-name">
              {{ p.name }}
              <span v-if="isCommon(p)" class="common-badge" data-testid="project-common-badge">default</span>
            </div>
            <div class="project-path">
              <code :data-testid="`project-path-${p.id}`">{{ p.path }}</code>
            </div>
            <div v-if="p.notes" class="project-notes" :data-testid="`project-notes-${p.id}`">{{ p.notes }}</div>
            <div v-else class="project-notes-form">
              <input class="ui-input"
                v-model="notesDrafts[p.id]"
                type="text"
                placeholder="Add a note…"
                :aria-label="`Notes for ${p.name}`"
                :data-testid="`project-notes-input-${p.id}`"
              />
              <UiButton
                class="edit-btn"
                type="button"
                :data-testid="`project-notes-save-${p.id}`"
                @click="saveNotes(p)"
              >
                Save note
              </UiButton>
            </div>
          </div>
          <div class="project-actions">
            <UiButton class="edit-btn" type="button" data-testid="project-rename" @click="startEdit(p)">
              Rename
            </UiButton>
            <UiButton
              class="delete-btn"
              type="button"
              :disabled="isCommon(p)"
              :title="isCommon(p) ? 'The Common project cannot be deleted' : `Delete ${p.name}`"
              data-testid="project-delete"
              @click="handleRemove(p)"
              variant="danger"
            >
              Delete
            </UiButton>
          </div>
        </template>
      </li>
    </ul>
    <div v-if="projectsStore.projects.length === 0" class="no-projects" data-testid="projects-empty">
      No projects yet.
    </div>
  </section>
</template>

<style scoped>
.projects-section {
  margin-top: 1.5rem;
  padding-top: 1.5rem;
  border-top: 1px solid var(--border-color);
}
.section-header h3 {
  margin: 0;
}
.section-hint {
  font-size: 0.8rem;
  color: var(--text-muted);
  margin: 0.25rem 0 1rem;
}
.form-error {
  color: var(--bg-danger);
  font-size: 0.875rem;
  margin-bottom: 0.75rem;
}
.project-form {
  background: var(--bg-sidebar);
  padding: 1rem;
  border-radius: 6px;
  margin-bottom: 1rem;
}
.form-group {
  margin-bottom: 0.75rem;
}
.form-group label {
  display: block;
  font-size: 0.875rem;
  font-weight: 500;
  margin-bottom: 0.25rem;
}
.form-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.projects-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.project-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.75rem;
  background: var(--bg-sidebar);
  border-radius: 6px;
}
.project-info {
  flex: 1;
  min-width: 0;
}
.project-name {
  overflow-wrap: anywhere;
  font-weight: 500;
  margin-bottom: 0.25rem;
}
.common-badge {
  display: inline-block;
  margin-left: 0.5rem;
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  background: var(--accent-soft, rgba(194, 83, 47, 0.14));
  color: var(--text-accent, #c2532f);
}
.project-path {
  font-size: 0.8rem;
  color: var(--text-muted);
}
.project-path code {
  background: var(--bg-main);
  padding: 0.125rem 0.375rem;
  border-radius: 3px;
  word-break: break-all;
}
.project-notes {
  overflow-wrap: anywhere;
  font-size: 0.8rem;
  color: var(--text-secondary);
  margin-top: 0.25rem;
}
.project-notes-form {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.25rem;
}
.project-notes-form input { flex: 1; min-width: 0; }
.project-actions {
  display: flex;
  gap: 0.5rem;
  margin-left: 1rem;
  flex-shrink: 0;
}
.no-projects {
  text-align: center;
  padding: 1rem;
  color: var(--text-muted);
}
/* Editing fields always have their own full-width row. */
.project-item:has(> .form-group) { flex-direction: column; align-items: stretch; }
@media (max-width: 600px) {
  .project-item { flex-direction: column; align-items: stretch; gap: 0.75rem; }
  .project-actions { margin-left: 0; }
  .project-actions > * { flex: 1; }
  .project-notes-form { margin-top: 0.75rem; }
  .project-notes-form > .edit-btn { flex-shrink: 0; }
  .project-form .form-actions { flex-direction: column; align-items: stretch; }
}
</style>
