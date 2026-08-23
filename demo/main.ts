// demo/main.ts — the wakekit test page. Everything on-page comes from models/manifest.json, so a
// new wake word (อีดี, jarvis, …) appears in the picker and the table without touching this file.
import { WakeKit, listenMic, loadManifest, type WakeModel } from '../src/index';

// absolute base of wherever the page is mounted ('/' locally, '/wakekit/' on GitHub Pages) —
// worker-side fetches resolve against the worker's URL, so relative paths would break there.
const BASE = new URL('.', location.href).pathname;
// Tauri desktop app: WKWebView has no SpeechRecognition, so dictation runs through a native
// sidecar instead, plus a tray toggle and user-defined `claude -p` voice commands (end of file).
const IS_TAURI = '__TAURI_INTERNALS__' in window;
// In the app the window is just the settings panel — style.css hides the site around it.
if (IS_TAURI) document.body.classList.add('tauri');
import { MODE_DRAWS, resolvePreset } from 'thinking-orbs';
import { downloadExample } from './example-zip';
import jarvisJpg from './jarvis.jpg';
import ladaJpg from './lada.jpg';
import portsMd from '../docs/other-languages.md?raw';
import hljs from 'highlight.js/lib/core';
import langTs from 'highlight.js/lib/languages/typescript';
import langJs from 'highlight.js/lib/languages/javascript';
import langPy from 'highlight.js/lib/languages/python';
import langRust from 'highlight.js/lib/languages/rust';
import langGo from 'highlight.js/lib/languages/go';
import langCs from 'highlight.js/lib/languages/csharp';
import langJava from 'highlight.js/lib/languages/java';
import langCpp from 'highlight.js/lib/languages/cpp';
import langSwift from 'highlight.js/lib/languages/swift';
import 'highlight.js/styles/github-dark.css';

for (const [name, lang] of Object.entries({
  typescript: langTs, javascript: langJs, python: langPy, rust: langRust,
  go: langGo, csharp: langCs, java: langJava, cpp: langCpp, swift: langSwift,
})) hljs.registerLanguage(name, lang);
hljs.registerAliases(['js'], { languageName: 'javascript' });

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const modelSel = $<HTMLSelectElement>('model');
const thr = $<HTMLInputElement>('thr');
const thrVal = $<HTMLSpanElement>('thr-val');
const toggle = $<HTMLButtonElement>('toggle');
const status = $<HTMLDivElement>('status');
const hitsEl = $<HTMLOListElement>('hits');
const canvas = $<HTMLCanvasElement>('trace');
const ctx2d = canvas.getContext('2d')!;
// Dual-stage wake opt-in. spec: 2026-08-23-dual-stage-wake-confirmation
const confirmChk = $<HTMLInputElement>('confirm');
const confirmRow = $<HTMLLabelElement>('confirm-row');
const confirmHint = $<HTMLParagraphElement>('confirm-hint');

let models: WakeModel[] = [];
let kit: WakeKit | null = null;
let stopMic: (() => void) | null = null;
let hitCount = 0;
let startedAt = 0;

// Rolling score trace — last 30 s at 12.5 scores/s.
const TRACE_LEN = 375;
const trace: number[] = [];
const hitMarks: number[] = []; // trace indices where a detection fired

// undefined when every manifest entry is still pending — the page must survive that. A 'confirm'
// head is never a selectable wake word (FR-11), so both lookups exclude kind === 'confirm'.
const current = () =>
  models.find((m) => m.id === modelSel.value && !m.pending && m.kind !== 'confirm')
  ?? models.find((m) => !m.pending && m.kind !== 'confirm');

// The first non-pending 'confirm'-kind entry matching a wake model's language, or undefined.
const confirmFor = (m = current()) =>
  m && models.find((x) => x.kind === 'confirm' && x.lang === m.lang && !x.pending);

// Show/hide the opt-in row for whatever wake model is currently selected. Hiding it never touches
// the checkbox's checked state or the stored preference (FR-8) — switching back to a language with
// a confirm head restores the feature with no re-click.
function syncConfirmRow() {
  const has = !!confirmFor();
  confirmRow.hidden = confirmHint.hidden = !has;
}

const setStatus = (text: string, cls = '') => { status.textContent = text; status.className = `status ${cls}`; };

// ---- EN/TH ---- static prose toggles via CSS (html[lang]); JS-written strings go through L().
const STRINGS = {
  start: ['▶ Start listening', '▶ เริ่มฟัง'],
  stop: ['■ Stop', '■ หยุด'],
  idle: ['idle', 'พร้อม'],
  loading: ['loading models…', 'กำลังโหลดโมเดล…'],
  listening: ['listening', 'กำลังฟัง'],
  sttListening: ['listening — go ahead', 'กำลังฟัง พูดได้เลย'],
  sttNoSpeech: ["didn't catch that", 'ไม่ได้ยินที่พูด ลองใหม่อีกครั้ง'],
  sttNetwork: ["can't reach the speech service — check your connection", 'ต่อกับบริการถอดเสียงไม่ได้ — ลองเช็กอินเทอร์เน็ต'],
  sttMic: ['microphone blocked — allow mic access to dictate', 'ไมโครโฟนถูกบล็อก — ต้องอนุญาตให้ใช้ไมค์ก่อน'],
  sttError: ['dictation stopped — still listening for the wake word', 'ถอดเสียงหยุดกลางคัน — แต่ยังฟังคำปลุกให้อยู่'],
  sttNoService: ['no reply from the speech service — this browser may not include one; try Chrome or Edge', 'บริการถอดเสียงไม่ตอบกลับ — เบราว์เซอร์นี้อาจไม่มีบริการนี้ ลองใช้ Chrome หรือ Edge แท้'],
  // App-only: the sidecar's two blockers on a machine that has never dictated Thai. Both are
  // settings the app cannot flip for you, so the message has to name the exact panel.
  sttAuth: [
    'Speech Recognition is off for WakeKit — allow it in System Settings › Privacy & Security › Speech Recognition (and Microphone)',
    'ยังไม่ได้อนุญาต Speech Recognition ให้ WakeKit — เปิดใน System Settings › Privacy & Security › Speech Recognition (และ Microphone)',
  ],
  sttNoThai: [
    'Thai dictation is not ready — turn Dictation on and add ไทย in System Settings › Keyboard › Dictation, then try again',
    'ยังใช้ถอดเสียงไทยไม่ได้ — เปิด Dictation แล้วเพิ่มภาษาไทยใน System Settings › Keyboard › Dictation แล้วลองใหม่',
  ],
  // Dual-stage wake (spec: 2026-08-23-dual-stage-wake-confirmation).
  armed: ['heard the name — say ครับ or คะ', 'ได้ยินชื่อแล้ว — พูด ครับ หรือ คะ ต่อได้เลย'],
  expired: ['no confirmation — still listening', 'ไม่มีคำยืนยัน — ยังฟังอยู่'],
  confirmBadge: ['confirmation word', 'คำยืนยัน'],
} as const;
const L = (k: keyof typeof STRINGS) => STRINGS[k][document.documentElement.lang === 'th' ? 1 : 0];

const langBtns = [...document.querySelectorAll<HTMLButtonElement>('.lang-toggle button')];
function setLang(lang: string) {
  document.documentElement.lang = lang;
  localStorage.setItem('wakekit-lang', lang);
  for (const b of langBtns) b.classList.toggle('on', b.dataset.lang === lang);
  toggle.textContent = kit ? L('stop') : L('start');
  if (!kit) setStatus(L('idle'));
}
for (const b of langBtns) b.onclick = () => setLang(b.dataset.lang!);
setLang(localStorage.getItem('wakekit-lang') ?? 'en');

