// eval.mjs — score a wake-word model over a labelled clip directory and report the two
// numbers that decide whether it can ship: recall, and false fires per minute.
//
// Run: node scripts/eval.mjs <clipDir> [model.onnx] [threshold] [--json]
//   clipDir/pos_*.wav        the wake word is spoken — must fire
//   clipDir/neg_*.wav        it is not — must stay silent
//
// Unlike src/selfcheck.ts this asserts nothing and never stops early: the self-check is a
// gate (first failure aborts), this is the instrument you tune against. It reports every clip, so
// a model that fails one case still tells you how close the other 119 were.
//
// The headline number is false fires per MINUTE, not per clip. A streaming detector re-scores every
// 80 ms, so "2% of windows" is not a small number — it is roughly one false fire every four
// seconds. Per-clip rates flatter a model that per-minute rates expose.
//
// --json: instead of the human report, print { "<clip basename>": <peak score>, ... } to stdout —
// the reference a port (e.g. flutter/) checks its own peak scores against. Additive: omit the
// flag and output is unchanged.
import * as ort from 'onnxruntime-web/wasm';
import { readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';

ort.env.wasm.numThreads = 1;
ort.env.logLevel = 'error';

const STEP = 1280, PAD = 480, MEL_WIN = 76, MEL_BINS = 32, EMB_DIM = 96;
const SR = 16_000;

const load = (f) => ort.InferenceSession.create(new Uint8Array(readFileSync(f)));
const run = async (s, d, dims) =>
  (await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', d, dims) }))[s.outputNames[0]].data;

function wav16(path) {
  const b = readFileSync(path);
  let o = 12;
  while (o < b.length - 8) {
    const id = b.toString('ascii', o, o + 4), size = b.readUInt32LE(o + 4);
    if (id === 'data') {
      const n = size >> 1, f = new Float32Array(n);
      for (let i = 0; i < n; i++) f[i] = b.readInt16LE(o + 8 + i * 2) / 32768;
      return f;
    }
    o += 8 + size + (size & 1);
  }
  throw new Error(`no data chunk in ${path}`);
}

const args = process.argv.slice(2).filter((a) => a !== '--json');
const asJson = process.argv.includes('--json');
const dir = args[0] ?? 'eval/clips';
const modelPath = args[1] ?? 'models/lada.onnx';
const bar = Number(args[2] ?? 0.5);

const [mel, emb, head] = await Promise.all([
  load('models/melspectrogram.onnx'), load('models/embedding_model.onnx'), load(modelPath),
]);
const embWin = head.inputMetadata?.[0]?.shape?.[1] ?? 16;

/** Every step's score for one clip, exactly as src/worker.ts would produce them. 1.5 s of
 *  silence is prepended so the model's own 2 s window is full before the clip starts — a live
 *  stream always has that history, a file does not. */
async function scores(clip) {
  const pad = new Float32Array(Math.round(1.5 * SR));
  const raw = new Float32Array(pad.length * 2 + clip.length);
  raw.set(pad); raw.set(clip, pad.length); raw.set(pad, pad.length + clip.length);
  let m = [], e = [], out = [];
  for (let i = 0; i + STEP + PAD <= raw.length; i += STEP) {
    for (const v of await run(mel, raw.subarray(i, i + STEP + PAD), [1, STEP + PAD])) m.push(v / 10 + 2);
    if (m.length > MEL_WIN * MEL_BINS) m = m.slice(m.length - MEL_WIN * MEL_BINS);
    if (m.length < MEL_WIN * MEL_BINS) continue;
    for (const v of await run(emb, Float32Array.from(m), [1, MEL_WIN, MEL_BINS, 1])) e.push(v);
    if (e.length > embWin * EMB_DIM) e = e.slice(e.length - embWin * EMB_DIM);
    if (e.length < embWin * EMB_DIM) continue;
    out.push((await run(head, Float32Array.from(e), [1, embWin, EMB_DIM]))[0]);
  }
  return out;
}

const files = readdirSync(dir).filter((f) => f.endsWith('.wav')).sort();
const cat = (f) => (f.startsWith('pos_') ? 'pos' : f.replace(/^neg_/, 'neg_').split('_').slice(0, 2).join('_'));
const stats = new Map();
const worst = [];
const peaks = {}; // clip basename -> peak score, for --json (a port's parity reference)

for (const f of files) {
  const s = await scores(wav16(join(dir, f)));
  const name = basename(f, '.wav');
  if (!s.length) { peaks[name] = 0; if (!asJson) console.log(`  ${f}: too short to score`); continue; }
  const max = Math.max(...s);
  peaks[name] = max;
  const over = s.filter((x) => x >= bar).length;
  const k = cat(name);
  const st = stats.get(k) ?? { clips: 0, fired: 0, steps: 0, over: 0, maxes: [] };
  st.clips++; st.steps += s.length; st.over += over; st.maxes.push(max);
  if (over) st.fired++;
  stats.set(k, st);
  const isPos = k === 'pos';
  if ((isPos && !over) || (!isPos && over)) worst.push(`${isPos ? 'MISS ' : 'FIRE '} ${name.padEnd(28)} max=${max.toFixed(3)}`);
}

if (asJson) {
  console.log(JSON.stringify(peaks, null, 2));
  process.exit(0);
}

console.log(`\nmodel ${modelPath}  threshold ${bar}\n`);
for (const [k, st] of [...stats].sort()) {
  const med = st.maxes.sort((a, b) => a - b)[st.maxes.length >> 1];
  const perMin = (st.over / (st.steps * 0.08)) * 60;
  console.log(
    `  ${k.padEnd(10)} ${String(st.clips).padStart(3)} clips  ` +
    (k === 'pos'
      ? `recall ${(st.fired / st.clips * 100).toFixed(1)}%  median peak ${med.toFixed(3)}  min peak ${st.maxes[0].toFixed(3)}`
      : `${st.fired} fired  median peak ${med.toFixed(3)}  max peak ${st.maxes[st.maxes.length - 1].toFixed(3)}  ${perMin.toFixed(1)} false fires/min`),
  );
}
// The one aggregate the manifest's eval field wants — same formula as the per-group lines.
{
  let clips = 0, steps = 0, over = 0;
  for (const [k, st] of stats) if (k !== 'pos') { clips += st.clips; steps += st.steps; over += st.over; }
  if (steps) console.log(`  neg overall ${clips} clips  ${((over / (steps * 0.08)) * 60).toFixed(2)} false fires/min`);
}
if (worst.length) { console.log(`\n  ${worst.length} clip(s) on the wrong side:`); for (const w of worst.slice(0, 20)) console.log(`    ${w}`); }
