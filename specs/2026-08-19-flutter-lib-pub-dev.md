# Spec: Flutter library on pub.dev

**Date:** 2026-08-19
**Status:** implemented
**Goal:** Ship wakekit as a Flutter package — the same two frozen ONNX models plus the trained
heads, a Dart port of the `src/worker.ts` pipeline, mic-to-hit out of the box — published on
pub.dev as `wakekit` 0.1.0 for iOS, Android, Windows, and Linux.

> **Amendment (2026-08-20): macOS dropped as a supported target.** Everywhere below that lists
> macOS among the five platforms, read four: iOS, Android, Windows, Linux. Rationale: the repo
> already ships a native macOS app (the Tauri menu-bar WakeKit), so a Flutter macOS target is
> redundant surface with its own floors (macOS ≥ 14, sandbox entitlements). What survives:
> `flutter/example/macos/` stays, UNPUBLISHED, solely as the FR-13 score-parity harness vehicle
> (`scripts/flutter-parity.sh` runs `flutter test -d macos` on the dev machine — the example's
> pubspec is `publish_to: none`, so nothing macOS-flavored reaches pub.dev). Changed: pubspec
> `platforms:` (4 entries), README platform table + floors, CHANGELOG. The pub.dev platform
> score is now 4-of-6 by design. T-rows referencing macOS as a *product* target are void; the
> harness commands in FR-13/T-5/T-6 are unchanged.

## Background

wakekit's runtime is ~60 lines of glue around three plain ONNX files (`docs/other-languages.md:7-8`),
and that doc already ports the pipeline to seven languages with a four-point checklist
(`docs/other-languages.md:418-429`). What no port has is the rest of the library: streaming
(backlog cap, refractory, live retune — `src/worker.ts`), mic capture (`listenMic`,
`src/index.ts:137-162`), the manifest contract (`WakeModel`, `src/index.ts:13-45`), and packaging.
This spec is the Flutter version of that whole surface, not another pseudocode sample.

The browser runtime cannot be reused: `onnxruntime-web` is wasm-only. The Dart port runs the same
`.onnx` files on native ONNX Runtime via the `flutter_onnxruntime` plugin (method-channel,
ORT 1.23.0, releases this quarter, all five targets). The alternative `onnxruntime` (gtbluesky)
package is frozen on ORT 1.15.1 from 2023 with open Android-16/16 KB-page crash reports —
disqualified for a shippable mobile package despite its nicer FFI architecture.

Decisions already made (spec-analysis, 2026-08-19): platforms = iOS + Android + macOS + Windows +
Linux, **no Flutter Web**; models **bundled as package assets** (not CDN); mic capture **in the
library** (parity with `listenMic`) plus a raw push API; monorepo `flutter/` directory; pub.dev
name `wakekit` (verified free — the API 404s for it; pub.dev has no reservation mechanism and
forbids placeholder squatting, so the first *real* publish claims it); own semver from 0.1.0,
independent of npm's 0.2.x.

## Scope

### In scope

- New `flutter/` directory: a complete package (`pubspec.yaml`, `lib/`, `example/`, `test/`,
  `README.md`, `CHANGELOG.md`, synced `LICENSE`/`NOTICE`/assets). No `.pubignore`: with assets
  committed there is nothing for it to re-include, and an empty one would *replace* the
  `flutter create`-generated `flutter/.gitignore` for pub's file listing, leaking `build/` into
  the archive.
- Dart port of the `src/worker.ts` pipeline with identical numerics and streaming behaviour.
- `scripts/sync-flutter-assets.mjs` — copies manifest + models + LICENSE + NOTICE from repo root
  into `flutter/`, generates the version constant, with a `--check` drift gate.
- A `--json` flag on `scripts/eval.mjs` (additive — default output unchanged) emitting per-clip
  peak scores, so the Dart port can be held to score-level parity, not just fire/no-fire.
- One-line `.gitignore` fix: line 32 `lib/` → `/lib/`. The unanchored pattern swallows
  `flutter/lib/` (verified with `git check-ignore`), and because `dart pub publish` evaluates
  ignore files from the repo root down, it would also silently exclude the package's entire
  `lib/` from the published archive. Anchoring keeps the npm build output ignored (verified both
  ways).