function draw() {
  const { width: w, height: h } = canvas;
  ctx2d.clearRect(0, 0, w, h);
  const y = (s: number) => h - 6 - s * (h - 12);

  // threshold line
  const bar = Number(thr.value);
  ctx2d.strokeStyle = '#a3a3a3';
  ctx2d.setLineDash([6, 4]);
  ctx2d.beginPath();
  ctx2d.moveTo(0, y(bar));
  ctx2d.lineTo(w, y(bar));
  ctx2d.stroke();
  ctx2d.setLineDash([]);

  if (trace.length > 1) {
    const dx = w / (TRACE_LEN - 1);
    const x0 = w - (trace.length - 1) * dx; // right-aligned: newest score at the right edge
    ctx2d.strokeStyle = '#0a0a0a';
    ctx2d.lineWidth = 2;
    ctx2d.beginPath();
    trace.forEach((s, i) => (i ? ctx2d.lineTo(x0 + i * dx, y(s)) : ctx2d.moveTo(x0, y(s))));
    ctx2d.stroke();
    ctx2d.fillStyle = '#ef4444';
    for (const i of hitMarks) {
      if (i >= 0 && i < trace.length) {
        ctx2d.fillRect(x0 + i * dx - 4, y(trace[i]) - 4, 8, 8);
      }
    }
  }
}

function onScore(score: number) {
  trace.push(score);
  if (trace.length > TRACE_LEN) {
    const drop = trace.length - TRACE_LEN;
    trace.splice(0, drop);
    for (let i = 0; i < hitMarks.length; i++) hitMarks[i] -= drop;
  }
  draw();
}

function onHit(score: number) {
  // Ignore hits while dictation is listening (plus its cooldown) or a voice ack is talking —
  // the demo must not re-wake from the user's dictated speech or its own spoken reply.
  if (dictating || (curAudio && !curAudio.paused && !curAudio.ended)) return;
  hitMarks.push(trace.length - 1);
  if (hitCount === 0) hitsEl.innerHTML = '';
  hitCount++;
  const t = ((performance.now() - startedAt) / 1000).toFixed(1);
  const li = document.createElement('li');
  li.textContent = `#${hitCount}  ${current()?.label ?? ''}  score ${score.toFixed(3)}  at ${t}s`;
  hitsEl.prepend(li);
  showWakePill();
}

// ---- Wake pill — bottom-right toast on detection, ported from stt-meeting-product's OrbOverlay.
// The orb is thinking-orbs' 'listening' animation painted straight onto a canvas (the lib's React
// wrapper is stubbed out in vite.config); the slide-in/glow lives in style.css.
const pill = $<HTMLDivElement>('wake-pill');
const pillText = $<HTMLSpanElement>('wake-pill-text');
const orbCanvas = $<HTMLCanvasElement>('wake-orb');
const PILL_MS = 2500;
const ORB_SIZE = 64; // the lib's big preset (the other tuning is 20, inline-text)
let pillTimer = 0;
let orbRaf = 0;

function startOrb(variant: 'listening' | 'working' = 'listening') {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  orbCanvas.width = orbCanvas.height = ORB_SIZE * dpr;
  const ctx = orbCanvas.getContext('2d')!;
  const { mode, speed, opts } = resolvePreset(variant, ORB_SIZE);
  const paint = (t: number) => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, ORB_SIZE, ORB_SIZE);
    MODE_DRAWS[mode](ctx, ORB_SIZE, t, false, opts); // light page → dark ink
  };
  cancelAnimationFrame(orbRaf);
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { paint(0.6); return; }
  orbRaf = requestAnimationFrame(function tick() {
    paint((performance.now() / 1000) * speed);
    orbRaf = requestAnimationFrame(tick);
  });
}

function hideWakePill() {
  pill.hidden = true;
  cancelAnimationFrame(orbRaf);
  clearTimeout(pillTimer);
}

// Shared visual show — the pill and its orb — split out so the dual-stage "armed" state can reuse
// it without triggering dictation or the ack (only a CONFIRMED hit does that).
function showPill(text: string, variant: 'listening' | 'working' = 'listening') {
  pillText.textContent = text;
  pill.hidden = false; // display:none → block replays the slide-in animation
  startOrb(variant);
  clearTimeout(pillTimer);
}

function showWakePill() {
  showPill(current()?.label ?? '');
  // Dictation starts at the hit: Chrome's capture takes 2-6s to reach audiostart (measured), so
  // starting now means the window is open by the time the user speaks.
  startDictation();
  if (ackMode === 'voice') {
    speakAck(); // pill lives as long as the clip — its onended resolves instead of the timer
  } else {
    // While dictation listens, the pill is its "Listening…" indicator and endDictation hides it;
    // the guarded timer covers browsers with no STT, where no session ever starts.
    pillTimer = window.setTimeout(() => { if (!rec && !sidecarChild) hideWakePill(); }, PILL_MS);
    playWakeChime();
  }
  if (IS_TAURI) void import('@tauri-apps/api/event').then((e) => e.emit('overlay-show'));
}

// ---- Dual-stage wake — the wake word fired, waiting for the confirmation particle (ครับ/คะ).
// spec: 2026-08-23-dual-stage-wake-confirmation. All state text goes through #stt-state
// (setSttState) — the wake pill itself is aria-hidden/decorative, never a live region.
let activeConfirmWindowMs = 2500;

function onArm() {
  // Same guard as onHit: an armed prompt must not interrupt an active dictation session or ack.
  if (dictating || (curAudio && !curAudio.paused && !curAudio.ended)) return;
  showPill(L('armed'));
  setSttState(L('armed'));
  // Backstop only: armExpired normally hides the pill first. Covers the pathological case where
  // the worker never posts armExpired (e.g. the mic stream stalls).
  pillTimer = window.setTimeout(hideWakePill, activeConfirmWindowMs + 500);
}

function onArmExpire() {
  setSttState(L('expired'));
  hideWakePill();
}

// ---- Wake chime — a short synthesized two-note bell instead of a spoken mp3 ack: a voice ack
// leaks from the speakers back into the recognition mic and transcribes itself; a 0.6s tonal
// chime has no words to transcribe. WebAudio synthesis, no asset to load.
let chimeCtx: AudioContext | null = null;

function playWakeChime() {
  chimeCtx ??= new AudioContext();
  const ctx = chimeCtx;
  if (ctx.state === 'suspended') void ctx.resume(); // allowed: the Start click was a user gesture
  const t0 = ctx.currentTime;
  // Two mellow notes a fourth apart (C5 → F5), almost pure fundamental, gentle 30ms attack and a
  // ~1.6s exponential ring-out. Tuning knobs: NOTES for pitch, the 1.6/1.7 pair for ring length.
  const NOTES: Array<[number, number]> = [[523.25, 0], [698.46, 0.16]];
  const PARTIALS: Array<[number, number]> = [[1, 0.4], [2, 0.04]];
  for (const [freq, at] of NOTES) {
    for (const [mult, peak] of PARTIALS) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = freq * mult;
      g.gain.setValueAtTime(0, t0 + at);
      g.gain.linearRampToValueAtTime(peak, t0 + at + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 1.6);
      o.connect(g).connect(ctx.destination);
      o.start(t0 + at);
      o.stop(t0 + at + 1.7);
    }
  }
}

// ---- Reply mode — 🔔 tone (synthesized chime above) or 🗣 voice (pre-recorded TTS clips from
// static/voices, per persona gender). Voice acks can leak from the speakers into the dictation
// mic and transcribe themselves (the reason the chime exists) — user's choice, so it's a toggle.
let ackMode: 'tone' | 'voice' = localStorage.getItem('wakekit-ack') === 'voice' ? 'voice' : 'tone';
const ackBtns = { tone: $<HTMLButtonElement>('ack-tone'), voice: $<HTMLButtonElement>('ack-voice') };
function setAckMode(mode: 'tone' | 'voice') {
  ackMode = mode;
  localStorage.setItem('wakekit-ack', mode);
  ackBtns.tone.classList.toggle('on', mode === 'tone');
  ackBtns.voice.classList.toggle('on', mode === 'voice');
}
ackBtns.tone.onclick = () => setAckMode('tone');
ackBtns.voice.onclick = () => setAckMode('voice');
setAckMode(ackMode);

