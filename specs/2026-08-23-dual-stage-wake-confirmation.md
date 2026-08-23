# Spec: Dual-stage wake confirmation (name + ครับ/คะ)

**Date:** 2026-08-23
**Status:** implemented
**Goal:** Let an app opt into requiring a short confirmation word after the wake word — the primary head fires, a second head arms for a few seconds, and only if *both* fire does a wake event reach the app.

## Background

Every head in `models/manifest.json` answers one question on a rolling 1.28 s window: *was this
phrase just spoken?* One crossing of `threshold` is a wake. That is the whole contract
(`README.md:92-94`, restated in `specs/2026-08-09-wake-to-thai-stt.md:9-12`): *"A detection means
'the wake word was spoken' — nothing more."*

In sustained speech that single gate is doing a lot of work alone. A name-shaped head scoring every
80 ms across a long meeting has many chances to find something name-shaped, and the manifest is
honest about it: `lada` ships at 1.05 false fires/min, `thapthim` at 1.34, `nara` at 0.86. Those
numbers are fine for "walk up and say the name" and irritating for "leave it on through a meeting" —
which is the reported problem. Raising the threshold trades recall away; retraining moves the curve
but not the shape of it.

Requiring a *second* word multiplies the two error rates instead of trading along one curve. The
user must say the name **and then** a politeness particle — ครับ (male speaker) or ค่ะ/คะ (female
speaker) — a thing Thai speakers append to an address naturally, so it costs nothing to say.

**The architecture makes this nearly free.** openWakeWord is three chained ONNX models
(`src/worker.ts:1-13`) of which only the last is per-phrase. `melS` and `embS` already run
continuously and their output buffers (`mel`, `emb` at `src/worker.ts:53-54`) are phrase-agnostic.
Scoring a second phrase is one extra `run()` on the *same* `emb` buffer — no extra audio processing,
no second pipeline. A second head is ~0.4 MB and one tiny matmul per 80 ms step.

**The ordering constraint is the whole point, and it is not negotiable.** ครับ/คะ are among the
most frequent words in spoken Thai — in a meeting they occur constantly. A confirm head running
continuously would be a false-fire generator, strictly worse than what we have. It must therefore be
**armed**: zero inference until the primary fires, scoring only inside the window, back to zero when
the window closes. This is the inverse of how the primary head works and is the requirement that
most constrains the implementation (FR-3).

No prior spec touches this. `specs/2026-08-09-wake-to-thai-stt.md` is *post*-hit (dictation after a
wake), and explicitly adds no manifest field (`:51`); `specs/2026-08-19-flutter-lib-pub-dev.md`
puts post-hit features out of scope (`:80`) and keeps everything manifest-driven (`:258-260`). This
feature sits *before* the hit — it changes what "a hit" means — so both contracts survive
unchanged: consumers still get one `onHit`, still meaning "the wake word was spoken". They just get
fewer wrong ones.

## Scope

### In scope

- `src/worker.ts` — a fourth optional ONNX session, arm/disarm state, gated scoring.
- `src/index.ts` — `WakeKitOptions.confirm`, `onArm` / `onArmExpire`, `WakeModel.kind`.
- `models/manifest.json` — the new `kind` field, and one new entry for the confirm head.
- One new trained head for {ครับ, ค่ะ, คะ} plus its `eval/clips/khrapkha/` suite.
- `demo/main.ts` + `index.html` — an opt-in checkbox, armed-state feedback, EN/TH copy.
- Flutter parity: `flutter/lib/src/pipeline.dart`, `wake_kit.dart`, `models.dart`, example app.
- `scripts/corpus-name.sh` — a case branch for the confirm word.
- `src/selfcheck.ts` — a gating-correctness section (FR-3b), separate from the per-head clip tiers.

### Out of scope

- **Changing any existing head's `threshold`.** The obvious follow-on — "the confirm gate lets us
  *lower* the primary bar for better recall" — is real but is a separate measurement job with its
  own eval run. Primary thresholds stay exactly as they ship today.
- **Confirm words for non-Thai models.** The *mechanism* is language-agnostic and takes any two
  manifest entries; the only confirm model that exists is Thai. Nothing hardcodes Thai (FR-9).
- **More than two stages.** Two heads, one window. No chains.
- **A confirm-threshold slider, `onConfirmScore`, or any runtime retune of the confirm head.** The
  confirm head's bar and window are measured/chosen once, shipped in the manifest and the opt-in
  toggle, and changing either means a full kit reload (FR-8) — never a live `configure()` call.
  Tuning by ear on a slider is exactly what "a threshold belongs to its model" exists to prevent.
