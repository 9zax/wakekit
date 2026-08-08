# Spec: Wake word → Thai speech-to-text transcript (demo only)

**Date:** 2026-08-09
**Status:** implemented
**Goal:** After the wake word fires on the demo page, start the browser's native Web Speech API in Thai and show a live transcript on the page, then return to wake-word listening automatically.

## Background

`wakekit` detects a wake word in the browser and stops there. `README.md:70-72` states the contract
explicitly: *"A detection means 'the wake word was spoken' — nothing more. Whether your assistant
should respond … is an app-level decision."* In `WakeKitOptions` (`src/index.ts:47-62`) the only
post-detection hook is `onHit`; `onScore` and `onError` are instrumentation.

The demo page already has the natural hook: `onHit` at [demo/main.ts:121-133](../demo/main.ts#L121-L133)
logs the hit and calls `showWakePill()`, which plays a pre-recorded voice ack. This spec adds one
more thing after the ack: start `SpeechRecognition` with `lang: 'th-TH'` and render what the user
says.

This is the first post-detection feature in the repo. There is no prior spec, doc, or code touching
speech-to-text (`specs/` did not exist before this file; `docs/` covers training only).

**The privacy asymmetry is the reason this is demo-only.** wakekit's pitch is that audio never
leaves the tab — the ONNX heads run in a worker on-device. The Web Speech API is the opposite: the
browser streams the microphone to its own cloud speech service. Putting that in the library would
break the promise the README makes. In the demo it is a visible illustration of "what you could
wire `onHit` to", disclosed in EN/TH *before* the first hit, not after.

That disclosure requires **amending existing copy, not just adding to it.** `index.html:50-55` today
says, in the very section this panel joins: *"Audio never leaves your machine — everything runs
locally in this tab."* Once dictation exists on the page that sentence is false as written, so it
must be narrowed to scope itself to wake detection.

## Scope

### In scope

- `demo/main.ts`, `demo/style.css`, `index.html`, and one new `demo/speech.d.ts`.
- Native `SpeechRecognition` / `webkitSpeechRecognition`, Thai (`th-TH`), no dependency added.
- A permanently visible transcript panel in the `#test` section, between the trace caption and the
  `Detections` heading.
- Automatic return to wake-word listening when the user stops speaking.
- An unsupported-browser notice (Firefox, Safari) in EN/TH.
- **Amending the existing `index.html:50-55` hint** so the page does not contradict itself.

### Out of scope

- **Any change to `src/`, `lib/`, or the published package.** `WakeKit`, `WakeKitOptions`,
  `listenMic`, and `src/worker.ts` are untouched. No STT ships in the library, the README usage
  example, `docs/other-languages.md`, or `demo/example-zip.ts`'s downloadable starter. (`example-zip.ts`
  ships its own inline HTML constant at line 152, so `index.html` edits do not leak into the zip.)
- `models/manifest.json` — no new field, no new model. STT is not manifest-driven.
- Any non-browser / cloud STT provider, API key, or server call of our own.
- Persisting, exporting, or uploading the transcript. It lives in the DOM until the page reloads.
- Voice commands, intent parsing, or acting on the transcript.
- Language selection for STT. Thai is hard-coded (`th-TH`); the page's EN/TH toggle is UI copy only
  and does not change the recognition language.
- Retro-translating already-rendered strings when the language toggle flips (see FR-12).

## Requirements

### Functional

- **FR-1** — On a wake hit, the demo starts one `SpeechRecognition` session **immediately**, with
  `lang = 'th-TH'`, `interimResults = true`, `continuous = false`. One session per wake hit.

  *Why immediate (this replaced a wait-for-ack design):* Chrome's recognition capture takes
  **1.8–6.2 s to reach `audiostart` after `.start()`** (measured). Deferring the start to the ack's
  end meant that dead window landed exactly where the user speaks, swallowing their first words.
  This deleted the whole deferred-arming mechanism (single-shot arm, five trigger paths, 250 ms
  echo guard) from earlier revisions of this spec.
