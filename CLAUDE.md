# wakekit — rules for Claude

Browser wake-word detection (openWakeWord-compatible) + TTS training pipeline. Two frozen ONNX
models shared by every wake word; each word is one trained ~0.4 MB head + one manifest entry.

## Hard rules

- **Never name the TTS providers in anything user-facing** — manifest `note`, README, NOTICE,
  docs, site copy, release notes. Say "TTS" or "synthetic voices". Scripts under `scripts/` may
  reference the APIs they call; that's internal.
- **`models/manifest.json` is the single source of truth** for the demo page (picker, model zoo,
  test-results table) and the library. Adding/changing a model = editing the manifest, no code.
  `pending: true` = announced but untrained: page renders it disabled/grayed, loads nothing, and
  must survive *every* entry being pending.
- **A threshold belongs to its model**, measured with `scripts/eval.mjs` on held-out speakers —
  never a shared constant in app code. Record what was measured in the entry's `note`, and put the
  structured numbers in its `eval` field (+ `trainClips`) so the results table fills itself.
- **Site prose is bilingual**: every user-visible string is an EN/TH pair
  (`<span class="en">` / `<span class="th">`, or the `L()` map in demo/main.ts).
- **Positives are the wake word only** — never train ASR-garble spellings ("มาลี") as positives;
  rhyming/garble words belong in HARD negatives.

## Pipeline (per word)

    bash scripts/corpus-name.sh <id> corpus5      # TTS corpus (resumable — existing clips skipped)
    node scripts/featurize.mjs corpus5/<id>/corpus features5/<id>
    python3 scripts/train.py features5/<id> models/<id>.onnx --neg-weight 20
    node scripts/eval.mjs eval/clips/<id> models/<id>.onnx <threshold>

- `scripts/tts.mjs` is the TTS shim (keys in repo-root `.env`, gitignored). Permanent API errors
  (401/403/404/422) fail fast; transient ones retry — keep it that way, a retry storm on a doomed
  clip stalls the whole xargs pool.
- `corpus5/ features5/ eval5/` are generated and gitignored; hold out whole SPEAKERS, not clips.
- Cross-name traps are free: hardlink the other words' `pos` clips into a word's `hard/` before
  featurizing (`trap_<word>_` prefix) — a multi-model deploy must not fire on a sibling's name.
- Training is numpy-only (`train.py`); ONNX export reuses `--base` as a template. No torch.

## Tests

- `npm run selfcheck` = the per-model unit test: each trained head runs its own clip suite at
  `eval/clips/<id>/` (`pos_*` must fire, `neg_*` — rhymes, meeting speech, other wake words'
  positives — must not). Pending heads are skipped. Keep suites when adding a model.
- `npx tsc --noEmit` before shipping demo/src changes.