- **Per-wake-word pairing UI.** One confirm model per language, auto-selected by `lang` (FR-8). A
  second dropdown gets built when a second confirm model exists, not before.
- **Confirmation *before* the name** ("ครับ ละดา") as a supported input. Order is fixed: name, then
  particle. It is not architecturally impossible for a reversed utterance to score (see the edge
  case table) — it's just never the trained, intended path.
- **Retraining or re-evaluating the seven existing wake heads.** The confirm head's training data
  and eval suite are entirely separate from theirs (FR-13). No existing manifest `eval` number
  changes as part of this work.
- **Changing `scripts/eval.mjs`.** It already computes recall and false-fires-per-minute the same
  way for any head; the confirm head's `note` field is where the "armed-only" context lives (FR-15),
  not a new metric.
- Tauri: it hosts the web build in a webview and runs no detection of its own, so it inherits this
  for free. No `src-tauri/` change.

## Requirements

### Functional

- **FR-1 (opt-in, default off)** — With no `confirm` option, behaviour is bit-for-bit today's: one
  head, one threshold, `onHit` on a crossing. Every existing consumer, the published package, and
  all seven current manifest entries are unaffected.

- **FR-2 (arm on primary)** — When `confirm` is configured and the primary head crosses its bar
  (past the existing `REFRACTORY_MS`), the worker does **not** post `hit`. It captures the crossing
  score as `armedScore`, sets `armedUntilMs = clockMs + confirmWindowMs`, posts
  `{type:'armed', score}`, and starts the refractory clock (`lastHitMs = clockMs`) so the same
  utterance cannot re-arm on its own next step.

- **FR-3 (zero work when idle — the load-bearing requirement)** — The confirm session is `run()`
  **only** on steps where `clockMs <= armedUntilMs`. Not scored-and-ignored, not scored-and-gated:
  not executed. This is the entire reason the feature is safe — ครับ/คะ are constant in Thai
  conversation, and a continuously-scored confirm head would fire all day. The call site places the
  `run()` inside the armed branch, structurally: a refactor that hoists it out for tidiness silently
  destroys the feature while every test that only checks *wakes* still passes. FR-3b + T-4 exist to
  catch exactly that regression.

- **FR-3b (confirm-run instrumentation)** — When `verbose`, the worker's periodic `score` message
  gains `confirmRuns`: a counter incremented once per actual confirm-head `run()` call, never reset
  except by `load`. This exists purely so FR-3 is machine-checkable — without it, "zero inference
  when unarmed" is an assertion nobody can verify. Not surfaced in the demo UI.

- **FR-4 (confirm → hit)** — Inside the window, if the confirm head crosses its own `threshold`, the
  worker posts `{type:'hit', score: armedScore}` — the **primary's** captured score, so the app's
  `onHit` contract is unchanged and its number still means "how sure we were of the name" — then
  disarms (`armedUntilMs = -Infinity`) and sets `lastHitMs = clockMs`. Because disarming happens
  immediately, the confirm head cannot double-fire on the particle's own ~1.28 s of held-up score.

- **FR-5 (window expiry)** — If the window closes with no confirm crossing, the worker disarms,
  posts `{type:'armExpired'}` once, and no `hit` is ever emitted for that utterance. The next
  primary crossing arms again normally. Expiry is detected in-loop, on the next audio step after the
  deadline passes — no separate timer, because the mic keeps delivering buffers (silence included)
  at a steady cadence (`listenMic`, `src/index.ts:149-153`) whenever a mic is attached.

- **FR-6 (re-arm)** — A primary crossing while already armed **re-arms** (extends `armedUntilMs`,
  updates `armedScore`) and posts `armed` again; it never emits a hit and never stacks windows.
  `REFRACTORY_MS` (1500 ms) is shorter than the default window (2500 ms), so a user who repeats the
  name while waiting gets the natural behaviour rather than a dead period. Consumers (the demo
  included) must treat a repeat `armed` while already showing the armed state as a no-op, not a
  fresh announcement — see NFR-6.

- **FR-7 (window default)** — `confirmWindowMs` defaults to **2500 ms**, set at `load()` time only
  (not live-retunable — see Out of scope). Rationale: the head's own window is ~1.28 s
  (`embWin = 16` × `STEP = 1280`), so the particle needs roughly that much of the buffer to itself
  before it can peak; 2500 ms leaves room for a natural pause plus the particle without the user
  feeling rushed. Below ~1500 ms the confirm head cannot reliably fill its window at all and the
  feature becomes flaky by construction.

