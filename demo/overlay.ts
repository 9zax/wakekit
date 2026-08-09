// demo/overlay.ts — the Tauri app's Siri-style "Listening" strip: a frameless, transparent,
// click-through window pinned above every app. The main window drives it with two events:
// 'overlay-show' (wake fired) and 'overlay-text' (live caption / command feedback). It hides
// itself 5s after the last update — same rhythm as the in-page stt toast.
import { getCurrentWindow, currentMonitor, PhysicalPosition } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { MODE_DRAWS, resolvePreset } from 'thinking-orbs';

const win = getCurrentWindow();
void win.setIgnoreCursorEvents(true); // never steal a click from the app underneath

const cap = document.getElementById('cap') as HTMLSpanElement;
const LISTENING = 'Listening… / กำลังฟัง';

// Same pure-canvas orb as the in-page wake pill, white ink on the dark strip.
const orb = document.getElementById('orb') as HTMLCanvasElement;
const ORB_SIZE = 64; // the lib's big preset; CSS displays it at 44px
let level = 0; // target mic level from the main window, 0..1
let bounce = 0; // smoothed level actually painted
{
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  orb.width = orb.height = ORB_SIZE * dpr;
  const ctx = orb.getContext('2d')!;
  const { mode, speed, opts } = resolvePreset('listening', ORB_SIZE);
  const paint = (t: number) => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, ORB_SIZE, ORB_SIZE);
    MODE_DRAWS[mode](ctx, ORB_SIZE, t, true, opts); // dark strip → light ink
  };
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) paint(0.6);
  else requestAnimationFrame(function tick() {
    bounce += (level - bounce) * 0.35; // fast attack, soft decay — reads as bouncing with speech
    orb.style.transform = `scale(${(1 + bounce * 0.7).toFixed(3)})`;
    paint((performance.now() / 1000) * speed * (1 + bounce * 2)); // louder voice → livelier orb
    requestAnimationFrame(tick);
  });
}

// Bottom-center of whatever monitor the window is on, a little above the Dock.
async function place() {
  const mon = await currentMonitor();
  if (!mon) return;
  const size = await win.outerSize();
  const x = Math.round(mon.position.x + (mon.size.width - size.width) / 2);
  const y = Math.round(mon.position.y + mon.size.height - size.height - 96 * mon.scaleFactor);
  await win.setPosition(new PhysicalPosition(x, y));
}

let hideTimer = 0;
async function show(text: string) {
  cap.textContent = text;
  clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => void win.hide(), 5000);
  await place();
  await win.show();
}

void listen('overlay-show', () => void show(LISTENING));
void listen<string>('overlay-text', (e) => void show(e.payload || LISTENING));
void listen<number>('overlay-level', (e) => { level = e.payload; });
