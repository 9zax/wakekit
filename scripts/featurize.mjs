// featurize.mjs — turn a TTS corpus into openWakeWord training features.
//
// Run: node scripts/featurize.mjs <corpusDir> <outDir>
//   corpusDir/pos/*.16k.wav       the wake word, spoken bare (TTS)
//   corpusDir/hard/*.16k.wav      Thai words that RHYME with it — the decisive negatives
//   corpusDir/neg/*.16k.wav       ordinary meeting speech
//   corpusDir/captures/*.wav      REAL-voice clips cut by the Test Wake Audio bench (optional)
//
// Emits X.bin (float32, n x 1536) + y.bin (uint8, n) for scripts/train.py.
//
// One training example = the 1536 numbers the trained head actually sees: sixteen 96-d embeddings
// covering a 2 s window. Both frozen models run per example, so this is the slow half of training
// (~9 min for ~16k examples) — but it is exactly the runtime path in src/worker.ts, which is
// what makes the resulting weights valid there.
//
// Positives are AUGMENTED, not just featurized: a 0.6 s TTS clip is one sample, and 260 of them
// would overfit to the TTS studio conditions instantly. Each clip is dropped into the 2 s window at
// a random offset, at random gain, over a random slice of real meeting speech as background — so
// the model sees the word at every phase, loudness and noise floor it will meet live.
import * as ort from 'onnxruntime-web/wasm';
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

ort.env.wasm.numThreads = 1;
ort.env.logLevel = 'error';

// Must match src/worker.ts — these are properties of the frozen models, not tunables.
const SR = 16_000;
const WINDOW = 32_000;   // 2 s: the head's input span (total_length)
const MEL_WIN = 76;
const MEL_BINS = 32;
const EMB_DIM = 96;
const EMB_WIN = 16;
const HOP = 8;           // mel frames per embedding step
const FEAT = EMB_WIN * EMB_DIM;

// Deterministic PRNG: a rerun must reproduce the same corpus, or comparing two training runs
// measures the dice instead of the change. (mulberry32)
let seed = 0x9e3779b9;
const rnd = () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const between = (lo, hi) => lo + rnd() * (hi - lo);