- **FR-7b (shared embedding window)** — The confirm head **must** be trained with the same `embWin`
  as the primary heads (16, from the shared `--base` template — free, since we train it ourselves).
  `emb` is one shared buffer trimmed to one global `embWin` (`src/worker.ts:47,89-91`); a confirm
  head trained at a different window would feed a wrong-shaped tensor into `run()`, which throws
  mid-stream and kills the whole detector. At `load`, the worker reads the confirm head's own input
  shape and **rejects the load** (existing `NFR-4` error path) if it differs from the primary's
  `embWin` — turning a possible mid-stream corruption into a clear, load-time error instead.

- **FR-8 (demo: opt-in toggle)** — A checkbox (`#confirm`, wrapped in `#confirm-row`) in the demo
  controls, separate from the model `<select>` (`demo/main.ts:37`), persisted as
  `localStorage['wakekit-confirm']` (`'1'` / absent) alongside the existing flat keys. A helper
  `confirmFor(model)` finds the first non-pending manifest entry with `kind === 'confirm'` and
  matching `lang`; `syncConfirmRow()` hides `#confirm-row` and its hint when none exists for the
  currently selected wake model, and runs at boot and inside `modelSel.onchange`. **The checkbox's
  checked state and the stored preference are never touched by hiding it** — switching to a model
  with no confirm head just runs single-stage silently (`confirmFor()` returns undefined), and
  switching back to a Thai model restores the feature with no re-click needed. Toggling the checkbox
  triggers a full stop/start of the kit, exactly as `modelSel.onchange` already does
  (`demo/main.ts:908`) — `confirmUrl` rides the worker's `load` message, so there is no lighter path.

- **FR-9 (generic pairing, not hardcoded)** — Nothing in `src/` or `demo/` names `khrapkha`, `lada`,
  or `th` as a literal outside `models/manifest.json` and `scripts/corpus-name.sh`. The worker takes
  a URL and a threshold; the demo picks by `kind` and `lang` from the manifest. Pairing any future
  confirm head with any wake head is a manifest edit, per CLAUDE.md's single-source-of-truth rule.

- **FR-10 (demo: armed feedback)** — All state text (armed / expired / the existing hit/error
  strings) routes through the page's one live region, `#stt-state` (`role="status"`,
  `demo/main.ts` via `setSttState`) — **not** the wake pill, which is `aria-hidden="true"` and purely
  decorative (`index.html`, `.wake-pill[aria-hidden]`). `showWakePill()` (`demo/main.ts:191`) is
  split so the pill's visual show/orb-start is shared but only a confirmed hit starts dictation or
  plays the ack:

  ```ts
  function showPill(text: string, variant: 'listening' | 'working' = 'listening') {
    pillText.textContent = text;
    pill.hidden = false;
    startOrb(variant);
    clearTimeout(pillTimer);
  }
  function showWakePill() {           // confirmed hit — unchanged behaviour from here down
    showPill(current()?.label ?? '');
    startDictation();
    /* ack logic unchanged */
  }
  function onArm() {
    if (dictating || (curAudio && !curAudio.paused && !curAudio.ended)) return; // same guard as onHit
    showPill(L('armed'));
    setSttState(L('armed'));
    pillTimer = window.setTimeout(hideWakePill, confirmWindowMs + 500); // backstop only
  }
  function onArmExpire() { setSttState(L('expired')); hideWakePill(); }
  ```

  A repeat `armed` while the pill is already showing the armed state (FR-6) does not re-announce —
  `setSttState` only writes when the text actually changes.

- **FR-11 (`kind` field)** — `WakeModel` gains `kind?: 'wake' | 'confirm'`. **Absent means `'wake'`**,
  so all seven existing entries stay byte-identical. Any picker that lists wake words filters
  `kind !== 'confirm'`: `demo/main.ts:921-928` and the Flutter example's `_ModelStrip`
  (`flutter/example/lib/main.dart:298`, plus its `firstWhere` at `:87`). A confirm entry must never
  appear as a selectable wake word, and the demo's model-zoo table shows it with a small "confirmation
  word / คำยืนยัน" badge instead of the usual pick-me framing.