// Shuffle-bag draw per persona gender (manifest `gender`): every clip plays once before any
// repeats, never the same clip twice in a row. Unknown gender falls back to female.
const VOICE_SETS: Record<string, string[]> = {
  male: Object.values(import.meta.glob<string>('../static/voices/male/*.mp3', { eager: true, query: '?url', import: 'default' })),
  female: Object.values(import.meta.glob<string>('../static/voices/female/*.mp3', { eager: true, query: '?url', import: 'default' })),
};
const voiceSet = () => VOICE_SETS[current()?.gender ?? 'female'] ?? VOICE_SETS.female;
let voiceBag: string[] = [];
let bagSet: string[] = [];
let lastVoice = '';

function nextVoice() {
  if (bagSet !== voiceSet()) { bagSet = voiceSet(); voiceBag = []; } // model switch resets the bag
  if (!voiceBag.length) {
    voiceBag = [...bagSet].sort(() => Math.random() - 0.5); // ponytail: biased shuffle, fine for a handful of clips
    // pop() draws from the end — make sure the new bag doesn't open with the clip just played
    if (voiceBag.length > 1 && voiceBag[voiceBag.length - 1] === lastVoice)
      [voiceBag[0], voiceBag[voiceBag.length - 1]] = [voiceBag[voiceBag.length - 1], voiceBag[0]];
  }
  lastVoice = voiceBag.pop()!;
  return lastVoice;
}

let curAudio: HTMLAudioElement | null = null;

// The ack finished (or never started). If dictation still listens the pill stays as its
// "Listening…" indicator — endDictation hides it; otherwise hide now.
function ackDone() {
  if (rec || sidecarChild) startOrb('listening');
  else hideWakePill();
}

function speakAck() {
  if (!voiceSet().length) {
    pillTimer = window.setTimeout(ackDone, PILL_MS); // no clip — resolve on the timer
    return;
  }
  const a = new Audio(nextVoice());
  a.onplay = () => {
    if (a !== curAudio) return;
    // no pill timer while the clip plays — the pill lives as long as the voice, onended resolves.
    startOrb('working');
  };
  a.onended = a.onerror = () => { if (a === curAudio) ackDone(); };
  curAudio?.pause(); // a re-wake mid-clip starts the new ack clean
  curAudio = a;
  a.play().catch(() => { if (a === curAudio) ackDone(); }); // autoplay blocked — nothing else fires
}

// ---- Speech-to-text — Chrome/Edge's own SpeechRecognition, th-TH, one session per wake. Demo
// only: unlike wake detection this sends audio to the browser's speech service, which is why
// index.html discloses it separately and it never touches src/. spec: 2026-08-09-wake-to-thai-stt.
const sttPrivacy = $<HTMLParagraphElement>('stt-privacy');
const sttUnsupportedEl = $<HTMLParagraphElement>('stt-unsupported');
const sttPanel = $<HTMLDivElement>('stt');
const sttState = $<HTMLDivElement>('stt-state');
const sttLinesEl = $<HTMLOListElement>('stt-lines');

const sttSupported = () => IS_TAURI || !!(window.SpeechRecognition ?? window.webkitSpeechRecognition);

// The one interim node: created once, reused forever. A screen reader announces aria-live
// insertions, so recreating this node each keystroke risks a spurious announcement race — mutate
// its text in place instead, and let CSS collapse it (:empty) when there's nothing to show.
const interimLi = document.createElement('li');
interimLi.className = 'interim';
interimLi.setAttribute('aria-hidden', 'true');

if (sttSupported()) {
  sttLinesEl.prepend(interimLi);
} else {
  sttPrivacy.hidden = true; // no audio is ever sent here — the disclosure would be a lie
  sttPanel.hidden = true;
  sttUnsupportedEl.hidden = false;
}

const STT_CAP = 8; // ponytail: cap so a long demo run doesn't grow the DOM forever

let rec: SpeechRecognition | null = null;
let dictating = false; // FR-6 guard: true for the session plus a cooldown after it ends
let sttRetryTimer = 0; // pending cold-service retry (see endDictation)
let cooldownTimer = 0;
let lastSttError = '';
let sttSawAudio = false; // did the current session reach audiostart? (cold-service aborts never do)
let sttRetries = 0;
let sttWatchdog = 0; // keyless Chromium builds capture audio but never answer — don't hang forever
const finals: string[] = [];

// Tauri sidecar dictation state — the sidecar replaces `rec` when IS_TAURI.
let sidecarChild: { kill(): Promise<void> } | null = null;
let sidecarGen = 0; // bumped to invalidate stale close handlers (abort vs natural end)
let sidecarError = '';

function setSttState(text: string, cls = '') {
  sttState.textContent = text;
  sttState.className = `stt-state ${cls}`;
}

function sttErrorLabel(code: string): string {
  if (code === 'no-speech') return L('sttNoSpeech');
  if (code === 'network') return L('sttNetwork');
  // The app's codes come from the Swift sidecar, and mean something else than the browser's:
  // 'not-allowed' is the TCC prompt (speech OR mic), 'no-service' is SFSpeechRecognizer having no
  // th-TH — a fresh Mac that has never dictated Thai has neither, which is the whole bug report.
  if (code === 'not-allowed' || code === 'service-not-allowed') return IS_TAURI ? L('sttAuth') : L('sttMic');
  if (code === 'no-service') return IS_TAURI ? L('sttNoThai') : L('sttNoService'); // our watchdog, not a Chrome code
  return `${L('sttError')} (${code})`; // audio-capture etc. — show the raw code, it's the only clue we get
}

function ensureSttEmptyState() {
  const empty = sttLinesEl.querySelector('li.empty');
  if (finals.length || interimLi.textContent) { empty?.remove(); return; }
  if (empty) return;
  const li = document.createElement('li');
  li.className = 'empty';
  li.innerHTML = '<span class="en">nothing yet — say the wake word, then keep talking</span>'
    + '<span class="th">ยังไม่มี — พูดคำปลุก แล้วพูดต่อได้เลย</span>';
  sttLinesEl.append(li);
}

// Bottom-center toast echoing what's being said right now: interims repaint it live, a final
// (or the last interim) lingers 5s, then it hides. Every update resets the clock.
const sttToast = $<HTMLDivElement>('stt-toast');
let sttToastTimer = 0;

function showSttToast(text: string) {
  if (!text) return;
  sttToast.textContent = text;
  sttToast.hidden = false;
  clearTimeout(sttToastTimer);
  sttToastTimer = window.setTimeout(() => { sttToast.hidden = true; }, 5000);
  // mirror every caption (interims, finals, command feedback) onto the above-all-apps overlay
  if (IS_TAURI) void import('@tauri-apps/api/event').then((e) => e.emit('overlay-text', text));
}

function hideSttToast() {
  sttToast.hidden = true;
  clearTimeout(sttToastTimer);
}

function renderInterim(text: string) {
  interimLi.textContent = text; // Thai interims revise earlier chars — always repaint whole, never append
  showSttToast(text);
  ensureSttEmptyState();
}

function addFinal(text: string) {
  const t = text.trim(); // trims edges only — Thai has no inter-word spaces to split on
  if (!t) return;
  showSttToast(t);
  finals.unshift(t);
  const li = document.createElement('li');
  li.textContent = t;
  interimLi.after(li); // newest first, right after the (now-empty) interim slot
  if (finals.length > STT_CAP) {
    finals.pop();
    sttLinesEl.lastElementChild?.remove();
  }
  ensureSttEmptyState();
  handleCommand(t);
}

