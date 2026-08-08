// worker.ts — the wakekit detection worker: streaming openWakeWord on ONNX Runtime Web, off the
// main thread.
//
// Answers ONE question: was the wake word spoken? openWakeWord is three ONNX models chained on
// 16 kHz mono, of which only the last is trained:
//
//   melspectrogram.onnx   raw f32 → 32-bin mel frames @10 ms
//   embedding_model.onnx  76 mel frames → one 96-d vector    (frozen Google speech-embedding)
//   <word>.onnx           N embeddings → P(word spoken)      (the ~0.4 MB part you train)
//
// The first two are shared by every wake word and never change; swapping "ละดา" for "jarvis" is
// replacing the third file. Nothing here names a model — URLs come from the main thread — so a
// different phrase is a file copy plus a manifest entry, no rebuild of this worker.
//
// Protocol: {load, wasmBase, melUrl, embUrl, headUrl, threshold, verbose}
//             → {loaded, window} | {error}
//           {config, threshold?, verbose?}          live retune, no reload
//           {push, f32}  (16 kHz — resample on the main thread, src/index.ts does)
//             → {hit, score} on a threshold crossing | {score, atMs} every step when verbose.
//
// `onnxruntime-web/wasm`, NOT the package default: the default is the jsep (WebGPU/WebNN) build,
// which fetches `ort-wasm-simd-threaded.jsep.wasm` — a file the demo/host doesn't serve, so it
// would 404 at load. The plain-wasm entry asks for `ort-wasm-simd-threaded.{mjs,wasm}`. There is
// no GPU work to lose: this is 3 tiny graphs on 80 ms of audio.
import * as ort from 'onnxruntime-web/wasm';

const post = (m: unknown) => (self as unknown as { postMessage(m: unknown): void }).postMessage(m);

// openWakeWord's fixed feature geometry — properties of the two frozen models, not tunables.
// STEP is the framework's native cadence: 1280 samples in → exactly 8 mel frames → exactly
// 1 embedding out, so the buffers below advance in lockstep with no bookkeeping.
const STEP = 1280;      // 80 ms @ 16 kHz
const PAD = 480;        // melspectrogram.onnx eats 3 hops at its window edge — hand back that much
const MEL_WIN = 76;     // mel frames the embedding model consumes at once
const MEL_BINS = 32;
const EMB_DIM = 96;
/** Re-scoring happens every 80 ms, so one spoken word crosses the bar many times in a row. Long
 *  enough to cover the utterance, short enough that a genuine second call still lands. */
const REFRACTORY_MS = 1_500;

let melS: ort.InferenceSession | null = null;
let embS: ort.InferenceSession | null = null;
let headS: ort.InferenceSession | null = null;
/** Embeddings the trained head expects — `total_length / STEP` at training time (32000 → 16). Read
 *  off the model's own input shape rather than hardcoded, so a head trained with a different window
 *  drops in without a code change. */
let embWin = 16;
let bar = 0.5;
/** Emit every step's score, not just threshold crossings. Bench/demo only — 12.5 msg/s. */
let verbose = false;

let raw = new Float32Array(0); // 16 kHz samples not yet turned into mel frames
let mel: number[] = [];        // flat mel frames, newest last (trimmed to MEL_WIN)
let emb: number[] = [];        // flat embeddings, newest last (trimmed to embWin)
let pumping = false;
let clockMs = 0;               // audio consumed — the worker's own timeline, immune to GC pauses
let lastHitMs = -Infinity;

const run = async (s: ort.InferenceSession, data: Float32Array, dims: number[]) => {
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', data, dims) });
  return out[s.outputNames[0]].data as Float32Array;
};

/**
 * Drain `raw` one STEP at a time. Serialized behind `pumping` because ORT runs are async while
 * chunks keep arriving every ~100 ms: without it two pumps would interleave and corrupt the
 * ring buffers. Falling behind grows `raw` instead of desyncing — see the cap in onmessage.
 */