- `.vercelignore` gains `flutter` (5 MB of duplicated models must not upload; verified no other
  path matches).
- A parity harness (`scripts/flutter-parity.sh`) driving the example's integration test against
  `eval/clips/` and the `eval.mjs --json` reference scores.
- `.github/workflows/flutter-publish.yml` — OIDC publish on `flutter-v*` tags (the repo has no
  workflows today).
- First manual publish of 0.1.0, then OIDC config on pub.dev.

### Out of scope

- **Any change to `src/`, `demo/`, the npm package, or `models/`** (the gitignore/vercelignore
  lines and the two new scripts are the only repo-root edits; `eval.mjs` gains only the additive
  `--json` flag).
- Flutter Web (would wrap the existing wasm runtime — separate effort).
- Training, corpus, eval-suite changes; no new manifest fields.
- Per-word asset splitting / runtime model download. Bundle-everything is fine at 7 words
  (~5.3 MB raw, ~4.5 MB gzip; pub.dev's enforced limit is 100 MiB uncompressed — room for ~235
  more heads). The real ceiling is consumer app size — Flutter bundles every declared asset with
  no tree-shaking — revisit at ~15–20 words.
- Wake-to-STT, voice commands, or any post-hit feature (app-level, per README's contract).
- Background/lock-screen listening on mobile (foreground services, audio background modes) —
  documented as consumer responsibility.
- Mic capture on Windows/Linux beyond best effort: `record` documents PCM16 streaming there but
  its permission-check matrix does not cover desktop. 0.1.0 ships those platforms **build-verified
  with the mic path untested**, and the README says so plainly (NFR-2). The `push()` API is the
  supported route on desktop until a mic smoke test exists.

## Requirements

### Functional

- **FR-1 (pipeline parity)** — The Dart pipeline is a port of `src/worker.ts` satisfying the
  four-point checklist in `docs/other-languages.md:418-429`: float32 in [-1,1]; 1760-sample mel
  input advancing by 1280 (keep last 480); `v/10 + 2` on every mel value; exactly 76 mel frames →
  embedding, exactly `embWin` embeddings → head. Constants `STEP=1280`, `PAD=480`,
  `MEL_NEED=76*32`, `EMB_DIM=96` mirror the worker.
- **FR-2 (embWin from the model, not a constant)** — `embWin` is read from the head's input shape
  at load. `flutter_onnxruntime`'s `getInputInfo()` returns no shape on iOS/macOS (README matrix:
  ❌ both), so the library reads it from the `.onnx` protobuf bytes directly: the field path
  `ModelProto.graph(7)` → `GraphProto.input(11)[0]` → `ValueInfoProto.type(2)` →
  `TypeProto.tensor_type(1)` → `.shape(2)` → `TensorShapeProto.dim(1)[1].dim_value(1)` — verified
  against the real `lada.onnx` bytes (yields `[1, 16, 96]`), ~40 lines, once per load, identical
  on all platforms. The walker skips unknown fields by wire type (a future exporter may reorder),
  and a symbolic `dim_param` at index 1 falls back to 16 (matches `src/worker.ts`).