- **FR-1b (chime, not voice)** — The wake ack is a **synthesized ~0.6 s two-note chime** (WebAudio,
  E6→A6, no asset), not a spoken mp3. Reason, observed in real use: the spoken ack leaks from the
  speakers back into the recognition mic and **transcribes itself** — echo cancellation did not
  reliably remove it. A tonal chime has no words to transcribe, so leakage is harmless. The old
  shuffle-bag mp3 machinery (per-gender voice sets from `static/voices/`) is deleted from the demo;
  the files remain in the repo but are no longer bundled.
- **FR-4 (pill lifetime)** — the pill shows at the hit and hides when the dictation session ends
  (`endDictation`). A guarded 2500 ms timer (`if (!rec) hideWakePill()`) covers browsers where no
  session ever starts (no STT support), so the pill cannot get stuck there.
- **FR-5** — While a session is active the transcript panel shows a live state chip and interim
  results as the user speaks; the interim line is replaced by the final result when the session ends.
- **FR-5b (wake pill = listening indicator)** — The bottom-right wake pill (orb in the `listening`
  variant + EN/TH "Listening…") stays visible for the entire dictation session; `endDictation`
  hides it. On browsers without STT it hides on the FR-4 timer as before.
- **FR-5c (live caption toast)** — A bottom-center toast (`#stt-toast`, `lang="th"`,
  `aria-hidden` — the panel's live region already announces finals) echoes what is being said:
  interims repaint it live, and each update resets a 5 s timer after which it hides — so the final
  text lingers ~5 s after the user stops. Stop/model-switch hide it immediately via
  `resetSttPanel`.
- **FR-6 (re-entry guard)** — Wake hits are ignored while a session is active **and for a 1.5 s
  cooldown after it ends**. The head carries ~1.3 s of audio in its window (`src/worker.ts`:
  `embWin = 16` × `STEP = 1280` samples ≈ 1.28 s), so without the cooldown a wake word in the user's
  closing words scores *after* the guard drops and immediately re-triggers. The guard flag is set
  **synchronously before `.start()`**, not in `onstart` — Chrome takes 100–500 ms to open its
  connection, and that gap is re-enterable.
- **FR-7** — When the user stops speaking the session ends on its own and the demo returns to
  wake-word listening with no user action. **Wake detection is never torn down**: `WakeKit`,
  `listenMic`, and the score trace keep running throughout; only the `onHit` guard flips.
  (Concurrent capture is confirmed safe: a probe with the wake `getUserMedia` stream held open ran
  a full recognition session normally.)
- **FR-7b (cold-service retry)** — Chromium's speech service, when cold (first session after idle),
  kills the session with `error: 'aborted'` ~40 ms after `start()`, before `audiostart` — and that
  dead start is what spins the service up, so a session ~200 ms later succeeds. Measured with a
  bare probe (no wakekit code on the page): 1st start `aborted` at 36 ms, next session reached
  `audiostart` and ran normally. The demo therefore retries `start()` up to twice (300 ms, then
  1000 ms) when a session dies with `aborted` before `audiostart`; the `dictating` guard holds
  through the retry gap, Stop cancels the pending retry, and only after the retries are exhausted
  is the error surfaced. An `aborted` *after* `audiostart` is not retried.
- **FR-8 (teardown)** — Any path through `stop()` (the `#toggle` button, `modelSel.onchange` at
  `demo/main.ts:301`, and the worker-crash `onError` at `demo/main.ts:261`) aborts an active session
  and resets the panel to its empty state, clearing `finals`. Teardown **nulls `rec` and detaches
  handlers before calling `abort()`**, so it is idempotent, and every handler guards on instance
  identity (`if (r !== rec) return`) — `abort()`'s `end` arrives asynchronously and could otherwise
  tear down a successor session.
- **FR-9 (errors)** — `no-speech`, `network`, `not-allowed`, `service-not-allowed`, and
  `audio-capture` are surfaced in the state chip in EN/TH, and the demo returns to wake-word
  listening. An error line **replaces** any interim text. `aborted` is deliberately **not** surfaced:
  it is only ever produced by our own `abort()` in FR-8, where the panel is being reset anyway.
- **FR-10 (resume path)** — All resume logic lives in `onend`, which Chrome fires last on every path
  (normal, error, and abort). `onerror` only stashes the message for the chip. `.start()` is wrapped
  in try/catch — it throws `InvalidStateError` synchronously if a session is live — and is never
  called from inside `onend`.
- **FR-11** — The panel keeps the last few final transcripts, newest first, matching `#hits`
  ordering. The list is capped; oldest entries drop.
- **FR-12 (unsupported browsers)** — With no `SpeechRecognition` / `webkitSpeechRecognition`, the
  panel slot shows the EN/TH notice, the transcript list and the privacy note are hidden (no audio
  is ever sent, so the disclosure would be a lie), no session is ever created, and the page behaves
  exactly as today. **Wake-word detection must remain fully functional.**

### Non-functional

- **NFR-1** — No new npm dependency. Native browser API only.
- **NFR-2 (copy)** — Short runtime state strings go through the `L()` map at `demo/main.ts:59-66`.
  The long static prose (privacy note, unsupported notice, panel heading) is written as
  `<span class="en">` / `<span class="th">` pairs in `index.html`, where the existing `html[lang]`
  CSS rule switches it for free — no JS involved.
- **NFR-3 (naming)** — Naming *browsers* in a compatibility notice is a capability fact and is
  allowed. Naming the *operator of the speech service* the audio is sent to is not; copy says "your
  browser's own speech service". CLAUDE.md's hard rule is about TTS providers and is untouched here,
  but the two notices must never be merged into one sentence that links a browser name to a service
  operator.
- **NFR-4 (types)** — `npx tsc --noEmit` passes. TypeScript ^5.6.3's `lib.dom.d.ts` already ships
  `SpeechRecognitionResult`, `SpeechRecognitionResultList`, and `SpeechRecognitionAlternative`;
  exactly three are missing. A new `demo/speech.d.ts` declares only `SpeechRecognition`,
  `SpeechRecognitionEvent`, `SpeechRecognitionErrorEvent`, and the two optional `Window` properties,
  reusing the built-ins. `tsconfig.json` already includes `demo`, and `isolatedModules` is satisfied
  because an ambient `.d.ts` with no imports augments the global scope directly (no `declare global`
  wrapper). Do not vendor `@types/dom-speech-recognition` — it redeclares what `lib.dom` has.
  A `ponytail:` comment records the ceiling: these declarations collide once TypeScript ships the
  types itself, and get deleted then.
- **NFR-5 (no motion)** — The panel introduces **no animation at all**: no blinking caret, no fade
  on interim text. A caret repainting on every interim result makes a live transcript hard to read,
  and zero motion satisfies `prefers-reduced-motion` with no media query to maintain.
- **NFR-6 (a11y)** — The state chip is `role="status"` (which already implies polite + atomic — do
  not also write `aria-live`). The transcript list is `aria-live="polite" aria-relevant="additions"`
  so only committed finals are announced. The interim line is a **single persistent `<li>` with
  `aria-hidden="true"` whose `textContent` is mutated in place** — never removed and re-prepended,
  which would read as an insertion. `setLang()` must not rewrite the state chip, or toggling the
  language re-fires the live region.
- **NFR-7 (Thai rendering)** — The transcript element carries `lang="th"` and a Thai-first font
  stack. The transcript is always Thai regardless of the page's EN/TH toggle; without it the browser
  picks the Latin stack and Thai combining marks stack badly.
- **NFR-8 (Thai text handling)** — Thai from the engine arrives unsegmented (no inter-word spaces)
  and unpunctuated, and interims revise earlier characters as context arrives. Never split on
  whitespace for trimming or truncation; repaint the whole interim line rather than appending.
  `confidence` is frequently 0 or absent on `th-TH` — no UI may gate on it.
- **NFR-9 (contrast)** — New text meets WCAG AA on `--bg`. `--faint` (2.4:1) and `--red` (3.6:1) are
  **not** usable for text: use `--dim` (7.5:1) for the empty and interim states, `--red-active`
  (4.6:1) for errors, and `#15803d` (4.8:1) for the live state. The 11 px bold chip is not "large
  text", so 4.5:1 applies.
- **NFR-10** — `npm run selfcheck` is unaffected. It bundles `src/selfcheck.ts` against
  `eval/clips/` and never loads the demo page.

## Data model

Nothing persisted. Demo-local module state in `demo/main.ts`, alongside the existing `kit` /
`stopMic` / `curAudio` globals:

| Name | Type | Purpose |
|---|---|---|
| `rec` | `SpeechRecognition \| null` | Active session. Handlers compare against it for instance identity (FR-8). |
| `dictating` | `boolean` | FR-6 guard. Set synchronously before `.start()`, cleared 1.5 s after `onend`. |
| `sttRetryTimer` | `number` | Pending cold-service retry (FR-7b). Cleared by teardown. |
| `finals` | `string[]` | Recent final transcripts, newest first, capped. |
| `interimLi` | `HTMLLIElement` | The one reused interim node (NFR-6). |

## API / Interface changes

**None.** `src/index.ts`'s exports (`WakeKit`, `WakeKitOptions`, `listenMic`, `loadManifest`,
`resampleLinear`, `WakeModel`) are unchanged, and `models/manifest.json` gains no field.