// ---- Voice commands — finals only (interims revise themselves too much to act on).
// Built-ins come from demo/builtins.ts; the user's own list is edited in the commands window
// (demo/commands.ts) and arrives here over 'cmds-changed'. `type` picks what a match does:
// 'claude' pipes to `claude -p` (default, old entries have no field), 'chrome' Google-searches
// the argument in Chrome, 'youtube' searches YouTube.
import {
  BUILTIN, flexMatch, loadCmds, newsFeed, NEWS_COUNTS, NEWS_MARKETS, NEWS_N_KEY, OPACITIES,
  OPACITY_KEY, parseDdg, parseNews, parseOgImage, resultUrl,
  type NewsItem, type Pip, type VoiceCmd,
} from './builtins';
let voiceCmds: VoiceCmd[] = loadCmds();

async function openExternal(url: string, app?: string) {
  if (IS_TAURI) void (await import('@tauri-apps/plugin-opener')).openUrl(url, app);
  else window.open(url, '_blank');
}

// Results land in the floating card (demo/pip.ts). The website has no such window, so there it
// stays what it always was: a link handed to the browser.
function showPip(p: Pip) {
  if (!IS_TAURI) { const u = resultUrl(p); if (u) void openExternal(u); return; }
  void import('@tauri-apps/api/event').then(({ emit }) => emit('pip', p));
}

function handleCommand(t: string) {
  for (const b of BUILTIN) { // built-ins work on the website too
    const arg = flexMatch(t, b);
    if (arg === null || (b.needsArg && !arg)) continue;
    showSttToast(b.toast(arg));
    const p = b.run(arg);
    // both of these need the network before there is anything to show
    if (p.kind === 'video' && IS_TAURI) void playVideo(p.q);
    else if (p.kind === 'news' && IS_TAURI) void newsSearch(p.q);
    else showPip(p);
    return;
  }
  if (!IS_TAURI) return; // user-defined commands are desktop-app only
  for (const c of voiceCmds) {
    const arg = flexMatch(t, c);
    if (arg === null) continue;
    const q = arg || t; // bare command word — fall back to the whole utterance
    const type = c.type ?? 'claude';
    if (type === 'chrome') {
      showSttToast(`🔎 ${q}`);
      void webSearch(q);
    } else if (type === 'youtube') {
      showSttToast(`▶ ${q}`);
      void playVideo(q);
    } else {
      void runClaudeCmd(c, t);
    }
    return; // first matching command wins
  }
}

// A results page can't be read cross-origin from a webview, so the fetch runs in a shell. curl is
// doing what a browser tab would; keep the desktop UA or the site may serve a stripped page.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
async function sh(cmd: string): Promise<{ code: number | null; stdout: string }> {
  const { Command } = await import('@tauri-apps/plugin-shell');
  const out = await Command.create('sh', ['-lc', cmd]).execute(); // login shell → homebrew is on PATH
  return { code: out.code, stdout: out.stdout };
}

// yt-dlp searches AND hands back a direct stream, which the card plays in a plain <video>. The
// YouTube iframe player is not an option: it refuses to run with error 153 because a webview page
// served from tauri://localhost has no http origin for it to accept.
// ponytail: needs yt-dlp on PATH (brew install yt-dlp). Without it the card offers the browser.
async function playVideo(q: string) {
  const p: Pip = { kind: 'video', q };
  try {
    const out = await sh(`yt-dlp -f 'best[ext=mp4][acodec!=none][vcodec!=none]' --no-warnings`
      + ` --print '%(title)s' --print urls ${shq(`ytsearch1:${q}`)}`);
    const [title, src] = out.stdout.trim().split('\n');
    if (src?.startsWith('http')) { p.src = src; p.title = title; }
  } catch { /* no yt-dlp / offline — the card offers the browser */ }
  showPip(p);
}

// Five stories, five windows — one per story, laid out edge to edge so none covers another, each
// fading in 200 ms after the one before it. Each window carries its story in its own URL: they are
// created after the fact, and an event fired at creation time would arrive before it can listen.
// Fixed tiles, not auto-fitted ones: the layout can only guarantee "no window covers another" if
// every window is the size the layout thinks it is.
const NEWS_W = 300;
const NEWS_H = 232;
const NEWS_GAP = 14; // the padding between one story's window and the next
const NEWS_TOP = 44; // clear of the menu bar
let newsWins: Array<{ close(): Promise<void> }> = [];

async function newsSearch(q: string) {
  const want = Number(localStorage.getItem(NEWS_N_KEY) ?? 5);
  const items: NewsItem[] = [];
  try {
    // One market rarely has enough on a niche topic, so keep pulling the next one until the ask is
    // filled. Whatever the last market has is what you get — no padding with unrelated stories.
    for (const mkt of NEWS_MARKETS) {
      if (items.length >= want) break;
      const more = parseNews((await sh(`curl -sL --max-time 10 -A '${UA}' '${newsFeed(q, mkt)}'`)).stdout, want);
      for (const n of more) if (items.length < want && !items.some((o) => o.url === n.url)) items.push(n);
    }
  } catch { /* offline / curl failed — falls through to the single card below */ }
  if (!items.length) return showPip({ kind: 'news', q });

  // Covers first, in parallel: the card's height depends on whether it has one, and the tiling
  // below needs each window's final height to place the next one under it.
  await Promise.all(items.map(async (n) => {
    try { n.img = parseOgImage((await sh(`curl -sL --max-time 8 -A '${UA}' '${n.url.replace(/'/g, '%27')}'`)).stdout) ?? undefined; }
    catch { /* no cover — that card is text only */ }
  }));

  for (const w of newsWins.splice(0)) await w.close().catch(() => { /* already gone */ });
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  const { currentMonitor } = await import('@tauri-apps/api/window');
  const mon = await currentMonitor();
  // logical px: monitor sizes are physical, window x/y are not
  const scale = mon?.scaleFactor ?? 1;
  const monX = (mon?.position.x ?? 0) / scale;
  const monY = (mon?.position.y ?? 0) / scale;
  const monW = (mon?.size.width ?? 1440) / scale;
  const monH = (mon?.size.height ?? 900) / scale;
  const right = monX + monW - NEWS_GAP - NEWS_W; // anchored to the right edge, columns grow leftward

  // Each card is as tall as its own content, so the next one can only be placed once the previous
  // has measured itself and reported back. Column runs from the top; a full column starts a new one.
  const { listen: onEvent } = await import('@tauri-apps/api/event');
  const pending = new Map<number, (h: number) => void>();
  const stopListening = await onEvent<{ i: number; h: number }>('news-h', (e) => pending.get(e.payload.i)?.(e.payload.h));
  let y = monY + NEWS_TOP;
  let col = 0;

  for (const [i, n] of items.entries()) {
    if (y + NEWS_H > monY + monH - 20 && i > 0) { col++; y = monY + NEWS_TOP; } // column full → next one, from the top
    const p = new URLSearchParams({ kind: 'news', i: String(i), q, title: n.title, source: n.source, url: n.url, iso: n.iso, ...(n.img ? { img: n.img } : {}) });
    newsWins.push(new WebviewWindow(`news-${i}`, {
      url: `pip.html?${p}`,
      width: NEWS_W,
      height: NEWS_H,
      x: right - col * (NEWS_W + NEWS_GAP),
      y,
      transparent: true,
      decorations: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      visibleOnAllWorkspaces: true,
      focus: false,
      focusable: false,
      acceptFirstMouse: true,
      resizable: false,
      shadow: false,
      theme: 'dark',
    }));
    // Its own measured height, or the nominal one if it never reports (a card that failed to load
    // must not stack the rest on top of each other).
    const h = await new Promise<number>((res) => {
      pending.set(i, res);
      setTimeout(() => res(NEWS_H), 1500);
    });
    pending.delete(i);
    y += h + NEWS_GAP;
    await new Promise((r) => setTimeout(r, 200)); // the stagger you see as them opening one by one
  }
  stopListening();
}

