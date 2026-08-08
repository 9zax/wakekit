# Training a wake word — any language

wakekit's runtime is [openWakeWord](https://github.com/dscripka/openWakeWord)-compatible: three
ONNX models chained on 16 kHz mono audio, of which only the last is trained.

    models/melspectrogram.onnx   1.09 MB   frozen, shared by every wake word
    models/embedding_model.onnx  1.33 MB   frozen, shared by every wake word
    models/<yourword>.onnx       ~0.4 MB   the head YOU train

The first two never change. A new wake word — **อีดี**, **jarvis**, anything — is one trained head
plus one entry in `models/manifest.json`.

openWakeWord upstream calls itself English-only because its sample generator ships a single English
TTS checkpoint. wakekit's answer: **any TTS that can say your wake word can build your corpus.**
The shipped Thai "ละดา" heads were trained from ~1000 short TTS clips, on CPU, with a
numpy-only trainer. That whole pipeline is in `scripts/` and driven by the `Makefile`.

No TTS? You can train from your own recordings — see
[train-from-recordings.md](train-from-recordings.md) (.wav / .mp3 → the same pipeline).

## The pipeline

```
make corpus     # 1. TTS clips: positives, rhyming traps, everyday speech (scripts/corpus-*.sh)
make features   # 2. clips → augmented 2 s windows → 1536-d features (scripts/featurize.mjs)
make head       # 3. ~110k-param head, numpy Adam, ONNX export (scripts/train.py)
make eval       # 4. recall + false fires/min on held-out voices (scripts/eval.mjs)
```

`make train-lada` runs all four for the worked example.

### 1. Corpus (`scripts/corpus-lada.sh` — copy it for your word)

Three clip classes, and the middle one is the whole game:

- **pos/** — the wake word spoken bare, several speeds, many voices. Nothing else: training the
  ASR-garble spellings of your word ("ลัดดา" for "ละดา") teaches the model a *different word* —
  measured here, then removed. The garble spellings belong in **hard/** instead.
- **hard/** — words in *your language* that rhyme or share syllables with the wake word
  (ลัดดา, ตลาด, ธิดา…). Generic negative corpora contain none of these; a few hundred targeted
  clips beat 2000 hours of web audio for this specific decision boundary.
- **neg/** — ordinary sentences: the background the model must stay silent through, and the bed
  positives get mixed over during featurization.

Hold several voices out of training entirely (`HOLDOUT` in the script). Held-out *clips* would
leak — augmentations of one clip straddle a random split; held-out *speakers* measure what you
actually care about.

Prosody diversity matters more than count: the shipped corpus renders every hard negative in two
TTS language modes because the single-mode corpus measured **13.3 false fires/min vs 0.3** on
identical held-out clips.

### 2. Featurize

Each clip is dropped into a 2 s window at random offset, gain, and over a random slice of real
speech as background — a 0.6 s studio-TTS clip is one fact; sixteen placements make it a
distribution. Real-mic captures, if you have them, are added at *lower* augmentation and always
paired with same-room negatives — positives-only real audio teaches "real microphone = yes".

### 3. Train

The head is `Flatten(1536) → Gemm(64) → LayerNorm → ReLU → ×2 → Gemm(1) → Sigmoid` — numpy
territory, no torch. Two flags are load-bearing:

- `--neg-weight` (default 8, ละดา ships at 20): a missed wake word is a retry; a false fire talks
  over people. Weight accordingly.
- `--label-smooth` (default 0.03): against hard 0/1 targets, BCE drives the logits until the
  sigmoid saturates — the first head trained here put 98.4% of scores at 0.00 or 1.00, which looks decisive
  and is the opposite: every threshold collapses onto one operating point. Smoothing bought a
  usable score spread without costing a single positive. Watch the `spread` column in the training
  log; near-zero means your threshold is decorative.

Export reuses an existing head (`--base`) as a template — only the weight tensors are replaced, so
the output cannot have a topology onnxruntime-web refuses.

### 4. Measure, then pick the threshold

```
node scripts/eval.mjs eval/clips models/yourword.onnx 0.95
```

The two numbers that decide shipping: **recall** on `pos_*.wav` and **false fires per minute**
(not per clip — a streaming detector re-scores every 80 ms, so "2% of windows" is a false fire
every four seconds).

**The threshold belongs to the model, not the app.** Each head puts its positives and negatives in
a different place. ละดา v1's worst positive scored 0.977 and worst negative 0.902 — a 0.077-wide
gap, and 0.95 sits in its middle. v2's gap is 0.971–0.974: a knife edge, which is why the manifest
carries a per-model threshold and why v1 ships as default. If your gap is that narrow, retrain
with the negatives that fail rather than nudging the number.

Record what you measured in the manifest entry's `note`. Then gate it:

```
npm run selfcheck       # asserts every pos_ fires and every neg_ stays silent, per manifest head
```

## Case study: ละดา (Thai)

Held out: 4 voices never trained on. At threshold 0.95:

| | clips | result |
|---|---|---|
| "ละดา" | 32 | recall 100%, peaks 0.977–0.981 |
| ordinary speech | 24 | 0 false fires, highest peak 0.875 |
| rhyme traps | 136 | 0 false fires, highest peak 0.902 ("บาลี") |

**Caveat that matters:** these are TTS voices, not a real room. No number above predicts false
fires per hour over noisy, distant, overlapping speech — only a real deployment measures that.
Collect real-mic captures of both hits and misses, feed them back through step 2, retrain.