New demo-internal functions in `demo/main.ts`:

| Function | Role |
|---|---|
| `sttSupported()` | `!!(window.SpeechRecognition ?? window.webkitSpeechRecognition)`. Called once at boot to pick the panel's mode. |
| `startDictation()` | Creates the session, sets `dictating` **first**, `try`/`catch` around `.start()`. Called directly from `showWakePill()` at the hit (FR-1), and by the cold-service retry (FR-7b). |
| `endDictation(r)` | Instance-guarded teardown from `onend`; starts the 1.5 s cooldown. |
| `abortDictation()` | External teardown from `stop()`: null `rec`, detach handlers, `abort()`, reset panel. |
| `renderTranscript(interim)` | Mutates `interimLi.textContent` in place; prepends finals as new `<li>`. |

New markup in `index.html` `#test`, inserted after the `.trace-caption` block and **before** the
`Detections` heading — the transcript is the payoff, `#hits` is diagnostics, and the privacy note
must be readable *before* any audio is sent:

- `<h3>` Transcript / ข้อความที่ถอดได้
- `<p class="hint" id="stt-privacy">` — the disclosure
- `<p class="stt-unsupported" id="stt-unsupported" hidden>` — the FR-12 notice
- `<div id="stt" class="stt">` containing `<div id="stt-state" role="status">` and
  `<ol id="stt-lines" lang="th" aria-live="polite" aria-relevant="additions">`, seeded with an
  `<li class="empty">` bilingual pair exactly like `#hits`.