// DuckDuckGo's HTML endpoint, not Google: Google answers curl with a consent wall and refuses to
// be framed, so there would be nothing to render.
async function webSearch(q: string) {
  const p: Pip = { kind: 'search', q };
  try {
    // encodeURIComponent leaves ' alone and the URL sits in a single-quoted shell string —
    // percent-encode it rather than stripping, so "don't stop" still searches for what was said.
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q).replace(/'/g, '%27')}`;
    p.results = parseDdg((await sh(`curl -sL --max-time 10 -A '${UA}' '${url}'`)).stdout);
  } catch { /* offline / curl failed — the card offers the browser */ }
  showPip(p);
}

async function runClaudeCmd(cmd: VoiceCmd, text: string) {
  showSttToast(`🤖 ${cmd.word} …`);
  const { Command } = await import('@tauri-apps/plugin-shell');
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  // login shell so `claude` resolves from the user's PATH even when launched from Finder
  const out = await Command.create('run-claude', ['-lc',
    `claude -p ${quote(`${cmd.prompt}\n\nUser said: ${text}`)}`]).execute();
  const reply = (out.stdout || out.stderr).trim();
  showPip({ kind: 'text', title: cmd.word, body: reply || `exit ${out.code}` });
}

function resetSttPanel() {
  finals.length = 0;
  interimLi.textContent = '';
  for (const li of [...sttLinesEl.querySelectorAll('li:not(.interim)')]) li.remove();
  ensureSttEmptyState();
  setSttState('', '');
  hideSttToast();
}

function startDictation() {
  if (IS_TAURI) { void startDictationTauri(); return; }
  const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  if (!SR || rec) return; // never a second concurrent session — that's what gets one 'aborted'
  dictating = true;
  sttSawAudio = false;
  const r = new SR();
  r.lang = 'th-TH';
  r.interimResults = true;
  r.continuous = false;
  // Keyless Chromium builds (no vendor speech backend) reach audiostart and even speechstart,
  // then never send a result, an error, or an end — measured: speechstart at 4s, then silence
  // forever. Real Chrome always answers within ~8s (no-speech). So: no result for 15s → give up.
  const armWatchdog = () => {
    clearTimeout(sttWatchdog);
    sttWatchdog = window.setTimeout(() => {
      if (r !== rec) return;
      r.onresult = r.onerror = r.onend = null;
      try { r.abort(); } catch { /* already dead */ }
      lastSttError = 'no-service';
      endDictation(r);
    }, 15_000);
  };
  r.onresult = (e) => {
    armWatchdog(); // results flowing = service alive — keep resetting
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const result = e.results[i];
      const text = result[0]?.transcript ?? '';
      if (result.isFinal) addFinal(text);
      else interim += text;
    }
    renderInterim(interim);
  };
  r.onaudiostart = () => { if (r === rec) sttSawAudio = true; };
  r.onerror = (e) => {
    lastSttError = e.error;
    console.warn('[wakekit demo] stt error:', e.error, e.message || '');
  };
  r.onend = () => endDictation(r);
  rec = r;
  setSttState(L('sttListening'), 'live');
  armWatchdog();
  try {
    r.start();
  } catch {
    lastSttError = 'start-failed'; // InvalidStateError etc. — unrecognized code, sttErrorLabel falls back to the generic line
    endDictation(r); // 'end' never fires on its own here
  }
}

function endDictation(r: SpeechRecognition) {
  if (r !== rec) return; // stale 'end' from a session already superseded — never tear down the new one
  rec = null;
  clearTimeout(sttWatchdog);
  const err = lastSttError;
  lastSttError = '';
  // Cold speech service: the very first session after idle dies with 'aborted' in ~40ms, before
  // audiostart — but that dead start is itself what spins the service up, so an immediate retry
  // lands on a warm one. (Measured with a bare no-wakekit probe: 1st start aborted at 36ms,
  // a session ~200ms later ran fine.)
  if (err === 'aborted' && !sttSawAudio && sttRetries < 2) {
    sttRetries++;
    console.warn('[wakekit demo] cold speech service — retry', sttRetries);
    sttRetryTimer = window.setTimeout(startDictation, sttRetries === 1 ? 300 : 1000);
    return; // dictating stays true across the retry — the wake guard must hold through the gap
  }
  sttRetries = 0;
  hideWakePill(); // the pill doubled as the "Listening…" indicator for this session
  interimLi.textContent = ''; // discard any unfinished interim — Chrome guarantees a final only on the clean path
  ensureSttEmptyState();
  clearTimeout(cooldownTimer);
  cooldownTimer = window.setTimeout(() => { dictating = false; }, 1500); // FR-6: head still carries ~1.3s of this speech
  setSttState(err ? sttErrorLabel(err) : '', err ? 'error' : '');
}

// ---- Mic selection (Tauri tray → Microphone) — per-app choice, the system default is left
// alone. Saved by LABEL, not deviceId: WebKit rotates device ids between sessions, labels stick.
// The Swift sidecar gets the same label as argv and resolves it against CoreAudio itself.
const MIC_KEY = 'wakekit-mic';

async function micDeviceId(): Promise<string | undefined> {
  const want = localStorage.getItem(MIC_KEY);
  if (!want) return undefined; // system default
  const devs = await navigator.mediaDevices.enumerateDevices();
  return devs.find((d) => d.kind === 'audioinput' && d.label === want)?.deviceId;
}

// Mic level meter — only while the sidecar listens: RMS at ~25fps → 'overlay-level' events so
// the overlay orb bounces with the voice. setInterval, not rAF: the main window may be hidden
// behind other apps (that's the overlay's whole point) and rAF stops firing there.
let levelStop: (() => void) | null = null;

async function startLevelMeter() {
  if (levelStop) return;
  try {
    const id = await micDeviceId();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: id ? { deviceId: { exact: id } } : true,
    });
    const ctx = new AudioContext();
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    const { emit } = await import('@tauri-apps/api/event');
    const iv = window.setInterval(() => {
      an.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      void emit('overlay-level', Math.min(1, Math.sqrt(sum / buf.length) * 8));
    }, 40);
    levelStop = () => {
      clearInterval(iv);
      void ctx.close();
      for (const tr of stream.getTracks()) tr.stop();
    };
  } catch { /* meter is decoration — dictation works without it */ }
}

function stopLevelMeter() {
  levelStop?.();
  levelStop = null;
}

// ---- Tauri dictation — the Swift sidecar (SFSpeechRecognizer th-TH) plays the role of `rec`.
// It streams {"type":"interim"|"final"|"error"|"end","text"} JSON lines and exits after one
// utterance (2s silence / 15s cap live in Swift), so the browser retry/watchdog machinery
// above is deliberately bypassed.
async function startDictationTauri() {
  if (sidecarChild) return;
  dictating = true; // set before the first await — the wake guard must hold from the hit onward
  sidecarError = '';
  setSttState(L('sttListening'), 'live');
  void startLevelMeter();
  const gen = ++sidecarGen;
  try {
    const { Command } = await import('@tauri-apps/plugin-shell');
    const mic = localStorage.getItem(MIC_KEY);
    const cmd = Command.sidecar('binaries/stt-th', mic ? [mic] : []);
    cmd.stdout.on('data', (line: string) => {
      if (gen !== sidecarGen) return;
      let msg: { type: string; text: string };
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.type === 'interim') renderInterim(msg.text);
      else if (msg.type === 'final') { addFinal(msg.text); renderInterim(''); }
      else if (msg.type === 'error') sidecarError = msg.text;
    });
    cmd.on('close', () => { if (gen === sidecarGen) endDictationTauri(); });
    cmd.on('error', (e) => {
      showSttToast(`⚠ stt: ${String(e)}`); // toast mirrors onto the overlay — visible over any app
      if (gen === sidecarGen) { sidecarError = 'sidecar-failed'; endDictationTauri(); }
    });
    sidecarChild = await cmd.spawn();
  } catch (e) {
    console.warn('[wakekit demo] sidecar spawn failed:', e);
    showSttToast(`⚠ stt: ${e instanceof Error ? e.message : String(e)}`);
    if (gen === sidecarGen) { sidecarError = 'sidecar-failed'; endDictationTauri(); }
  }
}

