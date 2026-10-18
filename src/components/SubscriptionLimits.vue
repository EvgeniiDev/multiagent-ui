<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, useId } from 'vue';
import UiButton from './ui/UiButton.vue';
import { stateServerBase } from '../lib/host/storage';

interface Window { id: string; label: string; usedPercent: number; resetsAt: number | null }
interface Provider { id: string; name: string; status: string; message: string | null; windows: Window[] }
const props = defineProps<{ providerId?: string; compact?: boolean }>();
const titleId = useId();
const data = ref<{ updatedAt: number; providers: Provider[] } | null>(null);
const providers = computed(() => data.value?.providers.filter(provider => !props.providerId || provider.id === props.providerId) ?? []);
const loading = ref(false);
const error = ref('');
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval>;
let controller: AbortController | null = null;
let disposed = false;

async function refresh() {
  if (loading.value) return;
  loading.value = true;
  controller = new AbortController();
  const timeout = setTimeout(() => controller?.abort(), 30000);
  try {
    const response = await fetch(`${stateServerBase()}/api/subscription-limits`, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    if (!Array.isArray(result.providers) || !Number.isFinite(result.updatedAt)) throw new Error('Invalid response');
    if (!disposed) { data.value = result; error.value = ''; now.value = Date.now(); }
  } catch {
    if (!disposed) error.value = 'Subscription limits are unavailable. Try again shortly.';
  } finally { clearTimeout(timeout); if (!disposed) loading.value = false; }
}
function stamp(at: number) { return new Date(at).toLocaleString(); }
function remaining(w: Window) { return Math.round((100 - w.usedPercent) * 10) / 10; }
onMounted(() => {
  void refresh();
  timer = setInterval(() => { now.value = Date.now(); void refresh(); }, 60000);
});
onUnmounted(() => { disposed = true; clearInterval(timer); controller?.abort(); });
</script>

<template>
  <section class="subscription-limits" :class="{ compact }" :aria-labelledby="titleId" data-testid="subscription-limits">
    <div class="limits-heading">
      <div><h3 :id="titleId">Subscription limits</h3><p v-if="!compact">Account limits across all apps and sessions. Updates every minute.</p></div>
      <UiButton :size="compact ? 'xs' : 'sm'" :disabled="loading" :aria-busy="loading" @click="refresh">{{ loading ? 'Refreshing…' : compact ? 'Refresh' : 'Refresh limits' }}</UiButton>
    </div>
    <p v-if="loading && !data" role="status" class="ui-note">Loading subscription limits…</p>
    <p v-if="error" role="alert" class="limits-error">{{ error }}{{ data ? ' Previous values are shown below.' : '' }}</p>
    <div v-if="data" class="provider-grid">
      <article v-for="provider in providers" :key="provider.id" class="provider" :data-testid="`limits-${provider.id}`">
        <h4>{{ provider.name }}</h4>
        <p v-if="provider.message" class="ui-note">{{ provider.message }}</p>
        <div v-for="window in provider.windows" :key="window.id" class="limit-window">
          <div class="window-label"><span>{{ window.label }}</span><strong>{{ window.resetsAt && window.resetsAt <= now ? 'Awaiting update' : `${remaining(window)}% left` }}</strong></div>
          <progress :value="window.usedPercent" max="100" :aria-label="`${provider.name} ${window.label} used`" :class="{ warning: window.usedPercent >= 80 }"></progress>
          <p v-if="window.resetsAt">{{ window.resetsAt <= now ? 'Reported reset' : 'Resets' }} {{ stamp(window.resetsAt) }}</p>
          <p v-else>Reset time unavailable</p>
        </div>
        <p v-if="provider.status === 'ready' && !compact" class="ui-note">Only windows reported by the provider are shown.</p>
      </article>
    </div>
    <p v-if="data && !providers.length" class="ui-note">No subscription limits reported for this agent.</p>
    <p v-if="data" class="updated ui-note">Updated {{ stamp(data.updatedAt) }}{{ error || now - data.updatedAt > 120000 ? ' · May be out of date' : '' }}</p>
  </section>
</template>

<style scoped>
.subscription-limits { margin-bottom: 1.5rem; padding: 1.25rem; border: 1px solid var(--border-color); border-radius: var(--radius-lg); background: var(--bg-assistant); }
.limits-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; margin-bottom: 1rem; }
h3, h4, p { margin: 0; }
h3 { font-size: .95rem; color: var(--text-primary); }
h4 { font-size: .85rem; margin-bottom: .75rem; color: var(--text-primary); }
.limits-heading p, .limit-window p { font-size: .75rem; color: var(--text-secondary); margin-top: .375rem; line-height: 1.5; }
.provider-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1rem; }
.provider { min-width: 0; padding: 1rem; background: var(--bg-main); border-radius: var(--radius-md); border: 1px solid var(--border-color); overflow-wrap: anywhere; }
.limit-window { margin-bottom: .75rem; }
.window-label { display: flex; flex-wrap: wrap; justify-content: space-between; gap: .5rem; font-size: .8rem; color: var(--text-primary); }
progress { display: block; width: 100%; height: .5rem; margin-top: .5rem; appearance: none; border: none; border-radius: var(--radius-md); overflow: hidden; background: var(--border-color); }
progress::-webkit-progress-bar { background: var(--border-color); }
progress::-webkit-progress-value { background: var(--bg-success); }
progress::-moz-progress-bar { background: var(--bg-success); }
progress.warning::-webkit-progress-value { background: var(--bg-danger); }
progress.warning::-moz-progress-bar { background: var(--bg-danger); }
.limits-error { color: var(--bg-danger); font-size: .8rem; margin-bottom: 1rem; }
.updated { margin-top: .75rem; }
.subscription-limits.compact { margin: 0; padding: 0; border: 0; }
.compact .limits-heading { align-items: center; margin-bottom: .75rem; }
.compact h3 { font-size: .8rem; font-weight: 500; }
.compact .provider-grid { grid-template-columns: 1fr; gap: .75rem; }
.compact .provider { padding: 0; border: 0; background: transparent; }
.compact h4 { font-size: .75rem; margin-bottom: .5rem; }
@media (max-width: 800px) { .provider-grid { grid-template-columns: 1fr; } }
@media (max-width: 480px) { .subscription-limits { padding: 1rem; } .limits-heading { flex-direction: column; } .compact .limits-heading { flex-direction: row; } }
</style>