const load = (f) => ort.InferenceSession.create(new Uint8Array(readFileSync(f)));
const run = async (s, data, dims) =>
  (await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', data, dims) }))[s.outputNames[0]].data;

/** 16-bit PCM mono WAV → Float32. Walks chunks: ffmpeg emits LIST before data, so a fixed 44-byte
 *  header offset reads noise as audio. */
function wav16(path) {
  const b = readFileSync(path);
  let o = 12;
  while (o < b.length - 8) {
    const id = b.toString('ascii', o, o + 4);
    const size = b.readUInt32LE(o + 4);
    if (id === 'data') {
      const n = size >> 1;
      const f = new Float32Array(n);
      for (let i = 0; i < n; i++) f[i] = b.readInt16LE(o + 8 + i * 2) / 32768;
      return f;
    }
    o += 8 + size + (size & 1);
  }
  throw new Error(`no data chunk in ${path}`);
}

const mel = await load('models/melspectrogram.onnx');
const emb = await load('models/embedding_model.onnx');

/**
 * One 2 s window → its 1536 features.
 *
 * The whole window goes through the melspectrogram in a single call, then all sixteen 76-frame
 * embedding windows go through as ONE batch — 2 inference calls per example instead of 32. The
 * streaming worker cannot do this (it has no future audio); an offline featurizer can, and it is
 * the difference between 40 minutes and 6 hours.
 */
async function features(buf) {
  const frames = await run(mel, buf, [1, buf.length]);
  const need = (EMB_WIN - 1) * HOP + MEL_WIN; // 196 frames
  const got = frames.length / MEL_BINS;
  if (got < need) throw new Error(`window too short: ${got} mel frames, need ${need}`);
  const base = (got - need) * MEL_BINS;      // right-align: score the END of the window, as live
  const batch = new Float32Array(EMB_WIN * MEL_WIN * MEL_BINS);
  for (let i = 0; i < EMB_WIN; i++) {
    const from = base + i * HOP * MEL_BINS;
    batch.set(frames.subarray(from, from + MEL_WIN * MEL_BINS), i * MEL_WIN * MEL_BINS);
  }
  // openWakeWord's fixed melspectrogram rescale (utils.py `spec/10 + 2`).
  for (let i = 0; i < batch.length; i++) batch[i] = batch[i] / 10 + 2;
  return await run(emb, batch, [EMB_WIN, MEL_WIN, MEL_BINS, 1]);
}

const wavs = (d) => { try { return readdirSync(d).filter((f) => f.endsWith('.wav')).map((f) => join(d, f)); } catch { return []; } };

/** Where a capture bench put the detection inside a clip: 2 s of lead-in before the hit. */
const CAPTURE_HIT_S = 2;

const corpus = process.argv[2];
const outDir = process.argv[3];
const posFiles = wavs(join(corpus, 'pos'));
const hardFiles = wavs(join(corpus, 'hard'));
const negFiles = wavs(join(corpus, 'neg'));
const capFiles = wavs(join(corpus, 'captures')).filter((f) => !f.endsWith('README.md'));
if (!posFiles.length) throw new Error(`no positives under ${corpus}/pos`);

// Meeting speech, concatenated once — it is both the negative pool and the background bed that
// positives are mixed over.
const negAudio = negFiles.map(wav16);
const bed = new Float32Array(negAudio.reduce((n, a) => n + a.length, 0));
{ let o = 0; for (const a of negAudio) { bed.set(a, o); o += a.length; } }

/** A 2 s slice of real meeting speech at `gain`, or near-silence when the bed is short. */
function background(gain) {
  const buf = new Float32Array(WINDOW);
  if (bed.length > WINDOW) {
    const at = Math.floor(rnd() * (bed.length - WINDOW));
    for (let i = 0; i < WINDOW; i++) buf[i] = bed[at + i] * gain;
  }
  for (let i = 0; i < WINDOW; i++) buf[i] += (rnd() - 0.5) * 0.002; // dither ≈ a quiet room
  return buf;
}

/**
 * Drop `clip` into a 2 s window so it ENDS shortly before the window does — the phase a streaming
 * detector sees at the instant the word completes. Randomised over the last 0.1-0.7 s so the model
 * cannot key on an exact offset.
 */
function place(clip) {
  const buf = background(between(0, 0.25));
  const end = WINDOW - Math.floor(between(0.1, 0.7) * SR);
  const start = Math.max(0, end - clip.length);
  const gain = between(0.3, 1.0);
  for (let i = start; i < Math.min(end, WINDOW); i++) buf[i] += clip[i - start] * gain;
  return buf;
}

const X = [];
const y = [];
const push = async (buf, label) => { X.push(await features(buf)); y.push(label); };

const POS_AUG = 16;   // 0.6 s of studio TTS is one fact; sixteen placements make it a distribution
const HARD_AUG = 16;  // rhyming words decide the boundary — same placement treatment, equal weight
const SLIDE = 5120;   // 0.32 s = 4 worker steps — dense enough to catch any accidental peak
// Real captures get FEWER variants than TTS positives, on purpose. They carry the one thing the
// synthetic corpus cannot (a real voice, a real mic, a real room), but they are also one speaker in
// one room — augment them to parity with 176 TTS clips and the model learns that person, not the
// word. A few per clip is enough to move the boundary toward real acoustics without handing it over.
const CAP_AUG = 12;

let n = 0;
const tick = (what) => { if (++n % 250 === 0) console.log(`  ${n} examples (${what})`); };

for (const f of posFiles) {
  const clip = wav16(f);
  for (let i = 0; i < POS_AUG; i++) { await push(place(clip), 1); tick('pos'); }
}
for (const f of hardFiles) {
  const clip = wav16(f);
  for (let i = 0; i < HARD_AUG; i++) { await push(place(clip), 0); tick('hard'); }
}
// Real-voice positives. NOT run through place(): the bench cut each clip so the detection sits at
// exactly CAPTURE_HIT_S, which means the 2 s window ending there IS the audio the model scored when
// it fired. Re-placing it would throw away that alignment and invent a worse one. The only
// augmentation is a small timing jitter and a gain trim — the room tone is already real, so mixing
// synthetic background over it would only muddy what these clips are here to contribute.
for (const f of capFiles) {
  const clip = wav16(f);
  for (let i = 0; i < CAP_AUG; i++) {
    const end = Math.round((CAPTURE_HIT_S + between(-0.15, 0.15)) * SR);
    const from = end - WINDOW;
    if (from < 0 || end > clip.length) continue;
    const buf = clip.slice(from, end);
    const gain = between(0.7, 1.15);
    for (let j = 0; j < buf.length; j++) buf[j] *= gain;
    await push(buf, 1);
    tick('capture');
  }
  // ...and the SAME room, mic and speaker as a NEGATIVE. This is not a bonus, it is what makes the
  // captures usable at all: added on the positive side only, real audio is a free shortcut — the
  // model learns "clean TTS = no, real microphone = yes" and starts firing on any real speech.
  // Measured, not theorised: positives-only captures put 5 held-out negatives over the bar that the
  // TTS-only model cleared.
  //
  // The last WINDOW of a capture is the audio AFTER the detection, so it cannot contain the word
  // that fired — the bench cut CAP_AFTER_S of trailing audio precisely there. One safe window per
  // clip, gain-varied to the same count as its positives so neither side carries the room alone.
  if (clip.length >= WINDOW + SR) {
    for (let i = 0; i < CAP_AUG; i++) {
      const buf = clip.slice(clip.length - WINDOW);
      const gain = between(0.7, 1.15);
      for (let j = 0; j < buf.length; j++) buf[j] *= gain;
      await push(buf, 0);
      tick('capture-neg');
    }
  }
}
// Sliding windows over continuous meeting speech: the everyday audio the model must ignore.
for (let at = 0; at + WINDOW <= bed.length; at += SLIDE) {
  await push(bed.slice(at, at + WINDOW), 0);
  tick('neg');
}
// Silence and noise floors — cheap, and they pin down the "nothing is happening" region.
for (let i = 0; i < 100; i++) { await push(background(between(0, 0.05)), 0); tick('quiet'); }

mkdirSync(outDir, { recursive: true });
const flat = new Float32Array(X.length * FEAT);
X.forEach((v, i) => flat.set(v, i * FEAT));
writeFileSync(join(outDir, 'X.bin'), Buffer.from(flat.buffer));
writeFileSync(join(outDir, 'y.bin'), Buffer.from(Uint8Array.from(y)));
console.log(`\n${X.length} examples x ${FEAT} features — ${y.filter((v) => v).length} positive, ${y.filter((v) => !v).length} negative`);
console.log(`sources: ${posFiles.length} tts-pos, ${capFiles.length} real captures, ${hardFiles.length} rhyme, ${negFiles.length} meeting`);
console.log(`wrote ${outDir}/X.bin ${outDir}/y.bin`);
