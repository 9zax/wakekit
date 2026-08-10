// demo/commands.ts — the Tauri app's "Voice commands" window: a real window of its own, opened
// from the tray, not a dialog inside the main webview. It owns the command list; the main window
// gets the new list pushed to it over 'cmds-changed' (localStorage is only the on-disk copy, each
// window reads it once at startup).
import { emit } from '@tauri-apps/api/event';
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
import { BUILTIN, CMDS_KEY, cmdDest, loadCmds, OPACITY_KEY, type VoiceCmd } from './builtins';

// Every @tauri-apps call is behind this so the page also renders in a plain browser (`npm run
// dev` → /commands.html), which is the only way to eyeball the layout without a rebuild.
const IS_TAURI = '__TAURI_INTERNALS__' in window;

// Closing must hide, not destroy: the main window keeps a handle to this one and reopens it by
// show() — a destroyed window would leave the tray item pointing at nothing. The window has no
// title bar (it's a translucent widget panel), so ✕ is ours.
if (IS_TAURI) void getCurrentWindow().onCloseRequested((e) => { e.preventDefault(); void getCurrentWindow().hide(); });
document.getElementById('close')!.onclick = () => { if (IS_TAURI) void getCurrentWindow().hide(); };

// Same tray-set opacity the result cards use — 50 % see-through, 100 % solid.
const setOpacity = (pct: number) => {
  document.getElementById('panel')!.style.opacity = String(Math.min(100, Math.max(50, pct)) / 100);
};
setOpacity(Number(localStorage.getItem(OPACITY_KEY) ?? 100));
if (IS_TAURI) void import('@tauri-apps/api/event').then(({ listen }) => listen<number>('opacity', (e) => setOpacity(e.payload)));

document.documentElement.lang = localStorage.getItem('wakekit-lang') ?? 'en'; // style.css toggles .en/.th off this
const TH = document.documentElement.lang === 'th';

let cmds = loadCmds();
function save() {
  localStorage.setItem(CMDS_KEY, JSON.stringify(cmds));
  if (IS_TAURI) void emit('cmds-changed', cmds); // the main window matches against its own copy
  render();
}

// One row of the cheat sheet: the phrase on the left, where it goes on the right.
function row(say: string, does: string, del?: () => void) {
  const li = document.createElement('li');
  const wrap = document.createElement('span');
  const b = document.createElement('b');
  b.textContent = say;
  const i = document.createElement('i');
  i.textContent = does;
  wrap.append(b, i);
  li.append(wrap);
  if (del) {
    const x = document.createElement('button');
    x.textContent = '✕';
    x.title = 'delete / ลบ';
    x.onclick = del;
    li.append(x);
  }
  return li;
}

// A widget is exactly as tall as its content — the window has no chrome to hide slack, and the
// list grows and shrinks as commands come and go.
function fit() {
  if (IS_TAURI) void getCurrentWindow().setSize(new LogicalSize(420, Math.ceil(document.body.scrollHeight)));
}

function render() {
  const list = document.getElementById('cmd-list')!;
  list.replaceChildren(...cmds.map((c, i) => row(
    `${c.word.split(',')[0].trim()} …`,
    c.match === 'include' ? `${cmdDest(c)} (${TH ? 'คำนี้อยู่ตรงไหนก็ได้' : 'anywhere in the line'})` : cmdDest(c),
    () => { cmds.splice(i, 1); save(); },
  )));
  if (!cmds.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = TH ? 'ยังไม่มีคำสั่ง' : 'no commands yet';
    list.append(li);
  }
  fit();
}

document.getElementById('cmd-builtin')!.replaceChildren(...BUILTIN.map((b) => row(b.say, b.does)));
render();

const addForm = document.getElementById('cmd-add') as HTMLFormElement;
addForm.onsubmit = (e) => {
  e.preventDefault();
  const fd = new FormData(addForm);
  const type = String(fd.get('type'));
  cmds.push({
    word: String(fd.get('word')).trim(),
    match: fd.get('match') === 'include' ? 'include' : 'prefix',
    type: (['chrome', 'youtube'].includes(type) ? type : 'claude') as VoiceCmd['type'],
    prompt: String(fd.get('prompt')).trim(),
  });
  save();
  addForm.reset();
};

// Which wake word this list belongs to — same pick as the main window (manifest + saved choice),
// read straight from the manifest so this window pulls in none of the engine.
void (async () => {
  const el = document.getElementById('cmd-wake')!;
  let name = '—';
  try {
    const models: Array<{ id: string; label: string; pending?: boolean }> =
      await (await fetch(new URL('manifest.json', location.href))).json();
    const want = localStorage.getItem('wakekit-model');
    name = (models.find((m) => m.id === want && !m.pending) ?? models.find((m) => !m.pending))?.label ?? '—';
  } catch { /* offline/missing manifest — the heading just says '—' */ }
  el.textContent = TH
    ? `พูด “${name}” รอเสียงตอบรับ แล้วพูดคำสั่งต่อไปนี้`
    : `Say “${name}”, wait for the chime, then say one of these:`;
  fit(); // a long name can wrap to a second line
})();