async function pump() {
  if (pumping || !melS || !embS || !headS) return;
  pumping = true;
  try {
    while (raw.length >= STEP + PAD) {
      const win = raw.subarray(0, STEP + PAD);
      const frames = await run(melS, win, [1, win.length]);
      raw = raw.slice(STEP); // keep PAD samples as the next window's history
      clockMs += (STEP / 16_000) * 1000;

      // openWakeWord's arbitrary melspectrogram rescale (utils.py: `spec = spec/10 + 2`). The
      // embedding model was trained on it — dropping this silently halves accuracy.
      for (const f of frames) mel.push(f / 10 + 2);

      const melNeed = MEL_WIN * MEL_BINS;
      if (mel.length > melNeed) mel = mel.slice(mel.length - melNeed);
      if (mel.length < melNeed) continue; // still filling the first 760 ms

      for (const v of await run(embS, Float32Array.from(mel), [1, MEL_WIN, MEL_BINS, 1])) emb.push(v);

      const embNeed = embWin * EMB_DIM;
      if (emb.length > embNeed) emb = emb.slice(emb.length - embNeed);
      if (emb.length < embNeed) continue;

      const [score] = await run(headS, Float32Array.from(emb), [1, embWin, EMB_DIM]);
      if (verbose) post({ type: 'score', score, atMs: clockMs });
      if (score >= bar && clockMs - lastHitMs > REFRACTORY_MS) {
        lastHitMs = clockMs;
        post({ type: 'hit', score });
      }
    }
  } catch (e) {
    // A run that throws mid-stream would otherwise wedge `pumping` and silently stop detection.
    melS = embS = headS = null;
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  } finally {
    pumping = false;
  }
}

self.onmessage = async ({ data }: MessageEvent) => {
  const msg = data as {
    type: string; wasmBase?: string; melUrl?: string; embUrl?: string; headUrl?: string;
    threshold?: number; verbose?: boolean; f32?: Float32Array;
  };

  if (msg.type === 'load') {
    try {
      // Single-threaded so it runs without cross-origin isolation on any static host.
      ort.env.logLevel = 'error';
      ort.env.wasm.numThreads = 1;
      if (msg.wasmBase) ort.env.wasm.wasmPaths = msg.wasmBase;
      bar = msg.threshold ?? bar;
      verbose = msg.verbose === true;
      // Release before replacing: a re-load (demo model switch, selfcheck) must not leak the
      // old sessions' wasm memory — enough re-loads and InferenceSession.create starts failing.
      for (const s of [melS, embS, headS]) void s?.release();
      melS = embS = headS = null;
      const opts: ort.InferenceSession.SessionOptions = { executionProviders: ['wasm'] };
      [melS, embS, headS] = await Promise.all([
        ort.InferenceSession.create(msg.melUrl ?? '', opts),
        ort.InferenceSession.create(msg.embUrl ?? '', opts),
        ort.InferenceSession.create(msg.headUrl ?? '', opts),
      ]);
      const dim = (headS as unknown as { inputMetadata?: { shape?: (number | string)[] }[] })
        .inputMetadata?.[0]?.shape?.[1];
      if (typeof dim === 'number' && dim > 0) embWin = dim;
      post({ type: 'loaded', window: embWin });
    } catch (e) {
      melS = embS = headS = null;
      post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    }
    return;
  }

  // Live retune from the demo's slider — cheaper than reloading three sessions.
  if (msg.type === 'config') {
    if (typeof msg.threshold === 'number') bar = msg.threshold;
    if (typeof msg.verbose === 'boolean') verbose = msg.verbose;
    return;
  }

  if (msg.type === 'push' && msg.f32 && melS) {
    // Cap the backlog at ~2 s. A throttled background tab can stall ORT long enough for `raw` to
    // grow without bound; dropping the oldest audio costs at most a missed word, whereas an
    // unbounded Float32Array is an OOM.
    const merged = new Float32Array(raw.length + msg.f32.length);
    merged.set(raw);
    merged.set(msg.f32, raw.length);
    raw = merged.length > 32_000 ? merged.slice(merged.length - 32_000) : merged;
    void pump();
  }
};

export {};
