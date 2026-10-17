<script setup lang="ts">
import { onMounted } from 'vue';
import UiButton from './ui/UiButton.vue';
import { isTauriHost } from '../lib/platform';
import { pushToken, setPushToken, pushSettings, pwaInstalled as installed, pwaInstallPrompt as installPrompt, registerPwa, pushRequest } from '../lib/pwa';

const web = !isTauriHost();
const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const supported = window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const { enabled, busy, loading, reloadNeeded, error, status } = pushSettings;
onMounted(async () => {
  if (busy.value) return;
  busy.value = true; loading.value = true; error.value = '';
  try {
    if (!web || !supported) return;
    const registration = await registerPwa();
    const subscription = await registration?.pushManager.getSubscription();
    if (subscription && Notification.permission === 'granted' && pushToken()) {
      // Refresh server registration after reinstall/recovery, keeping this device's token.
      const saved = await pushRequest('subscription', 'POST', { subscription: subscription.toJSON() });
      setPushToken(saved.token);
      enabled.value = true;
    }
  } catch (e) { error.value = e instanceof Error ? e.message : String(e); }
  finally { loading.value = false; busy.value = false; }
});
async function install() {
  const prompt = installPrompt.value;
  if (!prompt) return;
  try { await prompt.prompt(); await prompt.userChoice; }
  finally { installPrompt.value = null; }
}
async function enable() {
  if (busy.value) return;
  busy.value = true; error.value = ''; status.value = '';
  try {
    // Permission is requested immediately in the click gesture, before network awaits.
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('Notifications are blocked. Allow them in your browser or device settings, then try again.');
    const config = await pushRequest('config');
    const registration = await registerPwa();
    if (!registration) throw new Error('Install requires a secure HTTPS connection.');
    await navigator.serviceWorker.ready;
    const key = Uint8Array.from(atob(config.publicKey.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const subscription = await registration.pushManager.getSubscription() || await registration.pushManager.subscribe({
      userVisibleOnly: true, applicationServerKey: key,
    });
    const saved = await pushRequest('subscription', 'POST', { subscription: subscription.toJSON() });
    setPushToken(saved.token); enabled.value = true; reloadNeeded.value = true;
    status.value = 'Enabled on this device. Reload to apply to open chats, then send your next message.';
  } catch (e) { error.value = e instanceof Error ? e.message : String(e); }
  finally { busy.value = false; }
}
async function disable() {
  if (busy.value) return;
  busy.value = true; error.value = ''; status.value = '';
  try {
    await pushRequest('subscription', 'DELETE');
    setPushToken(''); enabled.value = false; reloadNeeded.value = false;
    const registration = await navigator.serviceWorker.getRegistration();
    await (await registration?.pushManager.getSubscription())?.unsubscribe();
    status.value = 'Notifications disabled on this device.';
  } catch (e) { error.value = e instanceof Error ? e.message : String(e); }
  finally { busy.value = false; }
}
async function testPush() {
  if (busy.value) return;
  busy.value = true; error.value = ''; status.value = '';
  try { await pushRequest('test', 'POST', {}); status.value = 'Test notification sent. Check your device notifications.'; }
  catch (e) { error.value = e instanceof Error ? e.message : String(e); }
  finally { busy.value = false; }
}
function reload() { window.location.reload(); }
</script>

<template>
  <section v-if="web" class="pwa-settings ui-surface" aria-labelledby="pwa-title">
    <h3 id="pwa-title">App &amp; notifications</h3>
    <p v-if="installed" class="ui-note">ACP UI is running as an app, without the browser address bar.</p>
    <template v-else>
      <p class="ui-note">Open ACP UI as a separate app, without the browser address bar.</p>
      <UiButton v-if="installPrompt" @click="install">Install ACP UI</UiButton>
      <p v-else-if="ios" class="ui-note">On iPhone or iPad: open Share → Add to Home Screen → Open as Web App (if shown), then open ACP UI from its icon.</p>
      <p v-else class="ui-note">In your browser menu, choose Install app or Add to Home Screen.</p>
    </template>
    <p class="ui-note">Get a notification when a chat agent finishes responding, even after you close the app. Enable separately on each device.</p>
    <p v-if="ios && !installed" class="ui-note">On iPhone and iPad, install and open the app first to enable notifications.</p>
    <p v-else-if="!supported" class="ui-note">Push notifications require HTTPS and a supported browser. If you see a certificate warning, trust the site's certificate first.</p>
    <div v-else class="pwa-actions">
      <UiButton v-if="!enabled" variant="primary" :disabled="busy || loading" :aria-busy="busy" @click="enable">{{ loading ? 'Checking…' : busy ? 'Enabling…' : 'Enable notifications' }}</UiButton>
      <template v-else>
        <UiButton :disabled="busy || loading" @click="testPush">Send test notification</UiButton>
        <UiButton :disabled="busy || loading" @click="disable">Disable notifications</UiButton>
      </template>
      <UiButton v-if="reloadNeeded" :disabled="busy" @click="reload">Reload app</UiButton>
    </div>
    <p v-if="status" class="ui-note" role="status">{{ status }}</p>
    <p v-if="error" class="pwa-error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.pwa-settings { display: grid; gap: 0.75rem; margin-bottom: 1.5rem; }
.pwa-settings h3, .pwa-settings p { margin: 0; }
.pwa-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.pwa-error { color: var(--bg-danger); overflow-wrap: anywhere; font-size: 0.875rem; }
@media (max-width: 600px) {
  .pwa-actions { flex-direction: column; align-items: stretch; }
}
</style>