function endDictationTauri() {
  sidecarGen++;
  sidecarChild = null;
  stopLevelMeter();
  hideWakePill();
  interimLi.textContent = '';
  ensureSttEmptyState();
  clearTimeout(cooldownTimer);
  cooldownTimer = window.setTimeout(() => { dictating = false; }, 1500); // same FR-6 tail as endDictation
  const label = sidecarError ? sttErrorLabel(sidecarError) : '';
  setSttState(label, sidecarError ? 'error' : '');
  // The main window is normally hidden — this is a menu-bar app — so an error only written into
  // its panel is an invisible one: dictation just never happens and nothing says why. Silence
  // isn't an error worth interrupting for; anything else goes on the always-on-top overlay.
  if (sidecarError && sidecarError !== 'no-speech') showSttToast(`⚠ ${label}`);
  openSettingsFor(sidecarError);
  sidecarError = '';
}

// Neither blocker can be fixed from inside the app, so take the user to the panel that fixes it.
// Once per code per launch: a wake word that yanks System Settings to the front every time you
// speak would be worse than the bug it is reporting.
const settingsShown = new Set<string>();
function openSettingsFor(code: string) {
  const pane = code === 'not-allowed'
    ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition'
    : code === 'no-service' ? 'x-apple.systempreferences:com.apple.Keyboard-Settings.extension' : '';
  if (!pane || settingsShown.has(code)) return;
  settingsShown.add(code);
  void import('@tauri-apps/plugin-shell')
    .then(({ Command }) => Command.create('sh', ['-lc', `open "${pane}"`]).execute());
}

function abortDictation() {
  sidecarGen++; // orphan any in-flight sidecar callbacks before killing it
  void sidecarChild?.kill();
  sidecarChild = null;
  stopLevelMeter();
  const r = rec;
  rec = null;
  if (r) {
    r.onresult = r.onerror = r.onend = null; // detach before abort() — its 'end' must not reach endDictation
    r.abort();
  }
  dictating = false;
  sttRetries = 0;
  clearTimeout(sttRetryTimer);
  clearTimeout(cooldownTimer);
  clearTimeout(sttWatchdog);
  resetSttPanel();
}

// ---- Hero orb — thinking-orbs showcase, beside the "Test it live" heading. Same pure canvas
// painters as the wake pill, recolored gray: the mode paints its ink, then 'source-in' floods
// a flat gray through the ink's alpha.
{
  const hero = $<HTMLCanvasElement>('hero-orb');
  const DISPLAY = 100; // backing-store CSS px, matches the CSS size
  const scale = (DISPLAY / ORB_SIZE) * Math.min(2, window.devicePixelRatio || 1);
  hero.width = hero.height = ORB_SIZE * scale;
  const hctx = hero.getContext('2d')!;
  const { mode, speed, opts } = resolvePreset('working', ORB_SIZE);
  const paint = (t: number) => {
    hctx.setTransform(scale, 0, 0, scale, 0, 0);
    hctx.clearRect(0, 0, ORB_SIZE, ORB_SIZE);
    MODE_DRAWS[mode](hctx, ORB_SIZE, t, false, opts);
    hctx.globalCompositeOperation = 'source-in';
    hctx.fillStyle = '#a3a3a3'; // --faint
    hctx.fillRect(0, 0, ORB_SIZE, ORB_SIZE);
    hctx.globalCompositeOperation = 'source-over';
  };
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) paint(0.6);
  else requestAnimationFrame(function tick() {
    paint((performance.now() / 1000) * speed);
    requestAnimationFrame(tick);
  });
}

async function start() {
  const m = current();
  if (!m) return;
  toggle.disabled = true;
  setStatus(L('loading'));
  // Dual-stage wake: only actually paired when the checkbox is on AND a confirm head exists for
  // this model's language (FR-8) — a checked-but-hidden checkbox silently runs single-stage.
  const confirmModel = confirmChk.checked ? confirmFor(m) : undefined;
  activeConfirmWindowMs = 2500;
  try {
    kit = await WakeKit.load({
      base: BASE,
      model: { file: m.file, threshold: Number(thr.value) },
      verbose: true,
      onScore,
      onHit,
      ...(confirmModel ? {
        confirm: { model: { file: confirmModel.file, threshold: confirmModel.threshold }, windowMs: activeConfirmWindowMs },
        onArm,
        onArmExpire,
      } : {}),
      onError: (msg) => { setStatus(`worker error: ${msg}`, 'error'); void stop(); },
    });
    stopMic = await listenMic(kit, await micDeviceId());
    startedAt = performance.now();
    setStatus(`${L('listening')} — ${m.label} @ ${Number(thr.value).toFixed(3)}`, 'live');
    toggle.textContent = L('stop');
    toggle.classList.add('stop');
    void setTrayState(true);
  } catch (e) {
    kit?.dispose(); kit = null;
    const msg = e instanceof Error ? e.message : String(e);
    setStatus(msg, 'error');
    // the window may be hidden behind other apps when started from the tray — echo the failure
    // on the always-on-top overlay so a silent no-op is impossible
    if (IS_TAURI) void import('@tauri-apps/api/event').then((ev) => ev.emit('overlay-text', `⚠ ${msg}`));
    toggle.textContent = L('start');
  }
  toggle.disabled = false;
}

async function stop() {
  abortDictation();
  hideWakePill();
  stopMic?.(); stopMic = null;
  kit?.dispose(); kit = null;
  trace.length = 0; hitMarks.length = 0;
  draw();
  setStatus(L('idle'));
  toggle.textContent = L('start');
  toggle.classList.remove('stop');
  void setTrayState(false);
}

toggle.onclick = () => (kit ? void stop() : void start());

thr.oninput = () => {
  thrVal.textContent = Number(thr.value).toFixed(3);
  kit?.configure({ threshold: Number(thr.value) });
  if (kit) setStatus(`${L('listening')} — ${current()?.label ?? ''} @ ${Number(thr.value).toFixed(3)}`, 'live');
  draw();
};

modelSel.onchange = async () => {
  localStorage.setItem('wakekit-model', modelSel.value); // settings must survive a relaunch
  void setTrayState(!!kit); // tray header names the active persona
  const m = current();
  if (!m) return;
  thr.value = String(m.threshold); // each head ships its own measured bar
  thrVal.textContent = m.threshold.toFixed(3);
  syncConfirmRow(); // a different model may not have a confirm head for its language (FR-8)
  if (kit) { await stop(); await start(); } // hot-swap: reload with the new head
  draw();
};

confirmChk.onchange = async () => {
  localStorage.setItem('wakekit-confirm', confirmChk.checked ? '1' : '0');
  // confirmUrl only rides the worker's 'load' message — configure() can't add/remove a session,
  // so toggling always reloads the kit, same as a model switch.
  if (kit) { await stop(); await start(); }
};

