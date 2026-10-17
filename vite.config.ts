import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// Read the package version once at config-evaluation time so we can inject
// it into the web build (the Tauri build reads it from `tauri.conf.json`
// instead via `@tauri-apps/api/app#getVersion`).
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf-8")
) as { version: string };

// Keep PDF resources versioned so older open tabs retain their own assets.
const pdfRoot = new URL('./node_modules/pdfjs-dist/', import.meta.url);
const pdfVersion = JSON.parse(readFileSync(new URL('package.json', pdfRoot), 'utf-8')).version as string;
const pdfAssetDir = `pdfjs-${pdfVersion}`;

// https://vite.dev/config/
export default defineConfig(async ({ mode }) => {
  const isWeb = mode === "web";

  return {
    plugins: [vue(), {
      name: 'acp-pdf-resources',
      generateBundle() {
        for (const folder of ['cmaps', 'standard_fonts', 'wasm']) {
          for (const name of readdirSync(new URL(`${folder}/`, pdfRoot))) {
            this.emitFile({ type: 'asset', fileName: `${pdfAssetDir}/${folder}/${name}`, source: readFileSync(new URL(`${folder}/${name}`, pdfRoot)) });
          }
        }
      },
    }, ...(isWeb ? [{
      name: 'acp-pwa-head',
      transformIndexHtml() {
        return [
          { tag: 'link', attrs: { rel: 'manifest', href: '/manifest.webmanifest' }, injectTo: 'head' as const },
          { tag: 'link', attrs: { rel: 'apple-touch-icon', href: '/pwa-180.png' }, injectTo: 'head' as const },
        ];
      },
    }] : [])],

    define: {
      "import.meta.env.VITE_PDF_ASSET_DIR": JSON.stringify(pdfAssetDir),
      // Exposed to the frontend as `import.meta.env.VITE_APP_VERSION`. The
      // host abstraction (`src/lib/host/index.ts`) reads this on the web
      // build and falls back to it when `@tauri-apps/api/app` is unavailable.
      "import.meta.env.VITE_APP_VERSION": JSON.stringify(pkg.version),
    },

    // Web builds emit to `dist-web/` so the Tauri build pipeline (which
    // expects `frontendDist: ../dist`) is unaffected.
    build: isWeb
      ? {
          outDir: "dist-web",
          emptyOutDir: true,
        }
      : undefined,

    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    //
    // 1. prevent Vite from obscuring rust errors
    clearScreen: false,
    // 2. tauri expects a fixed port, fail if that port is not available
    server: isWeb
      ? {
          // Browser dev server: use Vite defaults so it works behind common
          // proxies / Dev Tunnels without the strict-port behaviour Tauri
          // requires.
          port: 5173,
        }
      : {
          port: 1420,
          strictPort: true,
          host: host || false,
          hmr: host
            ? {
                protocol: "ws",
                host,
                port: 1421,
              }
            : undefined,
          watch: {
            // 3. tell Vite to ignore watching `src-tauri`
            ignored: ["**/src-tauri/**"],
          },
        },
  };
});