- **FR-12 (the confirm head's training set)** — Positives are {ครับ, ค่ะ, คะ} — three spellings of
  one politeness function, not garble variants of one another, so CLAUDE.md's "positives are the wake
  word only" rule is satisfied (that rule bans training ASR mis-hearings of a *name* as that name's
  positives; this is a different head whose legitimate phrase is the particle set). One head covers
  all three so **no user is ever asked to declare their gender** to use the feature.

  **Positives must include the particle spoken as the tail of an utterance, not only in isolation.**
  At the moment the confirm head scores, its 1.28 s window holds the tail of the wake word plus the
  particle — if it only ever saw isolated clips it faces a domain shift precisely where it must
  work. The corpus therefore includes name+particle utterances ("ละดาครับ", "จาร์วิสครับ",
  "ทับทิมค่ะ", …) across all seven names, alongside isolated particles.

- **FR-13 (confirm hard negatives, and exemption from cross-name trapping)** — Per-word confusables
  go in the new `scripts/corpus-name.sh` case branch. A one-syllable particle rhymes with a lot of
  Thai (คับ รับ ขับ กลับ จับ นับ ทับ, คะแนน ค่า คำ ขา, ครับผม), and building that hard-negative list
  is a training-time decision, not a spec blocker.

  **The confirm head is explicitly exempt from CLAUDE.md's sibling cross-trap mechanism, in both
  directions.** That mechanism hardlinks every wake word's `pos` clips into every *other* wake
  word's `hard/` and eval-neg suite. Applying it here is self-contradictory: (a) FR-12 requires
  khrapkha's positives to include "ละดาครับ" — hardlinking that same clip into `lada`'s hard
  negatives would train `lada` to suppress the exact utterance this feature depends on, and (b)
  hardlinking it into `lada`'s `eval/clips/lada/` as `neg_trap_khrapkha_*` would make selfcheck
  assert `lada` must *not* fire on audio the feature requires it to fire on. So: khrapkha's training
  and eval clips are never hardlinked into any wake word's suite, and no wake word's positives are
  hardlinked into khrapkha's. The two training pipelines are independent; only the runtime arm/disarm
  gate (FR-3) keeps them from interfering with each other in production. No existing head's `eval`
  numbers are touched by this feature (see Out of scope).

- **FR-14 (confirm threshold selection)** — The confirm head's `threshold` is chosen with the
  **same procedure** as every other head — `scripts/eval.mjs` on held-out speakers, lowest bar that
  still holds 100% recall on held-out positives — not a different, looser method. What differs is
  interpretation, not process: because the head only ever runs inside a window a successful primary
  crossing opened (FR-3), its continuous-operation false-fire rate is irrelevant to how often it
  actually misfires in practice, so the resulting bar is allowed to sit further from 1.0 than the
  primaries' 0.95 without that being a lowered bar.

- **FR-15 (honest eval numbers)** — The confirm entry's `eval` block is measured the normal way
  (`scripts/eval.mjs`, unchanged), on the full held-out suite, per CLAUDE.md. Its
  `falseFiresPerMin` will look *bad* next to the primaries because ครับ/คะ are common words measured
  over continuous speech. That number is not wrong and must not be massaged: it is the honest
  continuous-operation rate. The `note` states plainly that the head only ever runs armed, inside a
  window a wake word opened, so the table's reader understands what they are looking at — the same
  "known confusables" honesty precedent CLAUDE.md already establishes for `lada`/`wayu`/etc. A
  reversed-order utterance ("ครับ ละดา") that happens to score, if one is found during eval, is
  documented and excluded from the negative suite the same way, not treated as a blocker (see the
  edge case table).

- **FR-16 (Flutter parity)** — The Dart port gets the same arm/disarm gating (in `Pipeline._pump()`,
  `flutter/lib/src/pipeline.dart:110-163`), the same `kind` handling, the same default window, and
  the same opt-in in the example app (a `SwitchListTile` beside the threshold `Slider` at
  `flutter/example/lib/main.dart:244`, filtering `kind == 'confirm'` out of `_ModelStrip`). Like the
  web demo, toggling it requires a stop/start — `confirm` is a load-time `WakeKitOptions` field, not
  something `Pipeline.configure()` carries. Web and Flutter must not diverge in *when* the confirm
  head runs.

### Non-functional

- **NFR-1 (no new dependency)** — Web and Dart both already load ONNX sessions; this adds a fourth
  of the same kind. Nothing new in `package.json` or `pubspec.yaml`.

- **NFR-2 (idle cost is exactly zero)** — With the feature enabled but unarmed, per-step work is
  identical to today: mel, embedding, one head. Armed, it is one extra ~0.4 MB head run per 80 ms
  step for at most 2.5 s. Disabled, the confirm session is never even created.

