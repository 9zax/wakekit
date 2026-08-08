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

- **FR-1** — On a wake hit, once the voice ack has finished (or has demonstrably not started), the
  demo starts one `SpeechRecognition` session with `lang = 'th-TH'`, `interimResults = true`,
  `continuous = false`. One session per wake hit.
- **FR-2 (arming)** — `showWakePill()` arms a **single-shot, cancellable** deferred start. It fires
  from whichever of these happens first, and exactly once:
  1. the ack clip's `onended` (`demo/main.ts:217`),
  2. the ack clip's `onerror` (same line),
  3. the rejected `a.play()` promise at `demo/main.ts:220` (autoplay block — this rejection fires
     **neither** `ended` nor `error`, so it needs its own entry point),
  4. `speakAck()`'s empty-voice-set early return at `demo/main.ts:210` (which returns *before* any
     handler is attached, so path 1 is unreachable there),
  5. `hideWakePill()`, which calls `curAudio?.pause()` — and `pause()` never fires `ended`.

  `stop()` **clears the armed callback before calling `hideWakePill()`**, so tearing down never
  starts a session. The deferred start is hooked to the paths above only — never to `hideWakePill()`
  as the sole funnel, since `stop()` routes through it.
- **FR-3 (ack echo guard)** — The start is delayed ~250 ms after the ack's terminal event.
  `HTMLAudioElement`'s `ended` fires at end of decode, not end of audible output, and the
  recognition capture's echo cancellation is still converging on a freshly opened stream. Without
  the guard band the ack's tail is transcribed as user speech on machines with speakers near the mic.
- **FR-4 (pill timer)** — `pillTimer` is armed in the clip's `onplay`, not before playback. Today
  `showWakePill()` arms a 2500 ms timer (`demo/main.ts:176`) *before* `speakAck()`; a clip that is
  slow to start is `pause()`d mid-load, which fires neither `ended` nor `play`, stranding the wake
  pill and (with this feature) the deferred start.
- **FR-5** — While a session is active the transcript panel shows a live state chip and interim
  results as the user speaks; the interim line is replaced by the final result when the session ends.
- **FR-6 (re-entry guard)** — Wake hits are ignored while a session is active **and for a 1.5 s
  cooldown after it ends**. The head carries ~1.3 s of audio in its window (`src/worker.ts`:
  `embWin = 16` × `STEP = 1280` samples ≈ 1.28 s), so without the cooldown a wake word in the user's
  closing words scores *after* the guard drops and immediately re-triggers. The guard flag is set
  **synchronously before `.start()`**, not in `onstart` — Chrome takes 100–500 ms to open its
  connection, and that gap is re-enterable.
- **FR-7** — When the user stops speaking the session ends on its own and the demo returns to
  wake-word listening with no user action. **Wake detection is never torn down**: `WakeKit`,
  `listenMic`, and the score trace keep running throughout; only the `onHit` guard flips.
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
| `armed` | `(() => void) \| null` | Single-shot deferred start (FR-2). Cleared by `stop()`. |
| `finals` | `string[]` | Recent final transcripts, newest first, capped. |
| `interimLi` | `HTMLLIElement` | The one reused interim node (NFR-6). |

## API / Interface changes

**None.** `src/index.ts`'s exports (`WakeKit`, `WakeKitOptions`, `listenMic`, `loadManifest`,
`resampleLinear`, `WakeModel`) are unchanged, and `models/manifest.json` gains no field.

New demo-internal functions in `demo/main.ts`:

| Function | Role |
|---|---|
| `sttSupported()` | `!!(window.SpeechRecognition ?? window.webkitSpeechRecognition)`. Called once at boot to pick the panel's mode. |
| `armDictation()` | Sets `armed`; called from `showWakePill()`. |
| `fireArmed()` | `const f = armed; armed = null; f?.()` — the once-only trigger, called from all five FR-2 paths. |
| `startDictation()` | Creates the session, sets `dictating` **first**, `try`/`catch` around `.start()`. |
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
| Chromium build with no speech API keys | Behaves as a `network` error; the unsupported notice's wording does not promise Chromium-derived builds. |
| Ack clip still playing | Start deferred to `onended` + 250 ms (FR-2 path 1, FR-3). |
| Voice set empty | `speakAck()` returns at line 210 before attaching handlers — FR-2 path 4 fires the deferred start. |
| Autoplay blocked | `a.play()` rejects and fires neither `ended` nor `error` — FR-2 path 3 fires it. |
| Ack clip cut short by the pill timer | Cannot happen after FR-4 (timer armed in `onplay`); if `hideWakePill()` still runs first, FR-2 path 5 fires the start. |
| **Stop** pressed while a start is armed but not fired | `stop()` clears `armed` **before** `hideWakePill()`, so nothing starts 250 ms later (FR-2). |
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
| T-4 | Chrome: wake → ack finishes → speak Thai → interim appears, then one final line | FR-1, FR-2, FR-5 |
| T-5 | Chrome: the ack's own recorded voice never appears in the transcript, checked on laptop speakers (not headphones) | FR-3 |
| T-6 | Chrome: throttle the network so the first ack mp3 loads slowly → pill and dictation still behave; clip is not cut off | FR-4 |
| T-7 | Chrome: say the wake word again mid-dictation → no new session, no new hit entry, **and the score trace keeps moving and crosses the threshold** (proves the wake mic is still live, not merely guarded) | FR-6, FR-7 |
| T-8 | Chrome: end an utterance with the wake word itself → no immediate re-trigger | FR-6 cooldown |
| T-9 | Chrome: stop speaking → session ends by itself, then the next wake word works normally | FR-7, FR-10 |
| T-10 | Chrome: press Stop mid-session → panel resets to empty, nothing appended afterwards | FR-8 |
| T-11 | Chrome: press Stop during the ack (before dictation starts) → no session starts | FR-2 cancel |
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
