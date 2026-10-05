<script setup lang="ts">
import { computed, onBeforeUnmount, onServerPrefetch, ref, watch } from 'vue';
import { marked, Renderer } from 'marked';
import UiButton from '../../components/ui/UiButton.vue';
import { useExecutionStore } from '../../stores/execution';
import type { ExecCheck, ExecDocKind, ExecDocVersionContent } from '../../lib/execution/api';
import { effectivePlanChecks } from '../../lib/execution/ui-model';

const props = defineProps<{
  cardId: string;
  kind: ExecDocKind;
  versionId: string;
  approved: boolean;
  disabled: boolean;
}>();
const emit = defineEmits<{
  approve: [document: { versionId: string; sha256: string; checks?: ExecCheck[] }];
}>();
const exec = useExecutionStore();
const document = ref<ExecDocVersionContent | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const expanded = ref(true);
const label = computed(() => props.kind === 'requirements' ? 'requirements' : props.kind === 'plan' ? 'plan' : 'design');
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}
function safeUrl(href: string, image = false): boolean {
  // Browser URL parsing removes embedded controls; reject them before parsing.
  if (/[\u0000-\u0020\u007f\\]/.test(href)) return false;
  try {
    const protocol = new URL(href, 'https://document.invalid/').protocol;
    return protocol === 'https:' || protocol === 'http:' || (!image && protocol === 'mailto:');
  } catch { return false; }
}
const renderer = new Renderer();
renderer.html = ({ text }) => escapeHtml(text);
renderer.link = function ({ href, title, tokens }) {
  const label = this.parser.parseInline(tokens);
  if (!safeUrl(href)) return label;
  return `<a href="${escapeHtml(href)}"${title ? ` title="${escapeHtml(title)}"` : ''} rel="noopener noreferrer">${label}</a>`;
};
renderer.image = ({ href, title, text }) => {
  if (!safeUrl(href, true)) return escapeHtml(text);
  return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}"${title ? ` title="${escapeHtml(title)}"` : ''}>`;
};
const markdown = computed(() => marked.parse(document.value?.content ?? '', { async: false, renderer }) as string);
const planChecks = computed(() => effectivePlanChecks(document.value, null));
const missingPlanChecks = computed(() => props.kind === 'plan' && (planChecks.value.problems.length > 0 || !planChecks.value.checks.length));
let generation = 0;
let inflight: Promise<void> | null = null;

async function loadDocument() {
  const seq = ++generation;
  const { cardId, versionId, kind } = props;
  document.value = null;
  error.value = null;
  loading.value = true;
  try {
    const result = await exec.getDocument(cardId, versionId);
    if (seq !== generation) return;
    if (result.versionId !== versionId || result.kind !== kind || !/^[a-f0-9]{64}$/i.test(result.sha256)) {
      throw new Error('The document does not match this version. Reload it before approving.');
    }
    document.value = result;
  } catch (e) {
    if (seq === generation) error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (seq === generation) loading.value = false;
  }
}

function reload() { inflight = loadDocument(); }
watch(() => [props.cardId, props.kind, props.versionId], () => {
  expanded.value = true;
  reload();
}, { immediate: true, flush: 'sync' });
onServerPrefetch(() => inflight ?? Promise.resolve());
onBeforeUnmount(() => { generation++; });

function approve() {
  const current = document.value;
  if (!current || loading.value || error.value || props.disabled || props.approved || missingPlanChecks.value) return;
  if (current.versionId !== props.versionId || current.kind !== props.kind) return;
  emit('approve', { versionId: current.versionId, sha256: current.sha256, ...(props.kind === 'plan' ? { checks: planChecks.value.checks } : {}) });
}
</script>

