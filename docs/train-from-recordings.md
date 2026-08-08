# Training from your own recordings (.wav / .mp3)

The pipeline in [training.md](training.md) does not care where clips come from.
`scripts/featurize.mjs` just reads `*.wav` files out of three folders — the worked example fills
them with TTS, but a phone voice memo works exactly the same. The only hard requirement is the
format: **16 kHz, mono, 16-bit PCM WAV** (`wav16()` in the featurizer reads nothing else).
Anything you actually recorded — `.mp3`, `.m4a`, 48 kHz stereo `.wav` — is one ffmpeg call away.

## 1. Record

Lay the clips out the same way the TTS corpus is laid out:

    mycorpus/
      pos/     the wake word, spoken bare — one utterance per file
      hard/    words that rhyme / share syllables with it — one word per file
      neg/     ordinary speech — a few minutes total, any length per file

- **pos/** — just the wake word, nothing before or after it. Vary what matters at runtime:
  speed, loudness, distance from the mic, and above all *speakers* — 3 people × 10 takes beats
  1 person × 30. **One utterance per file**: featurization drops each clip into a 2 s window at
  random offsets, so a file with five takes back-to-back gives the model five words per window.
  If you recorded one long take, cut it into single-word files first.
- **hard/** — the decisive negatives (see [training.md](training.md) for why). Record the
  confusable words in your language the same way you recorded positives.
- **neg/** — ordinary talking: read sentences, ramble, hold a fake meeting. This is both the
  negative class and the background bed positives get mixed over, so a few minutes is enough.

Two traps specific to real recordings:

- **Record negatives with the same mic and room as positives.** If every positive is your voice
  on your headset and every negative is from somewhere else, the model learns "this microphone =
  yes" — measured with real captures during ละดา training, not a theoretical risk.
- **Hold out a speaker.** Keep one voice out of `mycorpus/` entirely and use their clips only in
  `eval/clips/`. Held-out *clips* from a trained speaker leak; held-out speakers measure what you
  care about.

> Don't put hand recordings in `captures/` — that folder is for clips cut by the demo's capture
> bench, which have a fixed detection alignment the featurizer relies on. Plain recordings of the
> wake word go in `pos/`.

## 2. Convert

```bash
for f in raw/*.mp3; do
  ffmpeg -y -i "$f" -ar 16000 -ac 1 -c:a pcm_s16le "mycorpus/pos/$(basename "${f%.*}").wav"
done
```

Same command for any input format — repeat per folder (`pos`, `hard`, `neg`), pointing at
wherever each batch of raw recordings lives.

## 3. Featurize → train → eval

```bash
node scripts/featurize.mjs mycorpus features
python3 scripts/train.py features models/yourword.onnx --neg-weight 20
```

For eval, convert the held-out speaker's clips the same way into `eval/clips/`, named
`pos_*.wav` where the wake word is spoken and `neg_*.wav` where it is not, then:

```bash
node scripts/eval.mjs eval/clips models/yourword.onnx 0.95
```

Thresholds, the manifest entry, and what the numbers mean: [training.md](training.md).

## Mixing recordings with TTS (recommended)

Pure-real corpora are usually small — a few speakers, one room. The strongest cheap combination
is the TTS corpus for breadth (many voices, uniform coverage of the hard negatives) **plus** your
recordings for realism: run your corpus script as usual, then drop the converted recordings into
the same `pos/`, `hard/` and `neg/` folders alongside the TTS clips before featurizing. The
same-mic caution above applies doubly here — real audio added on the positive side only makes the
model fire on any real speech.
