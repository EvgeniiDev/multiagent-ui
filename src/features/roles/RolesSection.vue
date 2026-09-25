<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useConfigStore } from '../../stores/config';
import { useProjectsStore } from '../../stores/projects';
import type { BoardStageId } from '../../stores/board';
import {
  KNOWN_CLIS,
  useRolesStore,
  DEFAULT_REVIEW_RULES,
  type Role,
  type ReviewRules,
} from '../../stores/roles';
import { BOARD_STAGES } from '../board/columns';
import {
  bridgeBaseUrlForAgentUrl,
  defaultBridgeBaseUrl,
} from '../settings/fsApi';
import { readTextFile, writeTextFile } from '../../lib/fsApi';

// Settings → Roles: the role registry admin. A role is data only — CLI,
// args, prompt-file path and limits. The prompt text itself lives in a file
// inside the project directory and is viewed/edited through the bridge fs
// API ("Open prompt file"); no prompt text is embedded in the panel.

const rolesStore = useRolesStore();
const configStore = useConfigStore();
const projectsStore = useProjectsStore();

/** Bridge base URL: first configured remote agent's bridge, else the
 * default Hermes bridge on the page host — same resolution as
 * Settings → Projects. */
const fsBaseUrl = computed(() => {
  for (const name of configStore.allAgentNames) {
    const base = bridgeBaseUrlForAgentUrl(configStore.getAgent(name)?.url);
    if (base) return base;
  }
  return defaultBridgeBaseUrl();
});

const CLI_OPTIONS = KNOWN_CLIS;

// ---- role form (add + edit share the same fields) ---------------------------

const showForm = ref(false);
const editingId = ref<string | null>(null);
const formId = ref('');
const formLabel = ref('');
const formCli = ref<string>(KNOWN_CLIS[0]);
const formArgs = ref('');
const formPromptFile = ref('');
const formMaxConcurrent = ref(1);
const formPollIntervalSec = ref(15);
const formTimeoutMin = ref(45);
const formMaxRetries = ref(1);
// Optional per-step model pair — only meaningful when the args template
// references a `{models.*}` placeholder, so the fields stay hidden until
// then (the simple single-model case is not bothered by them).
const formModelPlan = ref('');
const formModelExecute = ref('');
const formIdleTimeoutMin = ref(15);
// Review-cycle rules (the severity vocabulary, the gate/backlog severities
// and the round limit) are role DATA — text fields here, `role.review` in
// roles.json. All empty = the role carries no review data and defaults
// apply at read time.
const formReviewSev = ref('');
const formReviewBlocking = ref('');
const formReviewBacklog = ref('');
const formReviewRounds = ref('');
const error = ref('');
const busy = ref(false);
/** Role whose last delete was rejected because it is still assigned — its
 * row shows the explicit Force delete button. */
const forceDeleteId = ref<string | null>(null);

function resetForm(): void {
  formId.value = '';
  formLabel.value = '';
  formCli.value = KNOWN_CLIS[0];
  formArgs.value = '';
  formPromptFile.value = '';
  formMaxConcurrent.value = 1;
  formPollIntervalSec.value = 15;
  formTimeoutMin.value = 45;
  formMaxRetries.value = 1;
  formModelPlan.value = '';
  formModelExecute.value = '';
  formIdleTimeoutMin.value = 15;
  formReviewSev.value = '';
  formReviewBlocking.value = '';
  formReviewBacklog.value = '';
  formReviewRounds.value = '';
  showForm.value = false;
  editingId.value = null;
}

function startAdd(): void {
  resetForm();
  showForm.value = true;
}

function startEdit(r: Role): void {
  resetForm();
  editingId.value = r.id;
  formId.value = r.id;
  formLabel.value = r.label;
  formCli.value = r.cli;
  formArgs.value = r.args.join(' ');
  formPromptFile.value = r.promptFile;
  formMaxConcurrent.value = r.maxConcurrent;
  formPollIntervalSec.value = r.pollIntervalSec;
  formTimeoutMin.value = r.timeoutMin;
  formMaxRetries.value = r.maxRetries;
  formModelPlan.value = r.models?.plan ?? '';
  formModelExecute.value = r.models?.execute ?? '';
  formIdleTimeoutMin.value = r.idleTimeoutMin;
  formReviewSev.value = r.review?.severities.join(' ') ?? '';
  formReviewBlocking.value = r.review?.blocking.join(' ') ?? '';
  formReviewBacklog.value = r.review?.backlog.join(' ') ?? '';
  formReviewRounds.value = r.review ? String(r.review.maxRounds) : '';
  error.value = '';
}