<template>
  <section class="ui-surface ui-surface-accent preparation-document" data-testid="prep-document-review" :aria-busy="loading">
    <header class="document-heading">
      <h4>Review {{ label }}</h4>
      <span v-if="props.approved" class="approved-label">Approved</span>
      <UiButton v-if="document" variant="ghost" size="xs" :aria-expanded="expanded" @click="expanded = !expanded">
        {{ expanded ? 'Collapse document' : 'Read document' }}
      </UiButton>
    </header>
    <p v-if="loading" class="ui-note" role="status">Loading {{ label }}…</p>
    <div v-else-if="error" class="document-error" role="alert">
      <p>{{ error }}</p>
      <UiButton @click="reload">Retry loading document</UiButton>
    </div>
    <template v-else-if="document">
      <div v-if="expanded" class="document-content" tabindex="0" :aria-label="`${label} document`" v-html="markdown" />
      <div v-if="props.kind === 'plan'" class="verification-checks">
        <h5>Verification commands</h5>
        <p v-if="missingPlanChecks" class="ui-note" role="status">Plan needs verification commands before approval. Ask the lead to revise the plan in the discussion.</p>
        <ul v-else>
          <li v-for="(check, index) in planChecks.checks" :key="index">
            <code>{{ check.run }}</code>
            <span v-if="check.cwd">Directory: {{ check.cwd }}</span>
            <span v-if="check.timeoutSec">Timeout: {{ check.timeoutSec }} seconds</span>
            <span v-if="check.setup">Setup command</span>
          </li>
        </ul>
      </div>
      <p class="ui-note">{{ props.approved ? 'This version is approved.' : 'Read this version before approving. To change it, tell the lead in the discussion.' }}</p>
      <UiButton v-if="!props.approved" variant="primary" :disabled="props.disabled || missingPlanChecks" :aria-busy="props.disabled" data-testid="prep-document-approve" @click="approve">
        Approve {{ label }}
      </UiButton>
    </template>
  </section>
</template>

<style scoped>
.preparation-document { display: flex; flex-direction: column; gap: 0.625rem; min-width: 0; }
.document-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 0.5rem; }
.document-heading h4 { margin: 0; flex: 1; font-size: 0.875rem; color: var(--text-primary); }
.approved-label { color: var(--text-secondary); font-size: 0.75rem; }
.document-content { max-height: min(55vh, 32rem); overflow: auto; padding: 0.625rem; background: var(--bg-main); border: 1px solid var(--border-color); border-radius: var(--radius-sm); color: var(--text-primary); font-size: 0.8125rem; line-height: 1.6; overflow-wrap: anywhere; }
.document-content:focus-visible { outline: 2px solid var(--text-accent); outline-offset: 2px; }
.document-content :deep(> :first-child) { margin-top: 0; }
.document-content :deep(> :last-child) { margin-bottom: 0; }
.document-content :deep(h1), .document-content :deep(h2), .document-content :deep(h3) { line-height: 1.35; font-size: 1em; margin-top: 1.25em; }
.document-content :deep(ul), .document-content :deep(ol) { padding-left: 1.4em; }
.document-content :deep(pre) { overflow-x: auto; padding: 0.5rem; background: var(--bg-code); color: var(--text-code); border-radius: var(--radius-sm); }
.document-content :deep(code) { font-family: var(--font-mono); font-size: 0.9em; }
.document-content :deep(table) { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; }
.document-content :deep(th), .document-content :deep(td) { border: 1px solid var(--border-color); padding: 0.35rem; }
.document-content :deep(a) { color: var(--text-accent); }
.document-content :deep(img) { max-width: 100%; height: auto; }
.document-error { color: var(--text-secondary); font-size: 0.8125rem; }
.document-error p { margin: 0 0 0.5rem; overflow-wrap: anywhere; }
.verification-checks h5 { font-size: 0.8125rem; margin: 0 0 0.5rem; }
.verification-checks ul { margin: 0; padding-left: 1.25rem; }
.verification-checks li { font-size: 0.75rem; margin-bottom: 0.5rem; overflow-wrap: anywhere; }
.verification-checks code { font-family: var(--font-mono); white-space: pre-wrap; }
.verification-checks span { display: block; color: var(--text-secondary); }
</style>
