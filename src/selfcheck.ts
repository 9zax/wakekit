// selfcheck.ts — runnable self-check for src/worker.ts against the REAL ONNX models in models/.
//
// Run (repo root):  npm run selfcheck        (optionally: ... eval/clips as argv[2])
//
// Testing the worker's arithmetic in isolation would prove nothing: what can break is the COUPLING
// to the frozen models — the /10+2 melspectrogram rescale, the 76-frame embedding window, the
// 16-embedding head window. Get any of them wrong and every score collapses to ~0.001, which looks
// exactly like "the wake word simply wasn't said". So this drives the real worker over real audio.
//
// Two tiers, because clips are generated (gitignored) and a fresh clone has none:
//   always      — every manifest head loads, and 3 s of silence produces no error and no hit.
//   with clips  — filename is the expectation: pos_*.wav must fire, neg_*.wav must not, for EVERY
//                 head at its OWN manifest threshold. Build clips with scripts/corpus-lada.sh
//                 (the holdout/ set) — see docs/training.md.

import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

type Head = { id: string; file: string; threshold: number; label: string; pending?: boolean };
const ALL: Head[] = JSON.parse(readFileSync('models/manifest.json', 'utf8'));
assert.ok(ALL.length, 'manifest.json is empty');
assert.ok(ALL.every((m) => m.threshold > 0 && m.threshold <= 1), 'every bar is a probability');
// pending = announced in the picker but not trained yet — there is no .onnx to check.
const MODELS = ALL.filter((m) => !m.pending);
assert.ok(MODELS.length, 'manifest.json has no trained heads');

// ---- Browser surface the worker expects, backed by the local filesystem ----
// The worker is written for a Worker global scope and fetches its models by URL. Both are stubbed
// rather than parameterised, so the module under test is byte-identical to the one vite ships.
let onmessage: ((e: { data: unknown }) => void) | null = null;
const posted: { type: string; score?: number; window?: number; message?: string }[] = [];

Object.defineProperty(globalThis, 'self', {
  configurable: true,
  value: {
    postMessage: (m: unknown) => { posted.push(m as { type: string }); },
    set onmessage(fn: ((e: { data: unknown }) => void) | null) { onmessage = fn; },
    get onmessage() { return onmessage; },
  },
});

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith('model:')) {
    const bytes = readFileSync(join('models', url.slice(6)));
    return Promise.resolve(new Response(new Uint8Array(bytes)));
  }
  return realFetch(input as RequestInfo, init);
}) as typeof fetch;

// Imported DYNAMICALLY, and only here: the worker assigns self.onmessage at module scope, so a
// static import would hoist above the stub above and the handler would be lost.
await import('./worker');

const send = (msg: unknown) => onmessage?.({ data: msg });
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 16-bit PCM mono WAV → Float32Array. Chunk-walking rather than a fixed 44-byte header offset:
 *  ffmpeg emits a LIST chunk before `data`, so the naive offset reads noise. */
function wav16(path: string): Float32Array {
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

/**
 * Stream one buffer through the worker exactly as listenMic → push does, and return the hits.
 * Clips are padded with 1.5 s of silence at both ends: the head needs 16 embeddings (1.28 s) on
 * top of the embedding model's own 760 ms window before it can score at all, so a bare 0.8 s clip
 * produces ZERO scores — indistinguishable from a confident no. A live stream always has that
 * lead-in; a file does not.
 */
let loadedHead: string | null = null;
async function feed(clip: Float32Array, head: Head) {
  posted.length = 0;
  if (loadedHead !== head.file) {
    send({
      type: 'load',
      melUrl: 'model:melspectrogram.onnx',
      embUrl: 'model:embedding_model.onnx',
      headUrl: `model:${head.file}`,
      threshold: head.threshold, // the model's OWN bar — models/manifest.json
    });
    for (let i = 0; i < 200 && !posted.some((m) => m.type === 'loaded'); i++) await settle(25);
    const loaded = posted.find((m) => m.type === 'loaded');
    assert.ok(loaded, `worker never loaded ${head.file}: ${JSON.stringify(posted)}`);
    loadedHead = head.file;
    posted.length = 0;
  }

  const pad = new Float32Array(24_000);
  const audio = new Float32Array(pad.length * 2 + clip.length);
  audio.set(pad); audio.set(clip, pad.length); audio.set(pad, pad.length + clip.length);

  // 1280-sample pushes = the worker's own step, and an await between them so its async ORT runs
  // drain instead of piling into the 2 s backlog cap.
  for (let i = 0; i < audio.length; i += 1280) {
    send({ type: 'push', f32: audio.slice(i, i + 1280) });
    await settle(0);
  }
  await settle(300);
  assert.ok(!posted.some((m) => m.type === 'error'), `worker errored: ${posted.find((m) => m.type === 'error')?.message}`);
  return posted.filter((m) => m.type === 'hit');
}

// ---- Tier 1: chain wiring — every head loads and silence stays silent ----
for (const head of MODELS) {
  const hits = await feed(new Float32Array(0), head); // feed() pads → 3 s of silence
  assert.equal(hits.length, 0, `${head.file}: fired on silence`);
  console.log(`  ${head.file} @ ${head.threshold}: loads, silent on silence`);
}

// ---- Tier 2: labelled clips, when they exist ----
// Per-head suites: eval/clips/<id>/ holds THAT head's held-out clips — its own pos_ plus, as
// neg_, its rhyme traps and the OTHER wake words' positives (a multi-model deploy must not fire
// on a sibling's name). Falls back to a flat eval/clips/ shared by every head (the v0.1 layout).
const root = process.argv[2] ?? 'eval/clips';
const clipsFor = (h: Head): { dir: string; clips: string[] } => {
  for (const dir of [join(root, h.id), root]) {
    try {
      const clips = readdirSync(dir).filter((f) => f.endsWith('.wav')).sort();
      if (clips.length) return { dir, clips };
    } catch { /* try next */ }
  }
  return { dir: root, clips: [] };
};

let checked = 0;
let covered = 0;
for (const head of MODELS) {
  const { dir, clips } = clipsFor(head);
  if (!clips.length) {
    console.log(`\n  ${head.file}: no clips under ${root}/${head.id} — SKIPPED`);
    continue;
  }
  covered++;
  console.log(`\n  ${head.file} @ ${head.threshold}  (${dir}, ${clips.length} clips)`);
  for (const f of clips) {
    const name = basename(f, '.wav');
    const hits = await feed(wav16(join(dir, f)), head);
    const best = hits.length ? Math.max(...hits.map((h) => h.score ?? 0)) : 0;
    console.log(`    ${name.padEnd(20)} ${hits.length ? `HIT ${best.toFixed(3)}` : '—'}`);
    if (name.startsWith('pos_')) {
      assert.ok(hits.length, `${head.file} ${name}: the wake word was spoken and did not fire`);
      checked++;
    } else if (name.startsWith('neg_')) {
      assert.equal(hits.length, 0, `${head.file} ${name}: false positive at ${best.toFixed(3)}`);
      checked++;
    }
  }
}
if (!covered) {
  console.log(`\nno .wav clips under ${root} — clip assertions SKIPPED.`);
  console.log('build them with scripts/corpus-name.sh (the holdout/ set); see docs/training.md.');
  console.log('selfcheck: chain-wiring assertions passed');
} else {
  assert.ok(checked >= 4, `only ${checked} clips carried a pos_/neg_ expectation`);
  console.log(`selfcheck: all assertions passed (${covered} head(s) with clip suites)`);
}