// ---- boot ----
try {
  models = await loadManifest(BASE);
  for (const m of models) {
    if (m.kind === 'confirm') continue; // never a selectable wake word on its own (FR-11)
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.pending ? `${m.label} — ⏳` : `${m.label} — ${m.lang}`;
    opt.disabled = !!m.pending;
    modelSel.append(opt);
  }
  const zoo = document.querySelector<HTMLTableSectionElement>('#zoo tbody')!;
  for (const m of models) {
    const tr = document.createElement('tr');
    if (m.pending) tr.className = 'pending';
    const state = document.createElement('span');
    state.className = m.pending ? 'tag-pending' : 'tag-ready';
    state.innerHTML = m.pending
      ? '<span class="en">⏳ training…</span><span class="th">⏳ กำลังเทรน…</span>'
      : '<span class="en">✅ ready</span><span class="th">✅ พร้อมใช้</span>';
    let labelCell: string | HTMLElement = m.label;
    if (m.kind === 'confirm') {
      // Badge, not a row of its own — a 'confirm' head is a pairing, not a pickable wake word.
      const wrap = document.createElement('span');
      wrap.append(m.label);
      const badge = document.createElement('span');
      badge.className = 'tag-confirm';
      badge.innerHTML = '<span class="en">confirmation word</span><span class="th">คำยืนยัน</span>';
      wrap.append(badge);
      labelCell = wrap;
    }
    const cells: (string | HTMLElement)[] = [labelCell, state, m.lang];
    if (m.pending) {
      cells.push('—', '—', m.note ?? '');
    } else {
      const a = document.createElement('a');
      a.href = `/${m.file}`;
      a.download = m.file;
      a.textContent = `⬇ ${m.file}`;
      cells.push(a, m.threshold.toFixed(3), m.note ?? '');
    }
    for (const v of cells) {
      const td = document.createElement('td');
      td.append(v as string | Node);
      tr.append(td);
    }
    zoo.append(tr);
  }
  // Test-results table — same manifest, structured `eval` field per trained head.
  const results = document.querySelector<HTMLTableSectionElement>('#results tbody')!;
  for (const m of models) {
    const tr = document.createElement('tr');
    const cells = m.eval
      ? [m.label, String(m.eval.voices), String(m.eval.posClips),
         `${(m.eval.recall * 100).toFixed(1)}%`, String(m.eval.negClips),
         m.eval.falseFiresPerMin.toFixed(2)]
      : [m.label, '⏳', '—', '—', '—', '—'];
    if (!m.eval) tr.className = 'pending';
    for (const v of cells) {
      const td = document.createElement('td');
      td.textContent = v;
      tr.append(td);
    }
    results.append(tr);
  }
  // restore the wake word picked last session; current() falls back to the first ready head
  modelSel.value = localStorage.getItem('wakekit-model') ?? '';
  confirmChk.checked = localStorage.getItem('wakekit-confirm') === '1';
  syncConfirmRow();
  const ready = current();
  if (ready) {
    modelSel.value = ready.id; // never boot on a disabled (pending) entry
    thr.value = String(ready.threshold);
    thrVal.textContent = ready.threshold.toFixed(3);
    if (IS_TAURI) void start(); // the app is an always-listening tray utility — mic on from launch
  } else {
    // every entry still pending — tables render, live test waits for the first trained head
    toggle.disabled = true;
    setStatus(document.documentElement.lang === 'th' ? 'ทุกโมเดลกำลังเทรน — เร็ว ๆ นี้' : 'all models training — soon');
  }
  draw();
} catch (e) {
  setStatus(`failed to load manifest.json: ${e instanceof Error ? e.message : e}`, 'error');
  toggle.disabled = true;
}

// ---- Download example — models + ort wasm + a runnable vite starter, zipped in the browser.
const dlBtn = $<HTMLButtonElement>('dl-example');
const DL_LABEL = dlBtn.innerHTML;
dlBtn.onclick = async () => {
  dlBtn.disabled = true;
  dlBtn.textContent = document.documentElement.lang === 'th' ? 'กำลังเตรียมไฟล์…' : 'packing…';
  try {
    await downloadExample(models.filter((m) => !m.pending)); // pending heads have no file to pack
  } catch (e) {
    setStatus(`example zip failed: ${e instanceof Error ? e.message : e}`, 'error');
  }
  dlBtn.innerHTML = DL_LABEL;
  dlBtn.disabled = false;
};

