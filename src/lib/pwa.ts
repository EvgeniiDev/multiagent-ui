import { isTauriHost } from './platform';
import { stateServerBase } from './host/storage';
import { ref, shallowRef } from 'vue';

export interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: string }>;
}
export const pwaInstalled = ref(standalone());
export const pwaInstallPrompt = shallowRef<InstallPrompt | null>(null);
// Settings can close while a browser permission or network request is pending.
// Keep device state and the operation lock alive across component mounts.
export const pushSettings = {
  enabled: ref(false), busy: ref(false), loading: ref(true), reloadNeeded: ref(false),
  error: ref(''), status: ref(''),
};
let installEventsBound = false;

const TOKEN_KEY = 'acp-ui:push-device';
export function pushToken(): string {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}
export function setPushToken(token: string): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}
export function standalone(): boolean {
  if (typeof matchMedia === 'undefined' || typeof navigator === 'undefined') return false;
  return matchMedia('(display-mode: standalone)').matches ||
    Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
}
export function registerPwa(): Promise<ServiceWorkerRegistration> | null {
  if (isTauriHost() || !window.isSecureContext || !('serviceWorker' in navigator)) return null;
  if (!installEventsBound) {
    installEventsBound = true;
    window.addEventListener('beforeinstallprompt', event => {
      event.preventDefault();
      pwaInstallPrompt.value = event as InstallPrompt;
    });
    window.addEventListener('appinstalled', () => {
      pwaInstalled.value = true;
      pwaInstallPrompt.value = null;
    });
  }
  return navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
}
export async function pushRequest(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${stateServerBase()}/api/push/${path}`, {
    method, signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', ...(pushToken() ? { Authorization: `Bearer ${pushToken()}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Notifications unavailable (${response.status})`);
  return result;
}

/** Only our five local bridges opt in. Remote agents and Tauri keep their transport. */
export function notificationConnection(url: string, protocols: string[]): { url: string; protocols: string[] } {
  const token = pushToken();
  if (!token || isTauriHost()) return { url, protocols };
  const ports: Record<string, string> = { '25901': 'Hermes Agent', '25902': 'OpenCode', '25903': 'Devin', '25904': 'Pi', '25907': 'Codex' };
  try {
    const original = new URL(url);
    const agent = ports[original.port] || ports[String(Number(original.port) - 10)];
    if (original.hostname !== location.hostname || !agent ||
      original.pathname !== '/' || original.search || original.username || original.password) return { url, protocols };
    const relay = new URL(`${stateServerBase()}/api/push/bridge`);
    relay.protocol = relay.protocol === 'https:' ? 'wss:' : 'ws:';
    relay.searchParams.set('agent', agent);
    return { url: relay.href, protocols: [...protocols, `acp-push.${token}`] };
  } catch { return { url, protocols }; }
}