- **NFR-3 (session lifecycle)** — The `load` handler's release loop (`src/worker.ts:125`) and every
  null-assignment site (`:102` catch, `:126` before create, `:138` load-catch) must include
  `confirmS`, or a demo model-switch leaks wasm memory until `InferenceSession.create` starts
  failing — the exact bug that loop was written for. A fresh `load` also resets `armedUntilMs` to
  `-Infinity`, since a reused worker (selfcheck, demo model-switch) must not carry armed state across
  models.

- **NFR-4 (load failure is loud)** — A confirm head that fails to load, or whose `embWin` mismatches
  (FR-7b), rejects the whole `WakeKit.load()`, consistent with today's "rejects if any fails to load"
  (`src/index.ts:88`). Silently degrading to single-stage would leave an app believing it has two
  gates when it has one. No new user-facing copy is needed — this surfaces through the existing
  generic `onError` EN/TH path.

- **NFR-5 (copy)** — All new user-facing strings are EN/TH pairs: short runtime strings via the
  `L()` map (`demo/main.ts:59-66`), static prose as `<span class="en">`/`<span class="th">` in
  `index.html`. The manifest `note` field stays English-only, matching every existing entry
  (`models/manifest.json` notes are developer-facing eval commentary, not site copy).

- **NFR-6 (a11y)** — All state announcements route through `#stt-state` (`role="status"`, already
  polite + atomic — no extra `aria-live`), never the decorative pill. `setSttState` only writes on an
  actual text change, so a repeat `armed` while already armed (FR-6) does not re-announce, and an
  armed→confirmed→expired burst inside 2.5 s collapses to whatever the reader has time to pick up —
  the same behaviour `role="status"` already gives every other state change on the page. The
  checkbox has a real `<label>` wrapping it, plus `aria-describedby="confirm-hint"`. No new
  animation, so `prefers-reduced-motion` needs no new handling (`startOrb()` already branches on it,
  `demo/main.ts:178`).

- **NFR-7 (types)** — `npx tsc --noEmit` clean. `lib/index.d.ts` regenerates with the new optional
  fields; because every addition is optional, existing typed consumers keep compiling.

- **NFR-8 (selfcheck unchanged in shape for per-head clips, extended for gating)** —
  `src/selfcheck.ts:22-27` loads every non-pending manifest entry as a head and runs its clip suite;
  the confirm entry is a head like any other and needs its own `eval/clips/khrapkha/` suite
  (`pos_*.wav` = isolated and name-tail particle clips, `neg_*.wav` = confusables and everyday
  speech — no sibling traps, per FR-13). That per-head tier needs no code change. **A second,
  new section is added to `src/selfcheck.ts`** — guarded on a non-pending `kind:'confirm'` entry
  existing — that drives the worker's message protocol directly (the same way the file already does
  for `feed()`) with `confirm` configured, and asserts on the `confirmRuns` counter from FR-3b: zero
  across a clip with no wake word, and non-zero only inside an armed window. This is the harness T-4
  through T-8 run against.

## Data model

`models/manifest.json` — one new optional field on the existing schema, plus one new entry:

| Field | Type | Meaning |
|---|---|---|
| `kind` | `'wake' \| 'confirm'`, optional | Absent = `'wake'`. `'confirm'` = never listed as a selectable wake word; only usable as the second stage of a pair. |

The new entry (numbers filled in after training — it ships `pending: true` until then; `threshold`
carries a valid placeholder rather than `0`, because `src/selfcheck.ts:23` asserts
`0 < threshold <= 1` over **every** manifest entry before the `pending` filter is applied, pending
ones included):

```json
{
  "id": "khrapkha",
  "label": "ครับ/คะ",
  "lang": "th",
  "kind": "confirm",
  "file": "khrapkha.onnx",
  "threshold": 0.9,
  "pending": true,
  "note": "Confirmation head — armed only, runs inside the ~2.5 s window a wake word opens, never continuously. Measured on the full held-out suite like every other head; falseFiresPerMin looks high because khrapkha is common in continuous speech, which is irrelevant to how often it actually misfires — see the spec."
}
```

No `gender`: one head covers ครับ and ค่ะ/คะ, so the feature never asks the speaker to declare one.

Worker state added to `src/worker.ts:41-57`:

| Name | Type | Purpose |
|---|---|---|
| `confirmS` | `ort.InferenceSession \| null` | The second head. `null` = feature off, and the whole feature collapses to today's code path. |
| `confirmBar` | `number` | Its own threshold, from its own manifest entry. |
| `confirmWindowMs` | `number` | Default 2500 (FR-7), set only at `load`. |
| `armedUntilMs` | `number` | Worker-clock deadline; `-Infinity` = idle. Uses `clockMs` (audio-consumed time), not wall time, so a GC pause or a throttled tab cannot shorten the window. |
| `armedScore` | `number` | The primary's score at the moment it armed — carried into the eventual `hit` payload (FR-4). |
| `confirmRuns` | `number` | Monotonic counter, incremented once per confirm-head `run()` call. Instrumentation only (FR-3b). |

## API / Interface changes

**Worker protocol** (`src/worker.ts:15-19`):

- `load` gains `confirmUrl?`, `confirmThreshold?`, `confirmWindowMs?`.
- `config` is **unchanged** — no confirm fields. The confirm head's threshold and window are
  load-time only (Out of scope: no live retune).
- New outbound: `{type:'armed', score}` and `{type:'armExpired'}`.
- `{type:'score', score, atMs, confirmRuns?}` — `confirmRuns` only present when `confirm` is
  configured (FR-3b).
- `{type:'hit', score}` is unchanged in shape; its value is `armedScore` when confirm is active.

**`src/index.ts`:**

```ts
export type WakeModel = {
  // …existing fields unchanged…
  /** 'confirm' heads are the second stage of a pair, never a selectable wake word. Absent = 'wake'. */
  kind?: 'wake' | 'confirm';
};

export type WakeKitOptions = {
  // …existing fields unchanged…
  /** Require a second phrase after the wake word. Omit for single-stage (the default). Load-time only. */
  confirm?: {
    model: Pick<WakeModel, 'file' | 'threshold'>;
    /** How long the confirm head listens after the wake word. Default 2500. */
    windowMs?: number;
  };
  /** The wake word was heard; waiting for the confirmation phrase. Not a wake. */
  onArm?: (score: number) => void;
  /** The window closed unconfirmed. No hit followed. */
  onArmExpire?: () => void;
};
```

`configure()` is **unchanged** — `{threshold?, verbose?}` only, matching the worker protocol above.

**Flutter** — the same shape in Dart: `WakeKitOptions.confirmModel` (`WakeModel?`) and
`confirmWindow` (`Duration`, default 2.5 s) on `wake_kit.dart`; a fourth `_confirmSession` field
closed alongside the other three in `_closeSessions()`; the arm/disarm branch added to
`Pipeline._pump()` reading and writing the same `_armedUntilMs`/`_armedScore`/`_confirmRuns` shape as
the worker. `WakeModel.kind` added to `models.dart`'s hand-written `fromJson` (the parser already
tolerates unknown manifest keys, so this is additive, not a migration).

### Copy

Checkbox and hint, inserted in `.controls` (`index.html`) after the existing Reply label, before
`#toggle`:

```html
<label class="check" id="confirm-row" hidden>
  <input type="checkbox" id="confirm" aria-describedby="confirm-hint" />
  <span><span class="en">Require confirmation</span><span class="th">ต้องมีคำยืนยัน</span></span>
</label>

<p class="hint" id="confirm-hint" hidden>
  <span class="en">Say the name, then <b>ครับ</b> or <b>คะ</b> within ~2.5 s. Cuts false wakes during long conversations.</span>
  <span class="th">พูดชื่อ แล้วตามด้วย <b>ครับ</b> หรือ <b>คะ</b> ภายใน ~2.5 วิ ช่วยลดการปลุกผิดตอนคุยยาว ๆ</span>
</p>
```

New `STRINGS` entries (`demo/main.ts:59-66`), matching the map's lowercase conversational register,
no "มัน" anywhere:

```ts
armed:   ['heard the name — say ครับ or คะ', 'ได้ยินชื่อแล้ว — พูด ครับ หรือ คะ ต่อได้เลย'],
expired: ['no confirmation — still listening', 'ไม่มีคำยืนยัน — ยังฟังอยู่'],
confirmBadge: ['confirmation word', 'คำยืนยัน'],
```

## Edge cases & error handling