The panel is **permanently visible with an empty state**, never `hidden`-then-revealed: it avoids
layout shift, removes the "when does it appear" ambiguity, and a `hidden` live region announces
nothing.

### Copy

Amended existing hint (`index.html:50-55`) — scope it to detection:

> EN: "… **Wake-word detection runs entirely in this tab** — audio for that step never leaves your machine."
> TH: "… **การตรวจจับคำปลุกรันในแท็บนี้ทั้งหมด** — เสียงในขั้นตอนนั้นไม่ถูกส่งออกจากเครื่องของคุณ"

Privacy note:

> EN: "Wake detection runs entirely on-device. This dictation step does not: while it runs, your browser sends the audio to its own speech service. Nothing is stored — the text below is gone when you reload."
> TH: "การตรวจจับคำปลุกทำงานในเครื่องคุณทั้งหมด แต่ขั้นตอนถอดเสียงเป็นข้อความไม่ใช่แบบนั้น — ระหว่างที่ทำงาน เบราว์เซอร์จะส่งเสียงไปยังบริการถอดเสียงของเบราว์เซอร์เอง เราไม่ได้เก็บอะไรไว้ ข้อความด้านล่างจะหายไปเมื่อคุณรีโหลดหน้านี้"

Unsupported notice — neutral note, not an error banner: wake detection, the actual product, works
fine in those browsers.

> EN: "Live dictation needs the speech recognition built into the browser — Chrome and Edge have it, Firefox and Safari don't. Everything above still works here: wake-word detection is unaffected, only this transcript step is unavailable in this browser."
> TH: "การถอดเสียงสดต้องใช้ระบบรู้จำเสียงที่ติดมากับตัวเบราว์เซอร์ ซึ่งตอนนี้มีใน Chrome และ Edge แต่ Firefox กับ Safari ยังไม่มี ทุกอย่างด้านบนยังใช้ได้ตามปกติ — การตรวจจับคำปลุกไม่ได้รับผลกระทบ ขาดแค่ขั้นตอนถอดข้อความในเบราว์เซอร์นี้เท่านั้น"