/** Space-separated args with quotes — same parsing as the agent form. */
function parseArgs(argsString: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuotes = false;
  let quoteChar = '';
  for (const char of argsString) {
    if ((char === '"' || char === "'") && !inQuotes) {
      inQuotes = true;
      quoteChar = char;
    } else if (char === quoteChar && inQuotes) {
      inQuotes = false;
      quoteChar = '';
    } else if (char === ' ' && !inQuotes) {
      if (current.trim()) args.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

/** Show the model pair only when the args template references a
 * `{models.*}` placeholder — or when a pair is already filled in (a role
 * that carries `models` keeps them visible for review/removal even if the
 * args were since simplified). */
const showModelFields = computed(
  () =>
    /\{models\.(plan|execute)\}/.test(formArgs.value) ||
    !!formModelPlan.value.trim() ||
    !!formModelExecute.value.trim()
);

function formToRole(id: string): Role {
  const anyModels = formModelPlan.value.trim() || formModelExecute.value.trim();
  const models = anyModels
    ? { plan: formModelPlan.value.trim(), execute: formModelExecute.value.trim() }
    : undefined;
  const anyReview =
    formReviewSev.value.trim() ||
    formReviewBlocking.value.trim() ||
    formReviewBacklog.value.trim() ||
    formReviewRounds.value.trim();
  // Any field set → the role carries review data; a field left empty takes
  // the default list/limit so a half-filled form still yields a coherent
  // record (the store's validateReview checks subsets afterwards).
  const review: ReviewRules | undefined = anyReview
    ? {
        severities: formReviewSev.value.trim()
          ? formReviewSev.value.trim().split(/\s+/)
          : [...DEFAULT_REVIEW_RULES.severities],
        blocking: formReviewBlocking.value.trim()
          ? formReviewBlocking.value.trim().split(/\s+/)
          : [...DEFAULT_REVIEW_RULES.blocking],
        backlog: formReviewBacklog.value.trim()
          ? formReviewBacklog.value.trim().split(/\s+/)
          : [...DEFAULT_REVIEW_RULES.backlog],
        maxRounds: Number(formReviewRounds.value) || DEFAULT_REVIEW_RULES.maxRounds,
      }
    : undefined;
  return {
    id,
    label: formLabel.value,
    cli: formCli.value,
    args: parseArgs(formArgs.value),
    promptFile: formPromptFile.value,
    maxConcurrent: Number(formMaxConcurrent.value),
    pollIntervalSec: Number(formPollIntervalSec.value),
    timeoutMin: Number(formTimeoutMin.value),
    maxRetries: Number(formMaxRetries.value),
    models,
    idleTimeoutMin: Number(formIdleTimeoutMin.value),
    review,
  };
}

function handleSubmit(): void {
  error.value = '';
  busy.value = true;
  try {
    if (editingId.value) {
      rolesStore.updateRole(editingId.value, formToRole(editingId.value));
    } else {
      rolesStore.addRole(formToRole(formId.value));
    }
    resetForm();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function handleRemove(r: Role): Promise<void> {
  error.value = '';
  try {
    rolesStore.removeRole(r.id);
    forceDeleteId.value = null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    if (rolesStore.stagesForRole(r.id).length) forceDeleteId.value = r.id;
  }
}

/** Explicit force path: only offered after the guarded delete rejected. */
function handleForceRemove(r: Role): void {
  error.value = '';
  try {
    rolesStore.removeRole(r.id, { force: true });
    forceDeleteId.value = null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

// ---- stage -> role ----------------------------------------------------------

function stageRoleValue(stage: BoardStageId): string {
  return rolesStore.stageRoles[stage] ?? '';
}

function onStageRoleChange(stage: BoardStageId, event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  error.value = '';
  try {
    rolesStore.setStageRole(stage, value || null);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

// ---- prompt file (via the bridge fs API) ------------------------------------

const promptRoleId = ref<string | null>(null);
const promptPath = ref('');
const promptContent = ref('');
const promptStatus = ref('');
const promptError = ref('');
const promptBusy = ref(false);

/** Effective path sent to the bridge: absolute stays absolute; a relative
 * promptFile resolves against the active project folder, and with no active
 * project it is passed through — the bridge resolves it against its root. */
function resolvePromptPath(promptFile: string): string {
  const p = promptFile.trim();
  if (p.startsWith('/')) return p;
  const project = projectsStore.activeProject;
  if (project) return `${project.path.replace(/\/+$/, '')}/${p}`;
  return p;
}

async function openPrompt(r: Role): Promise<void> {
  promptRoleId.value = r.id;
  promptPath.value = resolvePromptPath(r.promptFile);
  promptContent.value = '';
  promptStatus.value = '';
  promptError.value = '';
  promptBusy.value = true;
  try {
    const res = await readTextFile(fsBaseUrl.value, promptPath.value);
    promptPath.value = res.path;
    promptContent.value = res.content;
    promptStatus.value = `${res.bytes} bytes`;
  } catch (e) {
    promptError.value = e instanceof Error ? e.message : String(e);
  } finally {
    promptBusy.value = false;
  }
}

async function savePrompt(): Promise<void> {
  promptError.value = '';
  promptStatus.value = '';
  promptBusy.value = true;
  try {
    const res = await writeTextFile(
      fsBaseUrl.value,
      promptPath.value,
      promptContent.value
    );
    promptPath.value = res.path;
    promptStatus.value = `saved — ${res.bytes} bytes`;
  } catch (e) {
    promptError.value = e instanceof Error ? e.message : String(e);
  } finally {
    promptBusy.value = false;
  }
}

function closePrompt(): void {
  promptRoleId.value = null;
  promptError.value = '';
  promptStatus.value = '';
}

function isAssigned(r: Role): boolean {
  return rolesStore.stagesForRole(r.id).length > 0;
}

onMounted(async () => {
  await rolesStore.initRolesStore();
  // Exposed for the e2e contract check (same seam as window.__projects).
  (window as unknown as { __roles: unknown }).__roles = rolesStore;
});
</script>

<template>
  <section class="roles-section" data-testid="settings-roles">
    <div class="section-header">
      <h3>Roles</h3>
      <button class="add-btn" type="button" data-testid="roles-add-toggle" @click="startAdd" :disabled="showForm">
        + Add role
      </button>
    </div>
    <p class="section-hint">
      A role binds a CLI, its arguments and a prompt file to a pipeline stage.
      The prompt text lives in the file — the panel only stores the path.
    </p>

    <div v-if="error" class="form-error" data-testid="roles-error">{{ error }}</div>

    <!-- Add / edit form -->
    <div v-if="showForm || editingId" class="role-form" data-testid="roles-form">
      <h4>{{ editingId ? `Edit role '${editingId}'` : 'Add role' }}</h4>
      <div class="form-grid">
        <div class="form-group">
          <label>Id</label>
          <input v-model="formId" type="text" placeholder="dev" :disabled="!!editingId" data-testid="role-id" />
        </div>
        <div class="form-group">
          <label>Label</label>
          <input v-model="formLabel" type="text" placeholder="Developer" data-testid="role-label" />
        </div>
        <div class="form-group">
          <label>CLI</label>
          <select v-model="formCli" data-testid="role-cli">
            <option v-for="c in CLI_OPTIONS" :key="c" :value="c">{{ c }}</option>
          </select>
        </div>
        <div class="form-group">
          <label>Prompt file</label>
          <input v-model="formPromptFile" type="text" placeholder=".acp/roles/dev.md" data-testid="role-prompt" />
          <small>Relative to the project folder, or absolute.</small>
        </div>
        <div class="form-group form-group-wide">
          <label>Arguments</label>
          <input v-model="formArgs" type="text" placeholder="-p --model swe-2-max" data-testid="role-args" />
          <small>Space-separated. Use quotes for args with spaces. Reference
            <code>{models.plan}</code> / <code>{models.execute}</code> to take
            the step model from the pair below.</small>
        </div>
        <div class="form-group" v-if="showModelFields">
          <label>Model for planning (optional)</label>
          <input v-model="formModelPlan" type="text" placeholder="model for the plan stage" data-testid="role-model-plan" />
          <small>Substituted into <code>{models.*}</code> args while the card is in the plan stage.</small>
        </div>
        <div class="form-group" v-if="showModelFields">
          <label>Model for execution (optional)</label>
          <input v-model="formModelExecute" type="text" placeholder="model for all other stages" data-testid="role-model-execute" />
          <small>Substituted on every other step. Both fields are required to store the pair.</small>
        </div>
        <div class="form-group">
          <label>Max concurrent</label>
          <input v-model.number="formMaxConcurrent" type="number" min="1" step="1" data-testid="role-maxc" />
        </div>
        <div class="form-group">
          <label>Poll interval (s)</label>
          <input v-model.number="formPollIntervalSec" type="number" min="5" step="1" data-testid="role-poll" />
        </div>
        <div class="form-group">
          <label>Timeout (min)</label>
          <input v-model.number="formTimeoutMin" type="number" min="1" step="1" data-testid="role-timeout" />
        </div>
        <div class="form-group">
          <label>Max retries</label>
          <input v-model.number="formMaxRetries" type="number" min="1" step="1" data-testid="role-retries" />
          <small>Attempts per card; 1 = no retry, then the card is flagged blocked.</small>
        </div>
        <div class="form-group">
          <label>Idle timeout (min)</label>
          <input v-model.number="formIdleTimeoutMin" type="number" min="0" step="1" data-testid="role-idle" />
          <small>A child silent this long is killed as a failed attempt; 0 disables the watchdog.</small>
        </div>
        <div class="form-group">
          <label>Review severities</label>
          <input v-model="formReviewSev" type="text" placeholder="critical major minor nit" data-testid="role-review-sev" />
          <small>Space-separated vocabulary; empty = no review data on the role.</small>
        </div>
        <div class="form-group">
          <label>Review blocking severities</label>
          <input v-model="formReviewBlocking" type="text" placeholder="critical major" data-testid="role-review-blocking" />
          <small>Open findings of these severities refuse agent_tested.</small>
        </div>
        <div class="form-group">
          <label>Review backlog severities</label>
          <input v-model="formReviewBacklog" type="text" placeholder="minor nit" data-testid="role-review-backlog" />
          <small>These never block; each becomes a backlog card on sync.</small>
        </div>
        <div class="form-group">
          <label>Review round limit</label>
          <input v-model="formReviewRounds" type="number" min="1" step="1" placeholder="3" data-testid="role-review-rounds" />
          <small>Reaching the limit with open blocking findings flags the card blocked.</small>
        </div>
      </div>
      <div class="form-actions">
        <button class="save-btn" type="button" :disabled="busy" data-testid="role-save" @click="handleSubmit">
          {{ editingId ? 'Save' : 'Add role' }}
        </button>
        <button class="cancel-btn" type="button" data-testid="role-cancel" @click="resetForm">
          Cancel
        </button>
      </div>
    </div>

    <!-- Role list -->
    <ul class="roles-list" data-testid="roles-list">
      <li
        v-for="r in rolesStore.roles"
        :key="r.id"
        class="role-item"
        :data-testid="`role-${r.id}`"
      >
        <div class="role-info">
          <div class="role-name">
            {{ r.label }}
            <span class="cli-badge">{{ r.cli }}</span>
            <span
              v-if="!rolesStore.roleHasRunner(r)"
              class="no-runner-badge"
              data-testid="role-no-runner"
              title="No configured agent matches this CLI"
            >no runner</span>
          </div>
          <div class="role-detail">
            <code :data-testid="`role-promptfile-${r.id}`">{{ r.promptFile }}</code>
          </div>
          <div class="role-limits">
            id <code>{{ r.id }}</code> · args <code>{{ r.args.join(' ') || '—' }}</code>
            · max {{ r.maxConcurrent }} · poll {{ r.pollIntervalSec }}s · timeout {{ r.timeoutMin }}m · retries {{ r.maxRetries }}
            <template v-if="r.models">
              · models <code :data-testid="`role-models-${r.id}`">plan→{{ r.models.plan }} execute→{{ r.models.execute }}</code>
            </template>
            · idle {{ r.idleTimeoutMin > 0 ? `${r.idleTimeoutMin}m` : 'off' }}
            <template v-if="r.review">
              · review <code data-testid="role-review-{{ r.id }}">{{ r.review.severities.join(' ') }}</code>
              · gate {{ r.review.blocking.join(',') || '—' }} · backlog {{ r.review.backlog.join(',') || '—' }}
              · rounds {{ r.review.maxRounds }}
            </template>
            <template v-if="isAssigned(r)"> · stage: {{ rolesStore.stagesForRole(r.id).join(', ') }}</template>
          </div>
        </div>
        <div class="role-actions">
          <button class="edit-btn" type="button" :data-testid="`role-prompt-btn-${r.id}`" @click="openPrompt(r)">
            Prompt file
          </button>
          <button class="edit-btn" type="button" :data-testid="`role-edit-${r.id}`" @click="startEdit(r)">
            Edit
          </button>
          <button class="delete-btn" type="button" :data-testid="`role-delete-${r.id}`" @click="handleRemove(r)">
            Delete
          </button>
          <button
            v-if="forceDeleteId === r.id"
            class="delete-btn force"
            type="button"
            :data-testid="`role-force-delete-${r.id}`"
            @click="handleForceRemove(r)"
          >
            Force delete
          </button>
        </div>
      </li>
    </ul>
    <div v-if="rolesStore.roles.length === 0" class="no-roles" data-testid="roles-empty">
      No roles yet.
    </div>

    <!-- Prompt file editor (bridge fs read/write) -->
    <div v-if="promptRoleId" class="prompt-editor" data-testid="prompt-editor">
      <div class="prompt-head">
        <span class="prompt-path" :title="promptPath" data-testid="prompt-path">{{ promptPath }}</span>
        <button class="cancel-btn slim" type="button" data-testid="prompt-close" @click="closePrompt">
          Close
        </button>
      </div>
      <p v-if="promptBusy" class="prompt-status" data-testid="prompt-status">working…</p>
      <p v-else-if="promptStatus" class="prompt-status" data-testid="prompt-status">{{ promptStatus }}</p>
      <p v-if="promptError" class="form-error" data-testid="prompt-error">{{ promptError }}</p>
      <textarea
        v-model="promptContent"
        class="prompt-content"
        rows="8"
        spellcheck="false"
        placeholder="Prompt file content (empty file is fine)"
        data-testid="prompt-content"
      ></textarea>
      <div class="form-actions">
        <button class="save-btn" type="button" :disabled="promptBusy" data-testid="prompt-save" @click="savePrompt">
          Save prompt file
        </button>
      </div>
    </div>

    <!-- Stage -> role map -->
    <div class="stage-roles" data-testid="stage-roles">
      <h4>Stage → role</h4>
      <p class="section-hint">Empty means: as before — any runner may pick up the stage's cards.</p>
      <div class="stage-grid">
        <div v-for="s in BOARD_STAGES" :key="s.id" class="stage-row">
          <label :for="`stage-role-${s.id}`">{{ s.label }}</label>
          <select
            :id="`stage-role-${s.id}`"
            :value="stageRoleValue(s.id)"
            :data-testid="`stage-role-${s.id}`"
            @change="onStageRoleChange(s.id, $event)"
          >
            <option value="">— any runner —</option>
            <option v-for="r in rolesStore.roles" :key="r.id" :value="r.id">{{ r.label }} ({{ r.id }})</option>
          </select>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.roles-section {
  margin-top: 1.5rem;
  padding-top: 1.5rem;
  border-top: 1px solid var(--border-color);
}
.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.25rem;
}
.section-header h3 {
  margin: 0;
}
.section-hint {
  font-size: 0.8rem;
  color: var(--text-muted);
  margin: 0.25rem 0 1rem;
}
.add-btn {
  padding: 0.375rem 0.75rem;
  border: 1px solid var(--bg-primary);
  background: transparent;
  color: var(--bg-primary);
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.875rem;
}
.add-btn:hover:not(:disabled) {
  background: var(--bg-primary);
  color: var(--text-on-accent, #fbf8f3);
}
.add-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.form-error {
  color: var(--bg-danger);
  font-size: 0.875rem;
  margin-bottom: 0.75rem;
}
.role-form {
  background: var(--bg-sidebar);
  padding: 1rem;
  border-radius: 6px;
  margin-bottom: 1rem;
}
.role-form h4 {
  margin: 0 0 1rem 0;
  font-size: 1rem;
}
.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 0.75rem;
}
.form-group {
  margin-bottom: 0.75rem;
}
.form-group-wide {
  grid-column: 1 / -1;
}
.form-group label {
  display: block;
  font-size: 0.875rem;
  font-weight: 500;
  margin-bottom: 0.25rem;
}
.form-group input,
.form-group select {
  width: 100%;
  padding: 0.5rem;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  font-size: 0.9rem;
  background: var(--bg-main);
  color: var(--text-primary);
}
.form-group input:focus,
.form-group select:focus {
  outline: none;
  border-color: var(--bg-primary);
}
.form-group small {
  display: block;
  margin-top: 0.25rem;
  font-size: 0.75rem;
  color: var(--text-muted);
}
.form-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.save-btn {
  padding: 0.5rem 1rem;
  background: var(--bg-primary);
  color: var(--text-on-accent, #fbf8f3);
  border: none;
  border-radius: 4px;
  cursor: pointer;
}
.save-btn:hover:not(:disabled) {
  background: var(--bg-primary-hover);
}
.save-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.cancel-btn {
  padding: 0.5rem 1rem;
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  cursor: pointer;
}
.cancel-btn.slim {
  padding: 0.25rem 0.75rem;
  font-size: 0.8rem;
}
.cancel-btn:hover {
  background: var(--bg-hover);
}
.roles-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.role-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.75rem;
  background: var(--bg-sidebar);
  border-radius: 6px;
}
.role-info {
  flex: 1;
  min-width: 0;
}
.role-name {
  font-weight: 500;
  margin-bottom: 0.25rem;
}
.cli-badge {
  display: inline-block;
  margin-left: 0.5rem;
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  background: var(--accent-soft, rgba(194, 83, 47, 0.14));
  color: var(--text-accent, #c2532f);
  border: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
}
.no-runner-badge {
  display: inline-block;
  margin-left: 0.5rem;
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--bg-danger);
  border: 1px solid var(--bg-danger);
}
.role-detail {
  font-size: 0.8rem;
  color: var(--text-muted);
}
.role-detail code,
.role-limits code {
  background: var(--bg-main);
  padding: 0.125rem 0.375rem;
  border-radius: 3px;
  word-break: break-all;
}
.role-limits {
  font-size: 0.75rem;
  color: var(--text-secondary);
  margin-top: 0.25rem;
}
.role-actions {
  display: flex;
  gap: 0.5rem;
  margin-left: 1rem;
  flex-shrink: 0;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.edit-btn,
.delete-btn {
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
  font-size: 0.8rem;
  cursor: pointer;
}
.edit-btn {
  background: transparent;
  border: 1px solid var(--border-color);
  color: var(--text-secondary);
}
.edit-btn:hover {
  background: var(--bg-hover);
}
.delete-btn {
  background: transparent;
  border: 1px solid var(--bg-danger);
  color: var(--bg-danger);
}
.delete-btn:hover {
  background: var(--bg-danger-hover);
  color: var(--text-on-accent, #fbf8f3);
}
.no-roles {
  text-align: center;
  padding: 1rem;
  color: var(--text-muted);
}
.prompt-editor {
  margin-top: 1rem;
  padding: 0.75rem;
  background: var(--bg-sidebar);
  border: 1px solid var(--border-faint);
  border-radius: 6px;
}
.prompt-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}
.prompt-path {
  font-family: var(--font-mono, monospace);
  font-size: 0.75rem;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.prompt-status {
  font-size: 0.75rem;
  color: var(--text-muted);
  margin-bottom: 0.5rem;
}
.prompt-content {
  width: 100%;
  padding: 0.5rem;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  font-family: var(--font-mono, monospace);
  font-size: 0.8rem;
  background: var(--bg-main);
  color: var(--text-primary);
  resize: vertical;
  margin-bottom: 0.5rem;
}
.stage-roles {
  margin-top: 1.25rem;
}
.stage-roles h4 {
  margin: 0 0 0.25rem 0;
  font-size: 0.95rem;
}
.stage-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.375rem 0.75rem;
}
.stage-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.stage-row label {
  flex: 0 0 5.5rem;
  font-size: 0.8rem;
  color: var(--text-secondary);
}
.stage-row select {
  flex: 1;
  min-width: 0;
  padding: 0.25rem 0.375rem;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  font-size: 0.8rem;
  background: var(--bg-main);
  color: var(--text-primary);
}
</style>
