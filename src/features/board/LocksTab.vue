<script setup lang="ts">
import { computed } from 'vue';
import { useActivityStore } from '../../stores/activity';
import { fmtStamp } from './format';

const activity = useActivityStore();

// Every `lock` event the ledger recorded, newest first. Locks are written by
// the session store when an agent refuses `session/load` because another
// process holds the session (the detail text carries the holder PID when the
// agent reports one).
const locks = computed(() =>
  activity.entries.filter((e) => e.kind === 'lock').slice().reverse()
);

function pidOf(detail?: string): string | null {
  if (!detail) return null;
  const m = detail.match(/pid[:=\s#]*(\d+)/i);
  return m ? m[1] : null;
}
</script>

<template>
  <div class="locks-tab">
    <p class="locks-hint">
      A locked session is held by another process. It can be opened here once
      that process exits.
    </p>

    <div v-if="locks.length === 0" class="tab-empty" aria-live="polite">
      No locks observed — no session is currently held by another process.
    </div>

    <ul v-else class="lock-list">
      <li v-for="lock in locks" :key="lock.id" class="lock-row">
        <span class="mono stamp">{{ fmtStamp(lock.at) }}</span>
        <span class="agent mono">{{ lock.agentName }}</span>
        <span class="sess" :title="lock.sessionId">{{ lock.title || lock.sessionId }}</span>
        <span class="cwd mono" :title="lock.cwd">{{ lock.cwd || '—' }}</span>
        <span v-if="pidOf(lock.detail)" class="pid mono">pid {{ pidOf(lock.detail) }}</span>
        <span class="detail" :title="lock.detail">{{ lock.detail }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.locks-tab {
  height: 100%;
  overflow-y: auto;
}

.locks-hint {
  margin: 0;
  padding: 0.5rem 0.75rem;
  font-size: 0.75rem;
  color: var(--text-secondary, #6b6259);
  border-bottom: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
}

.tab-empty {
  padding: 2rem;
  font-size: 0.8125rem;
  color: var(--text-muted, #a39a8e);
  text-align: center;
}

.lock-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.lock-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 28px;
  padding: 0 0.75rem;
  border-bottom: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  font-size: 0.75rem;
}

.mono {
  font-family: var(--font-mono, monospace);
}

.stamp {
  flex: 0 0 auto;
  font-size: 0.625rem;
  color: var(--text-muted, #a39a8e);
}

.agent {
  flex: 0 0 auto;
  font-size: 0.6875rem;
  color: var(--text-secondary, #6b6259);
}

.sess {
  flex: 0 1 auto;
  font-weight: 500;
  color: var(--text-primary, #2b2723);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 22%;
}

.cwd {
  flex: 0 1 auto;
  font-size: 0.625rem;
  color: var(--text-muted, #a39a8e);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 20%;
}

.pid {
  flex: 0 0 auto;
  font-size: 0.625rem;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--bg-danger, #b3402e);
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
  border-radius: var(--radius-sm, 4px);
  padding: 0.0625rem 0.3rem;
}

.detail {
  flex: 1;
  min-width: 0;
  font-size: 0.6875rem;
  color: var(--text-secondary, #6b6259);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

@media (max-width: 767px) {
  .lock-row {
    flex-wrap: wrap;
    padding: 0.375rem 0.75rem;
    min-height: 44px;
    row-gap: 0.125rem;
  }

  .detail {
    flex-basis: 100%;
  }
}
</style>