New `STRINGS` entries (`demo/main.ts:59-66`), matching the map's existing lowercase, conversational
register:

```ts
sttListening: ['listening — go ahead', 'กำลังฟัง พูดได้เลย'],
sttNoSpeech:  ["didn't catch that", 'ไม่ได้ยินที่พูด ลองใหม่อีกครั้ง'],
sttNetwork:   ["can't reach the speech service — check your connection", 'ต่อกับบริการถอดเสียงไม่ได้ — ลองเช็กอินเทอร์เน็ต'],
sttMic:       ['microphone blocked — allow mic access to dictate', 'ไมโครโฟนถูกบล็อก — ต้องอนุญาตให้ใช้ไมค์ก่อน'],
sttError:     ['dictation stopped — still listening for the wake word', 'ถอดเสียงหยุดกลางคัน — แต่ยังฟังคำปลุกให้อยู่'],
sttEmpty:     ['nothing yet — say the wake word, then keep talking', 'ยังไม่มี — พูดคำปลุก แล้วพูดต่อได้เลย'],
```

## Edge cases & error handling

| Case | Behaviour |
|---|---|
| No `SpeechRecognition` (Firefox, older Safari) | Notice shown at boot, list + privacy note hidden, no session ever created, wake detection unaffected (FR-12). |
| Chromium build with no vendor speech backend (keyless builds, derived browsers) | The constructor exists and the session reaches `audiostart`/`speechstart`, then **hangs forever** — no result, no error, no end (measured). A 15 s watchdog (reset on every result) aborts the session and shows the EN/TH "no reply from the speech service — try Chrome or Edge" line. |
| Chime overlapping recognition open | Harmless by design (FR-1b) — 0.6 s of tones carries no words; recognition capture usually isn't even open yet (1.8–6.2 s audiostart latency). |
| **Stop** pressed during a pending cold-service retry | `abortDictation()` clears `sttRetryTimer`, so no session starts later (FR-7b). |
| Wake word fires during a session | Ignored by the `dictating` guard (FR-6). No second session, no hit-list entry. |
| Wake word in the user's closing words | Still inside the head's ~1.3 s window when the session ends — absorbed by the 1.5 s cooldown (FR-6). |
| `.start()` throws `InvalidStateError` | Caught; the chip shows the generic EN/TH error line; `dictating` is cleared (FR-10). |
| User says nothing | `error: 'no-speech'` after ~5–8 s, then `end`. Chip shows the EN/TH "didn't catch that" line; any interim text is discarded and replaced by it (FR-9). |
| Offline / service unreachable | `error: 'network'` → offline line; wake listening resumes. |
| Mic permission revoked mid-session | `not-allowed` / `service-not-allowed` → permission line. The wake mic stream is separate; if it also dies, that surfaces through the existing `onError` → `stop()` path. |
| Mic held exclusively by another app (Windows/WASAPI) | `error: 'audio-capture'` → generic error line; wake listening resumes. |
| Session ends with interim but no final | Interim discarded, nothing appended to `finals`. Chrome guarantees a final only on the clean-speech path. |
| Late `end` from an aborted session | Instance-identity guard drops it, so it cannot tear down a successor (FR-8). |
| Model switched mid-session | `modelSel.onchange` → `stop()` → FR-8 teardown; panel resets, then `start()` re-arms wake listening. |
| Worker crash mid-session | `onError` → `stop()` → same FR-8 teardown. |
| Tab backgrounded mid-session | Browser may end the session; treated as a normal `onend`. |
| Long demo run | `finals` capped, oldest drop (FR-11). |
| Language toggled mid-run | Already-rendered lines keep their language (FR-12/scope); only strings written afterwards switch. The state chip is not rewritten by `setLang()` (NFR-6). |
| Served over LAN-IP `http://` | Both `getUserMedia` and recognition require a secure context — neither works. `vite dev` on localhost and the Vercel deploy are both fine. |

## Test plan

No DOM test harness exists here (`npm run selfcheck` is a model-accuracy suite), and adding one for
a demo panel is out of proportion. Verification is typecheck + selfcheck + a written manual pass in
Chrome, then one cross-browser check.

