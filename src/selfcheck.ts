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

type Head = {
  id: string; file: string; threshold: number; label: string; lang?: string; pending?: boolean;
  kind?: 'wake' | 'confirm';
};
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
const posted: { type: string; score?: number; window?: number; message?: string; confirmRuns?: number }[] = [];

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

// ---- Tier 3: dual-stage gating (FR-3, FR-3b, NFR-8) ----
// spec: 2026-08-23-dual-stage-wake-confirmation. The per-head clip tiers above prove each head is
// individually correct; they say nothing about the ARM/DISARM control flow, which lives in
// worker.ts's control flow, not in any one head. Guarded on a trained ('confirm'-kind, non-pending)
// head existing paired with a trained wake head of the same language — today that means khrapkha
// ships pending, so this whole tier prints SKIPPED until it's trained, matching the "ships dark"
// behaviour the rest of the feature already has.
const confirmHead = MODELS.find((m) => m.kind === 'confirm');
const primaryForConfirm = confirmHead
  && MODELS.find((m) => m.kind !== 'confirm' && m.lang === confirmHead.lang);

if (!confirmHead || !primaryForConfirm) {
  console.log('\nno trained confirm head — dual-stage gating assertions SKIPPED.');
} else {
  console.log(`\ndual-stage gating: ${primaryForConfirm.file} (primary) + ${confirmHead.file} (confirm)`);
  posted.length = 0;
  send({
    type: 'load',
    melUrl: 'model:melspectrogram.onnx',
    embUrl: 'model:embedding_model.onnx',
    headUrl: `model:${primaryForConfirm.file}`,
    threshold: primaryForConfirm.threshold,
    confirmUrl: `model:${confirmHead.file}`,
    confirmThreshold: confirmHead.threshold,
    confirmWindowMs: 2500,
    verbose: true,
  });
  for (let i = 0; i < 200 && !posted.some((m) => m.type === 'loaded'); i++) await settle(25);
  assert.ok(posted.some((m) => m.type === 'loaded'), 'dual-stage load failed');
  loadedHead = null; // force feed() to reload plain single-head state if anything runs after this
  posted.length = 0;

  // Feed one 16kHz clip through the currently-loaded dual-stage worker and return everything it
  // posted. Doesn't reuse feed() — that function reloads a single head by id/threshold, which
  // would tear down the confirm session we just set up. Trailing silence must comfortably exceed
  // confirmWindowMs (2500ms = 40,000 samples), or an arm near the end of the clip never gets a
  // chance to actually expire within the fed audio — 1.5s (feed()'s own pad) is not enough here.
  // Padding is dithered, not exact digital zero: real microphone silence always carries a tiny
  // noise floor, and the confirm head — trained on that, per featurize.mjs's `background()` —
  // scores unpredictably on true zeros, an input it never saw. Exact-zero padding happened to be
  // harmless for every primary head's own silence check (Tier 1) but is not a safe assumption for
  // an armed confirm window this long relative to the padding.
  async function feedDual(clip: Float32Array) {
    posted.length = 0;
    const dither = (n: number) => Float32Array.from({ length: n }, () => (Math.random() - 0.5) * 0.002);
    const lead = dither(24_000); // 1.5s — enough to fill the embedding window
    const trail = dither(64_000); // 4s — comfortably past the 2.5s confirm window
    const audio = new Float32Array(lead.length + clip.length + trail.length);
    audio.set(lead); audio.set(clip, lead.length); audio.set(trail, lead.length + clip.length);
    for (let i = 0; i < audio.length; i += 1280) {
      send({ type: 'push', f32: audio.slice(i, i + 1280) });
      await settle(0);
    }
    await settle(300);
    assert.ok(!posted.some((m) => m.type === 'error'), `worker errored: ${posted.find((m) => m.type === 'error')?.message}`);
    return posted;
  }
  const maxConfirmRuns = (msgs: typeof posted) => {
    const runs = msgs.filter((m) => m.type === 'score').map((m) => m.confirmRuns ?? 0);
    return runs.length ? Math.max(...runs) : 0;
  };

  // FR-3: confirmRuns stays 0 across a clip where the wake word is never spoken — the confirm
  // head's own neg_ clips (dense with ครับ/คะ, no wake word) are exactly that.
  const confirmClips = clipsFor(confirmHead);
  const confirmNeg = confirmClips.clips.filter((f) => f.startsWith('neg_'));
  if (!confirmNeg.length) {
    console.log(`  no neg_ clips under ${confirmClips.dir} — FR-3 zero-inference check SKIPPED.`);
  } else {
    for (const f of confirmNeg) {
      const msgs = await feedDual(wav16(join(confirmClips.dir, f)));
      assert.ok(!msgs.some((m) => m.type === 'armed'), `${f}: armed with no wake word spoken`);
      assert.ok(!msgs.some((m) => m.type === 'hit'), `${f}: hit with no wake word spoken`);
      assert.equal(maxConfirmRuns(msgs), 0, `${f}: confirm head ran while unarmed — FR-3 violated`);
    }
    console.log(`  FR-3: confirm head ran 0 times across ${confirmNeg.length} clip(s) with no wake word`);
  }

  // FR-2/FR-3/FR-5: the primary's own pos_ clips (already required to exist by Tier 2 above) say
  // the wake word but not the confirm phrase — arms, runs the confirm head at least once inside
  // the window, then expires unconfirmed. Exercises "non-zero only inside an armed window" without
  // needing khrapkha-specific clips.
  const primaryClips = clipsFor(primaryForConfirm);
  const primaryPos = primaryClips.clips.filter((f) => f.startsWith('pos_'));
  if (!primaryPos.length) {
    console.log(`  no pos_ clips under ${primaryClips.dir} — FR-2/FR-5 arm/expire check SKIPPED.`);
  } else {
    const f = primaryPos[0];
    const msgs = await feedDual(wav16(join(primaryClips.dir, f)));
    assert.ok(msgs.some((m) => m.type === 'armed'), `${f}: primary spoken but never armed`);
    assert.ok(msgs.some((m) => m.type === 'armExpired'), `${f}: window never expired (no confirm word in this clip)`);
    assert.ok(!msgs.some((m) => m.type === 'hit'), `${f}: confirmed a hit with no confirm word spoken`);
    assert.ok(maxConfirmRuns(msgs) > 0, `${f}: confirm head never ran despite arming`);
    console.log(`  FR-2/FR-5: ${f} armed the confirm head, ran it, then expired unconfirmed`);
  }
  console.log('selfcheck: dual-stage gating assertions passed');
}
