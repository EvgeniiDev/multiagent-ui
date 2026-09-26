<script setup lang="ts">
import type { AuthMethod } from '@agentclientprotocol/sdk';

defineProps<{
  authMethods: AuthMethod[];
  agentName: string;
}>();

const emit = defineEmits<{
  (e: 'select', methodId: string): void;
  (e: 'cancel'): void;
  /** Start over instead: abandon this connect and open the New session
   *  dialog, so a wrong agent/cwd isn't a dead end. */
  (e: 'newSession'): void;
}>();

function handleSelect(methodId: string) {
  emit('select', methodId);
}
</script>

<template>
  <div class="auth-overlay" @click.self="emit('cancel')">
    <div class="auth-dialog">
      <div class="dialog-header">
        <h3>Authentication Required</h3>
        <button class="close-btn" aria-label="Close" @click="emit('cancel')"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      </div>
      
      <div class="dialog-content">
        <p class="description">
          <strong>{{ agentName }}</strong> requires authentication to continue.
          Select an authentication method:
        </p>
        
        <div class="auth-methods">
          <button
            v-for="method in authMethods"
            :key="method.id"
            class="auth-method-btn"
            @click="handleSelect(method.id)"
          >
            <div class="method-info">
              <span class="method-name">{{ method.name }}</span>
              <span v-if="method.description" class="method-desc">
                {{ method.description }}
              </span>
            </div>
            <span class="arrow">→</span>
          </button>
        </div>

        <p class="auth-escape">
          Wrong agent or folder? Start over with a new session.
        </p>
      </div>

      <div class="dialog-footer">
        <button class="new-session-btn" @click="emit('newSession')">
          New session
        </button>
        <button class="cancel-btn" @click="emit('cancel')">
          Cancel
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.auth-overlay {
  position: fixed;
  inset: 0;
  background: rgba(43, 39, 35, 0.28);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  z-index: 1000;
}

.auth-dialog {
  background: var(--bg-main, #fbf8f3);
  border: 1px solid rgba(43, 39, 35, 0.16);
  border-radius: var(--radius-lg, 10px);
  width: 100%;
  max-width: 420px;
}

.dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 0.875rem;
  border-bottom: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
}

.dialog-header h3 {
  margin: 0;
  font-size: 0.9375rem;
  font-weight: 600;
}

.close-btn {
  border: none;
  background: transparent;
  font-size: 1.25rem;
  cursor: pointer;
  color: var(--text-secondary);
  padding: 0.25rem;
}

.close-btn:hover {
  color: var(--text-primary);
}

.dialog-content {
  padding: 1.25rem;
}

.description {
  margin: 0 0 1rem 0;
  color: var(--text-secondary);
  font-size: 0.9rem;
}

.auth-methods {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

/* Escape hatch hint: the auth prompt is a dead end unless you know a fresh
 * session is one click away. */
.auth-escape {
  margin: 0.875rem 0 0;
  color: var(--text-muted);
  font-size: 0.8rem;
}

.auth-method-btn {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.875rem 1rem;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-sidebar);
  cursor: pointer;
  text-align: left;
  transition: all 0.15s ease;
}

.auth-method-btn:hover {
  border-color: var(--bg-primary);
  background: var(--bg-hover);
}

.method-info {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.method-name {
  font-weight: 500;
  color: var(--text-primary);
}

.method-desc {
  font-size: 0.8rem;
  color: var(--text-muted);
}

.arrow {
  font-size: 1.25rem;
  color: var(--text-muted);
}

.auth-method-btn:hover .arrow {
  color: var(--bg-primary);
}

.dialog-footer {
  padding: 0.75rem 1.25rem;
  border-top: 1px solid var(--border-color);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

/* Accent CTA, same language as the welcome screen's .welcome-new-session —
 * the button reads as the primary way out of this prompt. */
.new-session-btn {
  padding: 0.5rem 1rem;
  border: none;
  border-radius: 4px;
  background: var(--bg-primary);
  color: var(--text-on-accent, #fbf8f3);
  cursor: pointer;
  font-family: inherit;
  font-size: 0.9rem;
  font-weight: 600;
}

.new-session-btn:hover {
  background: var(--bg-primary-hover);
}

.cancel-btn {
  padding: 0.5rem 1rem;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 0.9rem;
}

.cancel-btn:hover {
  background: var(--bg-hover);
}
</style>
