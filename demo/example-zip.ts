// demo/example-zip.ts — "Download example" builds a runnable example in the browser: one
// index.html + models/ + the prebuilt wakekit bundles this page is already serving. No npm, no
// vite, no repo checkout — unzip, serve the folder with any static server, open it. Built
// client-side so it always matches exactly what the visitor just tested — no second copy of the
// models to keep in sync. The zip container is hand-rolled (~40 lines, STORE→deflate via the
// native CompressionStream) instead of pulling in a zip dependency.
import type { WakeModel } from '../src/index';

// ---- the files inside the zip ----
const DIR = 'wakekit-example/';

const HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>wakekit example</title>
</head>
<body>
  <h1>wakekit example 🌼</h1>
  <label>Wake word <select id="model"></select></label>
  <button id="start">&#9654; Start listening</button>
  <div id="status">idle</div>
  <p><small>Serve this folder (any static server) — file:// won't load the worker.<br />
    e.g. <code>python3 -m http.server</code> → open http://localhost:8000</small></p>
  <script type="module">
    import { WakeKit, listenMic, loadManifest } from './wakekit.js';

    const sel = document.getElementById('model');
    const btn = document.getElementById('start');
    const status = document.getElementById('status');
    const models = await loadManifest('./models/');   // every model in this zip
    for (const m of models) sel.add(new Option(\`\${m.label} — \${m.lang}\`, m.id));
    let kit = null, stop = null;

    btn.onclick = async () => {
      if (kit) { stop(); kit.dispose(); kit = null; btn.textContent = '▶ Start listening'; status.textContent = 'stopped'; return; }
      status.textContent = 'loading models…';
      const model = models.find((m) => m.id === sel.value) ?? models[0];
      kit = await WakeKit.load({
        model,
        base: './models/',            // where the .onnx files + ort wasm live
        onHit: (score) => {
          status.textContent = \`wake word! score \${score.toFixed(3)}\`;
          // answer with the browser's own voice — no TTS server needed
          const u = new SpeechSynthesisUtterance('ค่ะ ว่ามาได้เลยค่ะ');
          u.lang = 'th-TH';
          speechSynthesis.speak(u);
        },
      });
      stop = await listenMic(kit);   // mic → detector, all local
      btn.textContent = '■ Stop';
      status.textContent = \`listening — say "\${model.label}"\`;
    };
  </script>
</body>
</html>
`;

const README = `# wakekit example

No install. Serve the folder with any static server and open it:

\`\`\`sh
python3 -m http.server     # → http://localhost:8000
\`\`\`

index.html is the whole app; models/ holds the wake-word models and the
onnxruntime-web wasm; wakekit.js + wakekit-worker.js are the prebuilt library.
On detection it answers out loud via the Web Speech API (no TTS server).

Train your own wake word for any language: https://github.com/9zax/wakekit
`;

// ---- minimal zip writer — deflate entries, no zip64 (fine: every file < 4 GB, < 65k entries) ----
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const deflate = async (data: Uint8Array<ArrayBuffer>) => new Uint8Array(await new Response(
  new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw')),
).arrayBuffer());

const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // zips need *a* stamp; a fixed one will do

async function buildZip(files: { name: string; data: Uint8Array<ArrayBuffer> }[]): Promise<Blob> {
  const enc = new TextEncoder();
  const parts: BlobPart[] = [];
  const central: BlobPart[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const comp = await deflate(f.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);            // version needed
    local.setUint16(8, 8, true);             // method: deflate
    local.setUint16(12, DOS_DATE, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, comp.length, true);
    local.setUint32(22, f.data.length, true);
    local.setUint16(26, name.length, true);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);               // version made by
    cd.setUint16(6, 20, true);               // version needed
    cd.setUint16(10, 8, true);               // method: deflate
    cd.setUint16(14, DOS_DATE, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, comp.length, true);
    cd.setUint32(24, f.data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);          // where this entry's local header starts
    parts.push(local, name, comp);
    central.push(cd, name);
    offset += 30 + name.length + comp.length;
  }
  const cdSize = central.reduce((n, p) => n + (p instanceof DataView ? p.byteLength : (p as Uint8Array).length), 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, files.length, true);
  eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);          // central directory starts after the last entry
  return new Blob([...parts, ...central, eocd], { type: 'application/zip' });
}

// ---- assemble & save ----
async function fetchBin(path: string): Promise<Uint8Array<ArrayBuffer>> {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

export async function downloadExample(models: WakeModel[]): Promise<void> {
  const enc = new TextEncoder();
  const modelAssets = ['manifest.json', 'melspectrogram.onnx', 'embedding_model.onnx',
    ...models.map((m) => m.file), 'ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs'];
  const lib = ['wakekit.js', 'wakekit-worker.js'];
  const [fetchedModels, fetchedLib] = await Promise.all([
    Promise.all(modelAssets.map((a) => fetchBin(`/${a}`))),
    Promise.all(lib.map((a) => fetchBin(`/${a}`))),
  ]);
  const blob = await buildZip([
    { name: `${DIR}index.html`, data: enc.encode(HTML) },
    { name: `${DIR}README.md`, data: enc.encode(README) },
    ...lib.map((a, i) => ({ name: `${DIR}${a}`, data: fetchedLib[i] })),
    ...modelAssets.map((a, i) => ({ name: `${DIR}models/${a}`, data: fetchedModels[i] })),
  ]);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'wakekit-example.zip';
  a.click();
  URL.revokeObjectURL(a.href);
}