| # | Check | Covers |
|---|---|---|
| T-1 | `npx tsc --noEmit` clean | NFR-4 |
| T-2 | `npm run selfcheck` still green | NFR-10 |
| T-3 | `git diff package.json` shows no new dependency | NFR-1 |
| T-4 | Chrome: wake → speak Thai right after the ack → interim appears, then one final line; first words are not swallowed | FR-1, FR-5 |
| T-5 | Chrome: the wake chime never produces transcript text (it is tonal, wordless), checked on laptop speakers | FR-1b |
| T-6 | Wake on a no-STT browser → pill hides by itself after ~2.5 s (guarded timer, no stuck pill) | FR-4 |
| T-7 | Chrome: say the wake word again mid-dictation → no new session, no new hit entry, **and the score trace keeps moving and crosses the threshold** (proves the wake mic is still live, not merely guarded) | FR-6, FR-7 |
| T-7b | Chrome after sitting idle a while: wake → speak → transcript still appears (console may show "cold speech service — retry 1", but no error surfaces) | FR-7b |
| T-7c | Speak → bottom-center toast shows the text live, stays ~5 s after the final, then hides; Stop hides it at once | FR-5c |
| T-8 | Chrome: end an utterance with the wake word itself → no immediate re-trigger | FR-6 cooldown |
| T-9 | Chrome: stop speaking → session ends by itself, then the next wake word works normally | FR-7, FR-10 |
| T-10 | Chrome: press Stop mid-session → panel resets to empty, nothing appended afterwards | FR-8 |
| T-11 | Chrome: press Stop during the ack → session aborts with it, panel resets, nothing appears later | FR-8 |
| T-12 | Chrome: switch model mid-session → panel resets, listening restarts cleanly | FR-8 |
| T-13 | Chrome: three wake → ack → utterance **cycles** → three final lines, newest first | FR-11 |
| T-14 | Chrome: wake, then stay silent → "didn't catch that", wake listening resumes | FR-9 |
| T-15 | Chrome offline (DevTools) → offline line, wake listening resumes | FR-9 |
| T-16 | Chrome with mic permission revoked in site settings → permission line, no crash | FR-9 |
| T-17 | Firefox and Safari: page loads, notice shows, list + privacy note hidden, wake word still detects and pills | FR-12 |
| T-18 | Toggle EN/TH → the static prose switches immediately; newly written state strings switch. Already-rendered transcript lines do not (documented, matches `#hits`) | NFR-2 |
| T-19 | VoiceOver/NVDA: interim repaints are silent; each final is announced once; toggling language does not re-announce the chip | NFR-6 |
| T-20 | Transcript renders Thai with correct combining marks while the page is in EN mode | NFR-7 |
| T-21 | Review the CSS diff: no `@keyframes`, `transition`, or `animation` added | NFR-5 |
| T-22 | Contrast-check the new text colors against `--bg` | NFR-9 |
| T-23 | Grep the diff's user-facing strings: browser names allowed, no speech-service operator named anywhere | NFR-3 |
| T-24 | Dictate a long Thai sentence → no whitespace-splitting artefacts, interim revisions repaint cleanly, nothing gated on `confidence` | NFR-8 |

## Open questions

All resolved.

- Should this live in the demo or as a separate example/doc? → **In the existing demo page.** The
  library and its published starter zip stay STT-free.
- Is cloud STT acceptable given wakekit's "audio stays local" pitch? → **Yes, for the demo only**,
  and the existing on-page claim is amended so the page stays truthful.
- What happens with the recognized text? → **Displayed as a transcript on the page.** Nothing is
  sent anywhere, stored, or acted on.
- What ends the dictation session? → **The user going quiet.** It ends on its own and wake listening
  resumes automatically, with no button press.
- Which browsers are supported? → **Chrome/Edge, stated plainly**, with a neutral EN/TH notice on
  Firefox/Safari rather than a silent failure.
- One session per wake, or continuous dictation? → **One session per wake** (`continuous = false`).
  Continuous would need its own stop condition and contradicts "the user going quiet ends it".
- Does the transcript survive Stop? → **No.** Stop and model-switch reset the panel to empty.
- Is `aborted` shown to the user? → **No.** It is only ever self-inflicted by our own teardown.
