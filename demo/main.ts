// demo/main.ts — the wakekit test page. Everything on-page comes from models/manifest.json, so a
// new wake word (อีดี, jarvis, …) appears in the picker and the table without touching this file.
import { WakeKit, listenMic, loadManifest, type WakeModel } from '../src/index';

// absolute base of wherever the page is mounted ('/' locally, '/wakekit/' on GitHub Pages) —
// worker-side fetches resolve against the worker's URL, so relative paths would break there.
const BASE = new URL('.', location.href).pathname;
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

let models: WakeModel[] = [];
let kit: WakeKit | null = null;
let stopMic: (() => void) | null = null;
let hitCount = 0;
let startedAt = 0;

// Rolling score trace — last 30 s at 12.5 scores/s.
const TRACE_LEN = 375;
const trace: number[] = [];
const hitMarks: number[] = []; // trace indices where a detection fired

// undefined when every manifest entry is still pending — the page must survive that.
const current = () =>
  models.find((m) => m.id === modelSel.value && !m.pending) ?? models.find((m) => !m.pending);

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
  // The ack plays a recorded voice out loud, and dictation listens afterward — ignore hits during
  // either, or the demo wakes itself (or re-dictates its own speech) in a loop.
  if ((curAudio && !curAudio.paused && !curAudio.ended) || dictating) return;
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
  curAudio?.pause();
}

function showWakePill() {
  pillText.textContent = current()?.label ?? '';
  pill.hidden = false; // display:none → block replays the slide-in animation
  startOrb();
  clearTimeout(pillTimer);
  // Dictation starts at the hit, concurrent with the ack: Chrome's capture takes 2-6s to open
  // (measured audiostart latency), so starting now means it's ready right as the ack ends — and
  // the ack is this page's own audio output, which the recognizer's echo cancellation removes.
  startDictation();
  speakAck();
}

// ---- Voice ack — a pre-recorded voice from static/voices answers the wake word (bundled by
// Vite, since publicDir is 'models'). While it talks the orb flips to the lib's 'working'
// variant and the pill stays up until the clip ends. Shuffle-bag draw: every clip plays once
// before any repeats, and the same clip never plays twice in a row.
// One clip set per persona gender (manifest `gender`) — จาร์วิส answers in a male voice, ละดา
// in a female one. Unknown/missing gender falls back to female, the original set.
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

// The ack is done (or never happened). If dictation is still listening, the pill stays up as its
// "Listening…" indicator — endDictation hides it; otherwise hide now (pre-STT behavior).
function ackDone() {
  if (rec) startOrb('listening');
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
    // (A timer here would cut clips longer than PILL_MS mid-sentence.)
    startOrb('working');
  };
  a.onended = a.onerror = () => { if (a === curAudio) ackDone(); };
  curAudio?.pause(); // a re-wake mid-clip starts the new ack clean
  curAudio = a;
  a.play().catch(() => { if (a === curAudio) ackDone(); }); // autoplay blocked — no play/ended/error otherwise fires
}

// ---- Speech-to-text — Chrome/Edge's own SpeechRecognition, th-TH, one session per wake. Demo
// only: unlike wake detection this sends audio to the browser's speech service, which is why
// index.html discloses it separately and it never touches src/. spec: 2026-08-09-wake-to-thai-stt.
const sttPrivacy = $<HTMLParagraphElement>('stt-privacy');
const sttUnsupportedEl = $<HTMLParagraphElement>('stt-unsupported');
const sttPanel = $<HTMLDivElement>('stt');
const sttState = $<HTMLDivElement>('stt-state');
const sttLinesEl = $<HTMLOListElement>('stt-lines');

const sttSupported = () => !!(window.SpeechRecognition ?? window.webkitSpeechRecognition);

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

function setSttState(text: string, cls = '') {
  sttState.textContent = text;
  sttState.className = `stt-state ${cls}`;
}

function sttErrorLabel(code: string): string {
  if (code === 'no-speech') return L('sttNoSpeech');
  if (code === 'network') return L('sttNetwork');
  if (code === 'not-allowed' || code === 'service-not-allowed') return L('sttMic');
  if (code === 'no-service') return L('sttNoService'); // our watchdog, not a Chrome code
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

function renderInterim(text: string) {
  interimLi.textContent = text; // Thai interims revise earlier chars — always repaint whole, never append
  ensureSttEmptyState();
}

function addFinal(text: string) {
  const t = text.trim(); // trims edges only — Thai has no inter-word spaces to split on
  if (!t) return;
  finals.unshift(t);
  const li = document.createElement('li');
  li.textContent = t;
  interimLi.after(li); // newest first, right after the (now-empty) interim slot
  if (finals.length > STT_CAP) {
    finals.pop();
    sttLinesEl.lastElementChild?.remove();
  }
  ensureSttEmptyState();
}

function resetSttPanel() {
  finals.length = 0;
  interimLi.textContent = '';
  for (const li of [...sttLinesEl.querySelectorAll('li:not(.interim)')]) li.remove();
  ensureSttEmptyState();
  setSttState('', '');
}

function startDictation() {
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

function abortDictation() {
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
  try {
    kit = await WakeKit.load({
      base: BASE,
      model: { file: m.file, threshold: Number(thr.value) },
      verbose: true,
      onScore,
      onHit,
      onError: (msg) => { setStatus(`worker error: ${msg}`, 'error'); void stop(); },
    });
    stopMic = await listenMic(kit);
    startedAt = performance.now();
    setStatus(`${L('listening')} — ${m.label} @ ${Number(thr.value).toFixed(3)}`, 'live');
    toggle.textContent = L('stop');
    toggle.classList.add('stop');
  } catch (e) {
    kit?.dispose(); kit = null;
    setStatus(e instanceof Error ? e.message : String(e), 'error');
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
}

toggle.onclick = () => (kit ? void stop() : void start());

thr.oninput = () => {
  thrVal.textContent = Number(thr.value).toFixed(3);
  kit?.configure({ threshold: Number(thr.value) });
  if (kit) setStatus(`${L('listening')} — ${current()?.label ?? ''} @ ${Number(thr.value).toFixed(3)}`, 'live');
  draw();
};

modelSel.onchange = async () => {
  const m = current();
  if (!m) return;
  thr.value = String(m.threshold); // each head ships its own measured bar
  thrVal.textContent = m.threshold.toFixed(3);
  if (kit) { await stop(); await start(); } // hot-swap: reload with the new head
  draw();
};

// ---- boot ----
try {
  models = await loadManifest(BASE);
  for (const m of models) {
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
    const cells: (string | HTMLElement)[] = [m.label, state, m.lang];
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
  const ready = current();
  if (ready) {
    modelSel.value = ready.id; // never boot on a disabled (pending) entry
    thr.value = String(ready.threshold);
    thrVal.textContent = ready.threshold.toFixed(3);
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