- **FR-3 (streaming behaviour parity)** — Refractory 1500 ms after a hit (`lastHitMs` starts at
  `-Infinity`, as the worker's does, so the first crossing always fires); raw-audio backlog capped
  at 32 000 samples (oldest dropped); pump serialized (one inference chain at a time); a mid-stream
  inference error releases the sessions and surfaces exactly one error (no auto-recovery —
  recreate the kit), after which `push` is a no-op. The inference runner is injectable so all of
  this is unit-testable without ORT (T-3).
- **FR-4 (API surface)** — Dart mirror of `src/index.ts`, Flutter-idiomatic but 1:1 in capability.
  Everything public lives in `lib/wakekit.dart`; implementation under `lib/src/`.
  - `class WakeModel` — same fields as `src/index.ts:13-45` incl. `pending`, `trainClips`, and
    `eval`; `WakeModel.fromJson`.
  - `Future<List<WakeModel>> loadManifest()` — reads the bundled
    `packages/wakekit/assets/models/manifest.json`.
  - `class WakeKit`: `static Future<WakeKit> load(WakeKitOptions)`;
    `void push(Float32List samples, int sampleRate)` (resamples to 16 kHz);
    `void configure({double? threshold, bool? verbose})` (live retune, no reload);
    `Future<void> dispose()`. After `dispose`, `push`/`configure` are documented no-ops behind a
    disposed flag (parity with post-`terminate` `postMessage` on the web).
  - Callbacks, parity with `WakeKitOptions` (`src/index.ts:47-62`): `onHit(double score)`,
    `onScore(double score, int atMs)` (verbose only), `onError(Object error)` — an error *object*,
    not the TS `string`, because flattening loses type/stack that Dart consumers expect. No
    streams: a `Stream` wrapper is a one-liner for the consumer, and callback parity keeps the two
    READMEs teachable side by side.
  - `Future<MicSession> listenMic(WakeKit kit)` — requests permission via
    `AudioRecorder().hasPermission()`, then `startStream(RecordConfig(encoder:
    AudioEncoder.pcm16bits, sampleRate: 16000, numChannels: 1))`, converts PCM16 → Float32List
    **with a one-byte carry across chunk boundaries and explicit `Endian.little`** (`record` does
    not guarantee even-length chunks; `ByteData.getInt16` defaults to big-endian), and pushes into
    the kit. `MicSession` is a small class with one `Future<void> stop()` — the ecosystem's
    "running thing you stop" idiom (`StreamSubscription.cancel`, `Timer.cancel`), not a bare
    function. A second `listenMic` on a kit that is already listening throws `StateError` (two
    recorders interleaving into one pipeline corrupts mel continuity silently). `WakeKit.dispose`
    does **not** stop the mic — the `MicSession` owns it; disposing without `stop()` leaves the
    mic open until `stop()` is called, stated in dartdoc and the edge table.
  - `Float32List resampleLinear(Float32List, int inRate, int outRate)` — port of
    `src/index.ts:72-83`. Same inherited limitation as the web: each pushed chunk resamples
    independently with no inter-chunk phase carry, a small discontinuity per chunk at non-integral
    ratios — one line in the README, fix only if it ever measures.
- **FR-5 (threshold from the manifest)** — The per-model `threshold` comes from the bundled
  manifest entry; the library holds it as mutable state settable by `configure`, never a constant.
  No default threshold exists anywhere in Dart source (CLAUDE.md: a threshold belongs to its
  model).
- **FR-6 (pending models)** — `WakeKit.load` on a `pending: true` entry throws an `ArgumentError`
  before touching the plugin (there is no `.onnx` to load); the example app renders pending
  entries disabled/grayed and survives every entry being pending (same contract as the demo page).
- **FR-7 (asset extraction — version-namespaced, race-safe)** — The library does its own
  extraction: `rootBundle.load('packages/wakekit/assets/models/…')` →
  `<tmp>/wakekit/<wakekitVersion>/<file>` → `createSession(path)`. The plugin's
  `createSessionFromAsset` is NOT used: it keys the temp file on basename only and skips
  extraction if present, so a package upgrade with changed bytes would silently keep running the
  old model, and two packages shipping a `model.onnx` collide. Mechanics:
  - `<tmp>` = `getTemporaryDirectory()` (`path_provider` — declared, see NFR-1).
  - `wakekitVersion` — Dart has no API for a package to know its own version, so
    `sync-flutter-assets.mjs` generates `flutter/lib/src/version.dart`
    (`const wakekitVersion = '0.1.0';`) from `flutter/pubspec.yaml`, and `--check` fails on
    mismatch.
  - Concurrent `load()`s (double-tap, two kits): extraction per target path is memoized behind a
    shared `Future`, and the write goes to `<file>.tmp.<rand>` then renames — atomic on one
    filesystem — so no session ever opens a half-written model.
  - After a successful load, older `<tmp>/wakekit/<otherVersion>/` dirs are deleted best-effort
    (failure ignored, untested by design).
  - Extraction runs on the root isolate; a file already present at the right version-path with the
    right byte length is not rewritten.
- **FR-8 (threading)** — The pipeline runs on the root isolate. On Android/iOS/macOS the plugin
  registers background task queues, so ORT `run()` executes off the platform main thread; on
  Windows/Linux it runs on the platform thread, acceptable at single-digit ms per step for these
  tiny graphs. Load math: 12.5 steps/s × ~9 channel calls (3 runs + tensor create/extract
  round-trips), ~23 KB/step (`Float32List` rides the codec's typed-data memcpy path) — no isolate
  in 0.1.0. Measured jank (T-7's frame-chart check) is the trigger to add a long-lived
  `Isolate.spawn` + `SendPort` worker — never per-call `compute` — recorded as a `ponytail:`
  ceiling in the pipeline source.
- **FR-9 (mic rate is a request, not a fact)** — `listenMic` asks for 16 kHz but treats the
  configured rate as unverified: `record` exposes no negotiated-rate API, so chunks route through
  `push(chunk, 16000)` → `resampleLinear` (no-op at 16 kHz), and the example app displays observed
  bytes/sec so a mis-rated device is visible. Documented limitation.
- **FR-10 (sync script)** — `scripts/sync-flutter-assets.mjs` reads repo-root
  `models/manifest.json` and copies into `flutter/`: `manifest.json`, `melspectrogram.onnx`,
  `embedding_model.onnx`, every non-`pending` entry's `file` → `flutter/assets/models/`
  (deleting anything there the manifest doesn't name); repo-root `LICENSE` and `NOTICE` →
  `flutter/` (byte-identical — NOTICE's "Runtime and demo dependencies" paragraph mentions
  node_modules and doesn't apply to the Dart package, but Apache-2.0 §4(d) tolerates surplus
  notices and byte-identical keeps `--check` trivial); regenerates `lib/src/version.dart`.
  `--check` re-derives the expected file set + byte-for-byte content and exits non-zero on drift.
  The copies are **committed**, not gitignored: pub follows symlinks never (file symlinks publish
  silently absent), gitignored assets would make `dart pub publish --dry-run` lie and force a
  pre-step into the blessed OIDC workflow, and 5 MB duplicated in a repo already carrying the
  originals is a non-event.
- **FR-11 (publishing)** — `flutter/pubspec.yaml`: name `wakekit`, `version: 0.1.0`,
  `repository: https://github.com/9zax/wakekit` (pana verifies it), explicit `platforms:` block
  (android/ios/linux/macos/windows), `flutter: assets: [assets/models/]` (directory entry;
  models/ is flat, one line covers all — without this the example and every consumer gets no
  assets), `description` free of TTS provider names. `CHANGELOG.md` carries a `## 0.1.0` heading
  (pana requires the current version as a heading). First publish is manual (`dart pub publish`
  OAuth; a real working package — pub.dev policy forbids name-holding stubs). Then configure
  automated publishing on the pub.dev admin tab (only possible once the package exists):
  repository `9zax/wakekit`, tag pattern `flutter-v{{version}}` — npm's `v*` tags can never match.
  `.github/workflows/flutter-publish.yml` has two jobs: `check` (Node:
  `sync-flutter-assets.mjs --check` + the T-11 greps) and `publish`
  (`uses: dart-lang/setup-dart/.github/workflows/publish.yml@v1`, `needs: check`,
  `permissions: id-token: write`, `environment: pub.dev` with a required-reviewer gate, pointed at
  `flutter/` — the reusable workflow installs the Flutter SDK and asserts tag-vs-pubspec version
  itself; verify at implementation time that `@v1` has the working-directory input). A tag pushed
  before the admin config is rejected with an auth error — recoverable by re-running the workflow
  after configuring, no retag. A protected-tag rule on `flutter-v*` keeps branch-push access from
  equaling publish rights.
- **FR-12 (example app)** — `flutter/example/` is a runnable Flutter app: manifest-driven model
  picker (pending entries disabled), start/stop, live score readout, hit list, observed-rate
  readout — a minimal cousin of the web demo. It depends on the parent package by path; Flutter
  bundles dependency-package assets automatically, so the example declares nothing. Doubles as the
  pub.dev example (10 pub points) and the manual test bed.
- **FR-13 (verification against eval.mjs — score-level, not fire-level)** — The parity standard is
  `docs/other-languages.md:428-429`: compare per-clip scores. `scripts/flutter-parity.sh` (macOS
  dev machine): (1) runs `node scripts/eval.mjs eval/clips/<id> models/<id>.onnx <thr> --json` per
  head to produce reference per-clip peak scores; (2) runs the integration test from
  `flutter/example/`: `flutter test -d macos integration_test/score_clips_test.dart
  --dart-define=WAKEKIT_EVAL_DIR=… --dart-define=WAKEKIT_PEAKS=…`; (3) the test scores each WAV
  through the Dart pipeline and asserts (a) `pos_*` fires and `neg_*` doesn't at the manifest
  threshold and (b) `|peak_dart − peak_js| ≤ 0.02` per clip (fp32 across ORT web 1.27 / native
  1.23 drifts orders of magnitude below that; a clip exceeding it is exactly the bug this harness
  exists to catch). Test mechanics, all mandatory:
  - Clips are padded with **1.5 s of silence at both ends**, as `src/selfcheck.ts:104-106` does —
    the head needs 1.28 s of context before it can score at all, and an unpadded short clip
    produces zero scores, indistinguishable from a confident no.
  - WAV reading walks RIFF chunks to the `data` chunk incl. the odd-size pad byte, as
    `src/selfcheck.ts:62-77` does — these clips carry `LIST` chunks, and a naive 44-byte offset
    reads metadata as PCM. ~15 lines of `ByteData`; no wav dependency.
  - The example's `DebugProfile.entitlements` drops `com.apple.security.app-sandbox`
    (debug/profile only — release untouched): a sandboxed app cannot read `eval/clips/` outside
    its container.
  - Skip semantics are explicit: `WAKEKIT_EVAL_DIR` **unset** → clip tier skips with a message
    (fresh clone; clips are gitignored) but tier 1 — every non-pending head loads and 3 s of
    silence produces no hit — always runs. `WAKEKIT_EVAL_DIR` **set but unreadable** → failure,
    never a skip: otherwise the sandbox regression re-appears as a permanently green false pass.

### Non-functional

- **NFR-1 (dependencies)** — Exactly three runtime deps: `flutter_onnxruntime ^1.8.3`,
  `record ^7.1.1`, `path_provider ^2.1.0`. `path_provider` is declared even though the plugin
  already brings it: importing an undeclared transitive dep trips `depend_on_referenced_packages`
  and costs analysis points. `record` is BSD-3 (`mic_stream` is GPL-3 — viral, disqualified;
  `flutter_sound` drags a codec stack for one API).
- **NFR-2 (consumer platform floors — documented, not hidden)** — Imposed by the deps and stated
  prominently in the README: iOS ≥ 16.0 + `use_frameworks! :linkage => :static`; macOS ≥ 14.0;
  Android minSdk 23 + proguard `-keep class ai.onnxruntime.** { *; }`; Windows/Linux first build
  downloads ORT via CMake FetchContent (offline CI must pre-seed or set `ONNXRUNTIME_VERSION`);
  Linux mic needs system `pulseaudio-utils` + `ffmpeg`; `NSMicrophoneUsageDescription` (iOS/macOS),
  macOS audio-input entitlement, `RECORD_AUDIO` (Android). Two facts to pin during implementation
  and record in the README: whether the ORT Android artifact includes x86_64 (emulator — T-8
  exercises it) and whether the iOS pod carries simulator slices — a missing ABI is a native crash
  on a consumer's first `flutter run`. Windows/Linux mic status ships as "build-verified, mic path
  untested" (scope).
- **NFR-3 (naming)** — No TTS provider named anywhere in `flutter/` — README, pubspec description,
  CHANGELOG, example copy, dartdoc (CLAUDE.md hard rule). The pub.dev listing says "TTS" /
  "synthetic voices". T-11 greps the whole directory, not just the README.
- **NFR-4 (single source of truth)** — No model id, threshold, label, or word list appears in Dart
  source or example code; everything reads the (synced) manifest. Drift is a CI failure
  (`--check`), not a convention.
- **NFR-5 (README)** — English (the bilingual rule scopes to site prose; the npm README is the
  precedent). It states that pub.dev `wakekit` versions are independent of npm `wakekit` versions,
  links the live demo and the repo, carries the same detection-only contract sentence as the npm
  README, and notes the hot-restart limitation (edge table).
- **NFR-6 (pub score)** — Target: full conventions/docs/analysis/deps marks — valid
  pubspec/README/CHANGELOG, Apache-2.0 detected from `flutter/LICENSE`, ≥20% dartdoc (the actual
  pana threshold; this API is small enough to document fully anyway), a real example, clean
  `dart analyze` and `dart format`, current deps. Platform score takes whatever 5-of-6 (no Web)
  yields. `flutter/NOTICE` ships too — Apache-2.0 §4(d) makes it a distribution requirement, and
  it attributes exactly the two frozen models being bundled (verified against NOTICE's content).
- **NFR-7 (no Flutter tooling required at repo root)** — `npm run selfcheck`, the site build, and
  `vercel --prod` are untouched; a contributor without Flutter installed can still do everything
  they can today.
- **NFR-8 (audio privacy)** — Audio never leaves the device: no network call exists anywhere in
  the package (models bundled, inference local — greppable, T-11). Stated in the README as the
  same pitch the npm package makes.

## Data model

No storage. Synced-copy layout (all generated by `sync-flutter-assets.mjs`, all committed):

| Path | Source | Note |
|---|---|---|
| `flutter/assets/models/manifest.json` | `models/manifest.json` | byte-identical copy |
| `flutter/assets/models/*.onnx` | `models/*.onnx` | shared pair + every non-pending head |
| `flutter/LICENSE`, `flutter/NOTICE` | repo root | pub.dev wants LICENSE at package root; NOTICE is Apache §4(d) |
| `flutter/lib/src/version.dart` | `flutter/pubspec.yaml` | the package's only way to know its own version at runtime (FR-7) |

Runtime state in the pipeline object (mirrors `src/worker.ts` module state): `raw` (Float32
backlog, cap 32 000), `mel` (trim to 76×32), `emb` (trim to `embWin`×96), `threshold` (mutable),
`verbose`, `lastHitMs` (init `-Infinity`), `clockMs` (audio-consumed time), `pumping` flag,
`disposed` flag. `MicSession` holds the recorder, its stream subscription, and the one-byte PCM
carry.

## API / Interface changes

New package `wakekit` on pub.dev; no existing interface changes. Public Dart surface:

| Export | Mirrors |
|---|---|
| `WakeModel` (+ `WakeModelEval`) | `src/index.ts:13-45` |
| `WakeKitOptions` (callbacks: `onHit`, `onScore`, `onError(Object)`) | `src/index.ts:47-62` minus `base`/`wasmBase` (assets are bundled) |
| `loadManifest()` | `src/index.ts:65-69`, reading the bundled asset |
| `WakeKit.load / push / configure / dispose` | `src/index.ts:85-130` |
| `listenMic(kit)` → `MicSession` (`stop()`) | `src/index.ts:137-162` |
| `resampleLinear` | `src/index.ts:72-83` |

Repo-root changes: `.gitignore:32` `lib/` → `/lib/`; `.vercelignore` += `flutter`; new
`scripts/sync-flutter-assets.mjs`, `scripts/flutter-parity.sh`; `scripts/eval.mjs` gains `--json`;
new `.github/workflows/flutter-publish.yml`.

## Edge cases & error handling

| Case | Behaviour |
|---|---|
| Package upgraded, model bytes changed | Version-namespaced temp path (FR-7) → fresh extraction; older version dirs removed best-effort after a successful load. |
| Two packages ship a `melspectrogram.onnx` | No collision — our temp path is `<tmp>/wakekit/<version>/…`; the plugin's basename-keyed helper (which has this bug) is never used. |
| Two concurrent `load()`s | Per-path memoized `Future` + write-to-temp-then-rename (FR-7): one extraction, no half-written model ever opened. |
| `load` on a `pending` model | `ArgumentError` before any plugin call (FR-6). |
| `listenMic` on an already-listening kit | `StateError` (FR-4) — never two recorders into one pipeline. |
| `push` / `configure` after `dispose` | Documented no-ops behind the `disposed` flag (FR-4). |
| `dispose` without `MicSession.stop()` | Kit dies; the mic stays open (session owns it) until `stop()` — stated in dartdoc, verified in T-10. |
| Mic permission denied | `listenMic` throws a typed exception; nothing is half-open. `push` with the consumer's own audio still works. |
| Mic delivers a different real rate than requested | Chunks still route through the declared-rate path (FR-9); documented — `record` exposes no negotiated rate. On desktop the permission API may be a constant `true` (matrix gap); scope demotes desktop mic to untested. |
| Odd-length PCM chunk from `record` | One-byte carry joins the straddled sample to the next chunk (FR-4); explicit little-endian decode. |
| Device too slow for real time | Backlog cap drops oldest audio (FR-3) — latency degrades, memory doesn't grow, no crash. |
| Inference throws mid-stream | Sessions released, exactly one `onError`, kit dead, further `push` no-ops — recreate (parity with `src/worker.ts`). |
| `configure(threshold:)` mid-stream | Takes effect next step; no reload (FR-4). |
| Hit in the first second of audio | `lastHitMs = -Infinity` → refractory can never suppress the first crossing (FR-3). |
| Hot restart (dev) | Dart state dies; native ORT sessions and an open recorder survive until full restart — leaked sessions, mic indicator stays lit. Documented in README + dartdoc as a dev-time limitation; no runtime mitigation in 0.1.0. |
| App backgrounded mid-listen (mobile) | OS suspends capture; resume or error surfaces through `record`'s stream error → `onError`. Background listening itself is out of scope. |
| Every manifest entry `pending` | `loadManifest` returns them; example renders all disabled; nothing loads (FR-6). |
| Fresh clone, no `eval/clips/` | Integration test runs tier 1 only (loads + silence), clip tier skips with a message; a *configured but unreadable* clips dir is a failure, not a skip (FR-13). |
| Publish from an unsynced tree | Impossible to do silently: assets are committed, and the CI `check` job gates the tag workflow (FR-10/11). |
| npm tag pushed (`v0.3.0`) | Cannot trigger pub publish — tag pattern `flutter-v{{version}}` (FR-11). |
| Tag pushed before pub.dev OIDC config | Publish rejected with an auth error; configure, re-run the workflow — no retag, nothing was published (FR-11). |

## Test plan

| # | Check | Covers |
|---|---|---|
| T-1 | `dart analyze` and `dart format --set-exit-if-changed` clean in `flutter/` | NFR-6 |
| T-2 | Unit tier (`flutter test`): `resampleLinear` cases ported from TS; PCM16→Float32 with an odd-length chunk straddling a sample (byte-carry) and explicit little-endian; protobuf shape reader → 16 on real `lada.onnx` bytes, the right value on a synthetic model with a different dim, fallback on `dim_param`; manifest parse incl. `pending` and missing `eval`; `load(pendingEntry)` throws `ArgumentError` | FR-1, FR-2, FR-4, FR-6 |
| T-3 | Streaming unit tier with an injectable fake runner: two crossings 1 s apart → one hit (refractory); flooding `push` against a stalled runner → internal buffer never exceeds 32 000; a throwing runner → exactly one `onError`, subsequent `push` no-ops | FR-3 |
| T-4 | `node scripts/sync-flutter-assets.mjs --check` green; corrupt one byte of a copied head → non-zero; edit pubspec version without re-sync → non-zero (version.dart drift) | FR-10, FR-7, NFR-4 |
| T-5 | `scripts/flutter-parity.sh` with `eval/clips/` present: every head — `pos_*` fire, `neg_*` silent at manifest threshold, and per-clip `|peak_dart − peak_js| ≤ 0.02` against `eval.mjs --json` | FR-13, FR-1 |
| T-6 | Same integration test, `WAKEKIT_EVAL_DIR` unset → tier 1 passes, clip tier skips; `WAKEKIT_EVAL_DIR` pointing at an unreadable dir → test fails | FR-13 |
| T-7 | Example app on one physical Android device and one iPhone: pick model → start → say the word → hit; say a sibling name → no hit; observed-rate readout ~16 kHz; DevTools frame chart shows no dropped-frame streak while listening | FR-12, FR-9, FR-8, NFR-2 |
| T-8 | Example boots and passes tier-1 (loads + silence) on an Android x86_64 emulator — pins the ABI question | NFR-2 |
| T-9 | Example: threshold slider (`configure`) changes firing behaviour live, no reload | FR-4, FR-5 |
| T-10 | `MicSession.stop()` releases the mic (OS indicator off); `dispose()` after it → a second `load()` works with fresh extraction (mtime under the version dir); `dispose()` *without* `stop()` → mic stays open until `stop()`, as documented | FR-7, FR-4 |
| T-11 | `dart pub publish --dry-run` file list includes `assets/models/*.onnx`, `LICENSE`, `NOTICE`, excludes `build/`; grep all of `flutter/` for TTS provider names → none; grep `flutter/lib/` for `http`, `HttpClient`, `Socket` → none; pubspec declares exactly the three NFR-1 deps; README review: version-independence + detection-only + platform-floor statements present | FR-11, NFR-1, NFR-3, NFR-5, NFR-8 |
| T-12 | Temporarily mark one manifest entry `pending`, re-run sync: its head disappears from `flutter/assets/models/`, example shows it grayed; revert | FR-6, FR-10 |
| T-13 | `npm run selfcheck` + site build still green after the ignore-file edits; `git check-ignore lib/index.js` still ignored, `flutter/lib/wakekit.dart` not | NFR-7 |
| T-14 | CI: `check` job blocks `publish` (break `--check`, push a `flutter-v*` tag on a test branch → publish never runs); reusable workflow rejects a tag whose version mismatches pubspec | FR-11 |
| T-15 | `pana` run locally on `flutter/`; score recorded in the PR; only expected deductions (platform 5/6) | NFR-6 |
| T-16 | `flutter build windows` and `flutter build linux` of the example succeed in CI (build smoke — the documented desktop support floor) | NFR-2 |

## Open questions

All resolved.

- Which ONNX plugin? → **`flutter_onnxruntime` 1.8.3** — the only maintained option (ORT 1.23.0,
  all five targets); `onnxruntime`/gtbluesky is frozen on ORT 1.15.1 with open Android-16 crash
  issues.
- Which mic plugin? → **`record` 7.x** — the only PCM16 streamer covering all five platforms,
  BSD-3-licensed.
- How to read `embWin` when `getInputInfo` is shapeless on iOS/macOS? → **Parse the head's
  protobuf input shape in Dart** — portable, model-truth, ~40 lines, verified against real bytes.
- Callbacks or streams? → **Callbacks**, mirroring `WakeKitOptions`; `onError` carries an
  `Object`, not a `String` (reviewer finding — Dart idiom).
- What does `listenMic` return? → **A `MicSession` with `stop()`**, not a bare function —
  ecosystem idiom, and it makes mic ownership explicit (`dispose` doesn't stop the mic).
- Worker isolate? → **Not in 0.1.0.** Mobile plugin backends run inference on background task
  queues; add a long-lived isolate only on measured jank (`ponytail:` ceiling noted).
- Commit the synced assets or gitignore them? → **Commit.** Symlinks publish silently absent;
  gitignored assets make dry-run lie and break the blessed OIDC workflow; `--check` in CI keeps
  the copies honest. No `.pubignore` — it would shadow `flutter/.gitignore` for pub and leak
  `build/`.
- Where does `<temp>` and the package's own version come from at runtime? → **`path_provider`
  (declared third dep)** and **a sync-generated `version.dart` constant** — Dart has no
  self-version API, and importing an undeclared transitive dep fails analysis.
- Fire/no-fire or score parity? → **Score parity, tolerance 0.02**, via `eval.mjs --json` — the
  `docs/other-languages.md` standard; firing-only lets resampler/PAD bugs pass on clean clips.
- Windows/Linux mic — tested or honest? → **Honest**: build-verified (T-16), mic path documented
  untested at 0.1.0; `push()` is the supported desktop route.
- README language? → **English** — the bilingual rule scopes to site prose; npm README is the
  precedent.
- Version coupling with npm? → **Independent, stated in the README.** pub.dev and npm share no
  namespace; 0.x semantics on pub give API freedom.