// ---- "Beyond the browser" picker — sections parsed out of docs/other-languages.md, so the
// docs stay the single source of truth and a new language there appears here for free. ----
const PORT_FILE: Record<string, string> = {
  python: 'wake.py', js: 'wake.mjs', rust: 'main.rs', go: 'main.go',
  csharp: 'Wake.cs', java: 'Wake.java', cpp: 'wake.cc', swift: 'wake.swift',
};
const ports = [...portsMd.matchAll(/^## (.+?)(?: — .*)?\n[\s\S]*?```(\w+)\n([\s\S]*?)```/gm)]
  .map(([, name, lang, code]) => ({ name, lang, code: code.trimEnd() }))
  .filter((p) => p.lang !== 'bash'); // the pipeline-spec section's ffmpeg block isn't a port

const portSel = $<HTMLSelectElement>('port-lang');
const portCode = $<HTMLElement>('port-code');
const portName = $<HTMLSpanElement>('port-name');
for (const p of ports) {
  const opt = document.createElement('option');
  opt.value = p.lang;
  opt.textContent = p.name;
  portSel.append(opt);
}
const showPort = () => {
  const p = ports.find((x) => x.lang === portSel.value) ?? ports[0];
  portName.textContent = PORT_FILE[p.lang] ?? p.lang;
  portCode.textContent = p.code;
  portCode.className = `language-${p.lang}`;
  portCode.removeAttribute('data-highlighted');
  hljs.highlightElement(portCode);
};
portSel.onchange = showPort;
if (ports.length) showPort();

// static code blocks (the app.ts usage example)
for (const el of document.querySelectorAll<HTMLElement>('pre code[class*="language-"]:not(#port-code)'))
  hljs.highlightElement(el);

// ---- Tauri desktop app — tray toggle + voice-command settings. The web page never runs this,
// and every @tauri-apps import is dynamic so the Vercel bundle stays Tauri-free.
let trayListen: { setText(text: string): Promise<void> } | null = null;
let trayHeader: { setText(text: string): Promise<void> } | null = null;
let tray: { setIcon(icon: unknown): Promise<void> } | null = null;

// The tray flower painted in the state color — green = listening, red = stopped.
async function trayFlower(color: string) {
  const { Image } = await import('@tauri-apps/api/image');
  const S = 44; // 2x for retina menu bars
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const x = c.getContext('2d')!;
  x.translate(S / 2, S / 2);
  x.fillStyle = color;
  for (let i = 0; i < 4; i++) { // 4 lozenges through the center = 8 petals
    x.beginPath();
    x.ellipse(0, 0, S * 0.105, S * 0.46, (i * Math.PI) / 4, 0, Math.PI * 2);
    x.fill();
  }
  x.beginPath();
  x.arc(0, 0, S * 0.17, 0, Math.PI * 2);
  x.fill();
  return Image.new(Array.from(x.getImageData(0, 0, S, S).data), S, S);
}

async function setTrayState(listening: boolean) {
  void trayHeader?.setText(`AI: ${current()?.label ?? '—'}`);
  void trayListen?.setText(listening ? 'Stop listening' : 'Start listening');
  try {
    await tray?.setIcon(await trayFlower(listening ? '#16a34a' : '#ef4444'));
  } catch (e) {
    console.warn('[wakekit demo] tray icon update failed:', e);
  }
}

async function showMainWindow() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const w = getCurrentWindow();
  await w.show();
  await w.unminimize();
  await w.setFocus();
}

async function setupTauri() {
  // Closing the window must hide it, not destroy it: this webview owns the tray logic and the
  // wake engine — destroy it and the tray menu turns into dead buttons ("Quit" still works,
  // it's native). The app lives in the tray; reopen via any tray item.
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  void getCurrentWindow().onCloseRequested((e) => {
    e.preventDefault();
    void getCurrentWindow().hide();
  });

  const { TrayIcon } = await import('@tauri-apps/api/tray');
  const { Menu, MenuItem, CheckMenuItem, Submenu, PredefinedMenuItem } = await import('@tauri-apps/api/menu');

  // Mic picker submenu — starts with just "System default" and fills in asynchronously LATER:
  // enumerating labels needs mic permission, and awaiting getUserMedia here would park the whole
  // tray behind an unanswered permission prompt (measured: no tray icon at all until Allow).
  const savedMic = localStorage.getItem(MIC_KEY) ?? '';
  const micRefs: Array<{ label: string; item: { setChecked(c: boolean): Promise<void> } }> = [];
  const pickMic = async (label: string) => {
    if (label) localStorage.setItem(MIC_KEY, label);
    else localStorage.removeItem(MIC_KEY);
    for (const r of micRefs) void r.item.setChecked(r.label === label);
    if (kit) { await stop(); await start(); } // apply to a live session immediately
  };
  const micMenu = await Submenu.new({ text: 'Microphone', items: [] });
  const addMicItem = async (label: string) => {
    const item = await CheckMenuItem.new({
      text: label || 'System default',
      checked: label === savedMic,
      action: () => void pickMic(label),
    });
    micRefs.push({ label, item });
    await micMenu.append(item);
  };
  await addMicItem('');

  // Card opacity — 50 % you can read the desktop through, 100 % solid. Pushed live so the cards
  // already on screen change as you pick, and stored so the next one opens the same way.
  const savedOpacity = Number(localStorage.getItem(OPACITY_KEY) ?? 100);
  const opacityRefs: Array<{ pct: number; item: { setChecked(c: boolean): Promise<void> } }> = [];
  const opacityMenu = await Submenu.new({ text: 'Card opacity', items: [] });
  for (const pct of OPACITIES) {
    const item = await CheckMenuItem.new({
      text: pct === 100 ? '100% (solid)' : `${pct}%`,
      checked: pct === savedOpacity,
      action: () => void (async () => {
        localStorage.setItem(OPACITY_KEY, String(pct));
        for (const r of opacityRefs) void r.item.setChecked(r.pct === pct);
        (await import('@tauri-apps/api/event')).emit('opacity', pct);
      })(),
    });
    opacityRefs.push({ pct, item });
    await opacityMenu.append(item);
  }

  // How many stories "…ข่าว" opens. Read at command time, so no live push needed.
  const savedCount = Number(localStorage.getItem(NEWS_N_KEY) ?? 5);
  const countRefs: Array<{ n: number; item: { setChecked(c: boolean): Promise<void> } }> = [];
  const countMenu = await Submenu.new({ text: 'News stories', items: [] });
  for (const n of NEWS_COUNTS) {
    const item = await CheckMenuItem.new({
      text: `${n}`,
      checked: n === savedCount,
      action: () => {
        localStorage.setItem(NEWS_N_KEY, String(n));
        for (const r of countRefs) void r.item.setChecked(r.n === n);
      },
    });
    countRefs.push({ n, item });
    await countMenu.append(item);
  }

  // header row: which persona this tray belongs to — disabled, it's a label not a button
  const header = await MenuItem.new({ text: `AI: ${current()?.label ?? '—'}`, enabled: false });
  trayHeader = header;
  // state lives in the tray icon color (green = listening, red = stopped) — no checkbox
  const listen = await MenuItem.new({
    text: kit ? 'Stop listening' : 'Start listening',
    // toggling on surfaces the window first: the mic permission prompt and any start error
    // are invisible while the app sits behind other apps
    action: () => { if (kit) void stop(); else { void showMainWindow(); void start(); } },
  });
  trayListen = listen;
  const menu = await Menu.new({
    items: [
      header,
      await PredefinedMenuItem.new({ item: 'Separator' }),
      listen,
      micMenu,
      opacityMenu,
      countMenu,
      await MenuItem.new({ text: 'Voice commands…', action: () => void openCmdWindow() }),
      await PredefinedMenuItem.new({ item: 'Separator' }),
      await PredefinedMenuItem.new({ item: 'Quit', text: 'Quit' }),
    ],
  });
  tray = await TrayIcon.new({ icon: await trayFlower(kit ? '#16a34a' : '#ef4444'), menu, tooltip: 'wakekit' });
  void setTrayState(!!kit); // auto-start may have finished before the tray existed — sync once

  // Now (tray already up) prime mic permission and fill in the device list when it resolves.
  void (async () => {
    try {
      (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((t) => t.stop());
    } catch { /* denied — the submenu keeps just System default */ }
    const inputs = (await navigator.mediaDevices.enumerateDevices())
      .filter((d) => d.kind === 'audioinput' && d.label);
    for (const d of inputs) await addMicItem(d.label);
  })();

  // The commands window owns the list; take its edits live so a new command works without a restart.
  const { listen: onEvent } = await import('@tauri-apps/api/event');
  void onEvent<VoiceCmd[]>('cmds-changed', (e) => { voiceCmds = e.payload; });

  // The Siri-style listening strip: created hidden once, shown/updated via events (demo/overlay.ts).
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  new WebviewWindow('overlay', {
    url: 'overlay.html',
    width: 480,
    height: 76,
    visible: false,
    transparent: true,
    decorations: false,
    shadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focus: false,
    resizable: false,
    visibleOnAllWorkspaces: true,
  });

  // The result card (demo/pip.ts). Created hidden at startup, not on the first result: Tauri events
  // are not buffered, so the window has to be listening before anything is emitted to it.
  new WebviewWindow('pip', {
    url: 'pip.html',
    width: 380,
    height: 240,
    visible: false,
    transparent: true,
    decorations: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    visibleOnAllWorkspaces: true,
    focus: false,
    focusable: false, // clickable, but never becomes key — your typing stays in the app you were in
    acceptFirstMouse: true, // ...so the first click acts on the control instead of just waking it
    resizable: false,
    // No windowEffects: the native material can only be rounded through a private setCornerRadius:
    // that no longer takes on this macOS, so it drew a square slab behind our rounded card. The
    // page paints its own translucent background instead — real rounded corners, no blur.
    shadow: false, // ...and the window shadow would trace that square too
    theme: 'dark',
  });
}
if (IS_TAURI) void setupTauri();

// Drive a command without speaking: `wk.handleCommand('เปิดเพลง lada')` in the devtools console.
if (import.meta.env.DEV) (window as unknown as { wk: unknown }).wk = { handleCommand, showPip };

// The commands window (demo/commands.ts) is a window of its own, not a dialog in this webview.
// It's created once and hides on close, so the handle stays valid — reopening is show + focus.
let cmdWin: { show(): Promise<void>; setFocus(): Promise<void> } | null = null;
async function openCmdWindow() {
  if (cmdWin) { await cmdWin.show(); await cmdWin.setFocus(); return; }
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  cmdWin = new WebviewWindow('commands', {
    url: 'commands.html',
    title: 'คำสั่งเสียง / Voice commands',
    width: 420,
    height: 540,
    // a macOS widget panel: no chrome, its rounded translucent background painted by the page
    // itself (see the note on the pip window — the native material can't be rounded any more)
    transparent: true,
    decorations: false,
    shadow: false,
    theme: 'dark', // keeps native bits (select popups, scrollbars) dark like the panel
  });
}


// ---- Hero portrait — จาร์วิส first, then ละดา, crossfading in a loop.
const HERO = [
  { src: jarvisJpg, name: 'จาร์วิส' },
  { src: ladaJpg, name: 'ละดา' },
];
{
  const fig = document.querySelector<HTMLElement>('figure.lada');
  const img = fig?.querySelector('img');
  if (fig && img) {
    const capEn = fig.querySelector('.en')!;
    const capTh = fig.querySelector('.th')!;
    let i = 0;
    const show = (h: (typeof HERO)[number]) => {
      img.src = h.src;
      img.alt = h.name;
      capEn.textContent = `${h.name} — wakekit`;
      capTh.textContent = `${h.name} — wake word`;
    };
    show(HERO[0]); // index.html ships จาร์วิส too — this swaps in the hashed bundle URL
    setInterval(() => {
      img.style.opacity = '0';
      setTimeout(() => { i = (i + 1) % HERO.length; show(HERO[i]); img.style.opacity = '1'; }, 500);
    }, 6000);
  }
}