| Case | Behaviour |
|---|---|
| ครับ/คะ said in a meeting, never preceded by the wake word | Confirm head is not armed, so it is **never executed**. Cannot fire by construction (FR-3, verified via FR-3b's counter). |
| "ละดาครับ" said fast, no pause | Fine — the particle enters the window while armed; the window is a deadline, not a required gap. |
| "ครับ ละดา" (particle spoken before the name) | **Not architecturally impossible to fire.** At the first armed step, the shared `emb` buffer already holds ~1.2 s of *preceding* audio, so a particle spoken just before the name can still be inside that buffer when scoring starts. Order is enforced by what the head was trained on (FR-12 trains name-then-particle, not the reverse), not by the buffer. If eval finds this fires, it is documented as a known confusable and excluded from the eval-neg suite, per FR-15 — not a shipping blocker. |
| Confirm word is a substring of an existing wake word (e.g. ทับ inside ทับทิม) | Independent training/eval suites (FR-13) — a `thapthim` hit does not arm khrapkha (different heads, different pipeline stage), and khrapkha's own hard-negative list should include ทับ-shaped confusables per FR-13. |
| Name said, user stays silent | Window expires → `armExpired` → pill hides, no hit, no dictation. Next name works normally (FR-5). |
| Name repeated while armed | Re-arms, window extends, `armedScore` updates, one `armed` posted (no re-announcement in the demo per FR-6/NFR-6), no stacked windows, no double hit. |
| Confirm word said twice inside one window | First crossing emits the hit and disarms; the second is scored against a disarmed head, i.e. not scored (FR-4). |
| Primary fires at the very end of an utterance, particle lands after the window | No hit. Widen `confirmWindowMs` at `load()` time (FR-7) — not runtime-retunable. |
| Confirm window shorter than the head's own 1.28 s window | Feature is flaky by construction; FR-7 documents ~1500 ms as the floor. |
| Confirm head's `embWin` differs from the primary's | `load()` rejects at the shape check (FR-7b) rather than corrupting a live stream. |
| `confirm.model.file` 404s | `WakeKit.load()` rejects, `onError` carries it (generic existing copy, NFR-4). No silent single-stage fallback. |
| Feature enabled, manifest has no `kind:'confirm'` entry for that `lang` | Demo hides `#confirm-row` (FR-8), preference untouched. Library: the caller simply omits `confirm`. |
| Confirm entry still `pending: true` | Existing pending handling applies — nothing loads it, the checkbox row stays hidden, selfcheck's per-head tier skips it (its placeholder `threshold` still satisfies the pre-filter assertion). The feature ships dark until the head is trained. |
| Model switched while armed | Kit reload (stop/start) resets worker state; `armedUntilMs` returns to `-Infinity` with the fresh `load` (NFR-3). |
| Tab throttled mid-window | Window is measured in `clockMs` (audio consumed), not wall time, so it neither expires early nor stretches. |
| Backlog cap drops audio mid-window (`src/worker.ts:154-158`) | Same failure mode as any dropped audio: a missed particle, window expires, no false wake. Fails closed. |
| Worker dies mid-window | Existing `onError` path; sessions nulled including `confirmS`, `armedUntilMs` reset. |
| Dictation/ack running (demo) | Existing `onHit`/`onArm` guard (`demo/main.ts:145`, mirrored in `onArm`) is untouched — it gates both, so an armed prompt never interrupts an active session. |

## Test plan

`npm run selfcheck` covers the two heads *individually* through its existing per-head clip tier. The
*gating* — arm, confirm-run suppression, expiry, re-arm — lives in worker control flow that no clip
suite exercises on its own, so it gets a dedicated section (NFR-8) driving the worker's message
protocol directly and asserting on the `confirmRuns` counter (FR-3b).

| # | Check | Covers |
|---|---|---|
| T-1 | `npx tsc --noEmit` clean; `lib/index.d.ts` regenerated | NFR-7 |
| T-2 | `npm run selfcheck` green — all seven existing heads unchanged; pending khrapkha entry's placeholder threshold passes the pre-filter assertion without loading anything | NFR-8, Data model |
| T-3 | With `confirm` unset, capture the verbose score trace for a wake clip via the selfcheck harness before and after this change → identical, byte-for-byte | FR-1, NFR-1 |
| T-4 | New selfcheck gating section: feed 60 s of khrapkha's own `neg_*` clips (dense with ครับ/คะ, no wake word) with `confirm` configured → zero `armed`, zero `hit`, and the running `confirmRuns` counter stays exactly 0 throughout | FR-3, FR-3b, NFR-2 |
| T-5 | Wake clip then particle clip within 2.5 s → one `armed`, then one `hit` carrying the primary's score; `confirmRuns` increments only during the armed window | FR-2, FR-4 |
| T-6 | Wake clip then 4 s of silence/neg audio → one `armed`, one `armExpired`, no `hit` | FR-5 |
| T-7 | Wake clip, then particle at 3.5 s (past the window) → no `hit`; re-run with `confirmWindowMs: 4000` → `hit` | FR-5, FR-7 |
| T-8 | Wake clip twice 2 s apart, then particle → two `armed`, one `hit`, no stacked window, `armedScore` reflects the second crossing | FR-6, FR-2 |
| T-9 | Concatenated "ละดาครับ" clip with no pause → `hit` | FR-12 (the domain-shift risk this FR exists for) |
| T-10 | A confirm head asset with `embWin` deliberately mismatched to the primary's → `load()` rejects with an error, no mid-stream crash | FR-7b, NFR-4 |
| T-11 | Switch models 20× with `confirm` on → no wasm allocation failure; `armedUntilMs` is `-Infinity` immediately after every reload | NFR-3 |
| T-12 | `confirm.model.file` pointed at a missing file → `load()` rejects, `onError` called, generic copy shown | NFR-4 |
| T-13 | Demo: checkbox off → behaviour identical to today; on → say the name alone, `#stt-state` shows the armed string then the expired string, pill hides, no ack, no dictation | FR-8, FR-10 |
| T-14 | Demo: checkbox on → name + ครับ → normal wake path (ack, dictation, hit list entry) | FR-10 |
| T-15 | Demo: reload → checkbox state restored from `localStorage`; select a non-Thai wake model → `#confirm-row` hides, checkbox stays checked in storage; switch back → row reappears checked, feature works with no re-click | FR-8 |
| T-16 | Code review: the dual-stage code paths in `src/worker.ts`, `src/index.ts`, and the demo's pairing logic contain no `khrapkha`/`lada`/wake-model-id literal — pairing reads only `kind` and `lang` off the manifest | FR-9 |
| T-17 | Manifest: confirm entry absent from the demo `<select>` and the Flutter example's `_ModelStrip`, present in the model-zoo table with its "confirmation word / คำยืนยัน" badge and its `note` | FR-11, FR-15 |
| T-18 | Repo review: `scripts/corpus-name.sh`'s khrapkha branch and `eval/clips/khrapkha/` contain no sibling wake-word positives; no wake word's `hard/` or eval-neg suite contains a khrapkha-hardlinked clip | FR-13 |
| T-19 | `scripts/eval.mjs` run on the trained khrapkha head reports the same fields (recall, falseFiresPerMin) as every other head, using the unchanged script; threshold in the manifest is the lowest bar with 100% held-out recall | FR-14, FR-15 |
| T-20 | Flutter: `flutter test` green; new gating cases mirroring T-4/T-5/T-6 added to `pipeline_test.dart` against the Dart pipeline; example app toggle restarts the kit | FR-16 |
| T-21 | Toggle EN/TH → new copy switches; VoiceOver/NVDA: armed→confirmed/expired announces through `#stt-state` only, not the decorative pill, and a repeated `armed` while already armed does not re-announce | NFR-5, NFR-6 |

## Open questions

All resolved.

- Simultaneous or sequential? → **Sequential.** The primary fires, then a window opens for the
  particle. A same-frame AND is impossible anyway — two words spoken in sequence never occupy the
  same 1.28 s window cleanly.
- One confirm model or one per particle? → **One**, trained on {ครับ, ค่ะ, คะ} together, so the
  feature never asks a user to declare their gender to configure it.
- How does the manifest keep a confirm head out of the wake-word picker? → **A new `kind` field**,
  absent-means-`'wake'` so all seven existing entries are untouched.
- Scoped to lada, or general? → **General.** Any wake entry pairs with any confirm entry; nothing in
  the code names either. Thai is simply the only language that has a confirm head today.
- What does the opt-in look like? → **A checkbox in the demo controls**, separate from the model
  dropdown, persisted in `localStorage` like every other demo setting, hidden (not disabled) when no
  confirm head exists for the current language.
- Should the confirm head run continuously? → **No — this is the core constraint.** ครับ/คะ are
  everywhere in Thai conversation. It runs only inside the window a wake word opened (FR-3), which
  is also why its standalone false-fire number is allowed to look bad (FR-15), and it is why the
  training/eval pipeline for this head is kept fully separate from the sibling cross-trap mechanism
  (FR-13) rather than folded into it.
- Does Flutter/Tauri parity ship with this? → **Flutter yes** (FR-16). **Tauri needs nothing** — it
  hosts the web build in a webview and runs no detection of its own.
- Can order (particle-then-name) be architecturally blocked? → **No, not without a second embedding
  buffer keyed to the arm moment**, which is more machinery than the problem is worth. Treated as a
  trained bias plus the existing known-confusables escape hatch, not a hard guarantee.
