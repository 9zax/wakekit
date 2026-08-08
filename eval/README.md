# eval/clips — held-out wake word clips (generated, gitignored)

Filename is the expectation: `pos_*.wav` must fire, `neg_*.wav` must not. 16 kHz mono PCM16.

A fresh clone has none. Build them from the corpus script's holdout set (voices never used in
training): `make train-lada` populates this directory, or copy/rename your own clips in.

Consumed by:
  node scripts/eval.mjs eval/clips models/lada.onnx 0.95   # instrument — reports every clip
  npm run selfcheck                                        # gate — asserts, aborts on failure

Never commit real-voice recordings here (`**/captures/` is gitignored for the same reason).
