import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { registerPwa } from './lib/pwa';

if (import.meta.env.MODE === 'web') {
  registerPwa()?.catch(error => console.warn('PWA registration failed:', error));
}

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);
app.mount("#app");
