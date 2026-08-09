import { defineConfig } from 'vite';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { buildSync } from 'esbuild';

// onnxruntime-web fetches its wasm by filename from `wasmPaths` (the demo points it at the origin
// root). Serve the two files from node_modules in dev; copy them next to the bundle on build.
// Single-threaded wasm only — no SharedArrayBuffer / cross-origin-isolation requirement, so the
// demo works on any static host (GitHub Pages included).
const ORT_ASSETS: Record<string, string> = {
  'ort-wasm-simd-threaded.wasm': 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.mjs': 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs',
};

// Prebuilt, dependency-free wakekit bundles for the "Download example" zip: the example needs
// only these two files + models/ + a static server — no npm, no vite, no repo checkout.
let libCache: Record<string, string> | null = null;
function buildLib(): Record<string, string> {
  if (libCache) return libCache;
  const opts = { bundle: true, write: false, format: 'esm', target: 'es2022', minify: true } as const;
  const worker = buildSync({ entryPoints: ['src/worker.ts'], ...opts }).outputFiles[0].text;
  const main = buildSync({ entryPoints: ['src/index.ts'], ...opts }).outputFiles[0].text
    // the source spawns ./worker.ts; the prebuilt pair lives side by side as .js
    .replace('./worker.ts', './wakekit-worker.js');
  return (libCache = { 'wakekit.js': main, 'wakekit-worker.js': worker });
}

export default defineConfig({
  // relative asset URLs so the built page works at any mount point (GitHub Pages /wakekit/ included)
  base: './',
  // models/ doubles as the public dir: manifest.json and every .onnx are served at the origin root,
  // which is exactly the layout a consumer copies to their own static dir.
  publicDir: 'models',
  // thinking-orbs (the wake pill's orb) imports react at top level; the demo only uses its pure
  // canvas painters, so both react entries resolve to a throwing stub instead of the real thing.
  resolve: {
    alias: [
      { find: /^react(\/jsx-runtime)?$/, replacement: new URL('./demo/react-stub.ts', import.meta.url).pathname },
    ],
  },
  // the esbuild pre-bundler doesn't apply the regex alias above — serve thinking-orbs as source
  optimizeDeps: { exclude: ['thinking-orbs'] },
  // overlay.html is the Tauri app's always-on-top "Listening" window; harmless dead file on the website
  build: { target: 'es2022', rollupOptions: { input: { main: 'index.html', overlay: 'overlay.html' } } },
  plugins: [
    {
      name: 'ort-wasm-assets',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const name = req.url?.split('?')[0].replace(/^\//, '') ?? '';
          if (name === 'wakekit.js' || name === 'wakekit-worker.js') {
            res.setHeader('Content-Type', 'text/javascript');
            return res.end(buildLib()[name]);
          }
          const src = ORT_ASSETS[name];
          if (!src) return next();
          res.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
          res.end(readFileSync(src));
        });
      },
      // ORT's glue references its .wasm via `new URL(...)`, so rollup emits a hashed copy nothing
      // ever fetches (every session sets wasmPaths) — drop it instead of shipping the binary twice.
      generateBundle(_opts, bundle) {
        for (const name of Object.keys(bundle)) if (/ort-wasm.*\.wasm$/.test(name)) delete bundle[name];
      },
      closeBundle() {
        for (const [name, src] of Object.entries(ORT_ASSETS)) copyFileSync(src, `dist/${name}`);
        for (const [name, text] of Object.entries(buildLib())) writeFileSync(`dist/${name}`, text);
      },
    },
  ],
});
