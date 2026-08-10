// demo/pip.ts — the floating result card. The main window emits 'pip' with a payload; this window
// renders it, sizes itself to the content and shows itself top-right, always on top. It is
// interactive (no setIgnoreCursorEvents, unlike the overlay strip) but created `focusable: false`,
// so clicking it never takes the keyboard away from whatever you were typing in.
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWindow, currentMonitor, LogicalSize, PhysicalPosition } from '@tauri-apps/api/window';
import { OPACITY_KEY, resultUrl, wmo, type Pip } from './builtins';

const IS_TAURI = '__TAURI_INTERNALS__' in window;
const win = () => getCurrentWindow();

// A news window is one of five spawned per command, so it carries its story in its own URL rather
// than waiting for an event: it is created after the fact, and an event fired at creation time
// would arrive before it could listen. It is also a fixed tile and destroys itself on ✕.
const params = new URLSearchParams(location.search);
const NEWS = params.get('kind') === 'news';

document.documentElement.lang = localStorage.getItem('wakekit-lang') ?? 'en';
const TH = document.documentElement.lang === 'th';
const L = (en: string, th: string) => (TH ? th : en);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const SECTIONS = ['weather', 'video', 'search', 'news', 'text', 'fail'] as const;
const player = $('video').querySelector('video')!;

// Stopping playback needs both: dropping the src alone leaves the decoded audio running for a beat.
function stopPlayer() {
  player.pause();
  player.removeAttribute('src');
  player.load();
}

let current: Pip | null = null;

async function openExternal(url: string) {
  if (IS_TAURI) void (await import('@tauri-apps/plugin-opener')).openUrl(url);
  else window.open(url, '_blank');
}

// Only one section is ever on screen. Stopping the player here is what keeps a replaced card from
// going on playing audio — the same reason the ✕ and the close handler stop it too.
function show(kind: (typeof SECTIONS)[number], title: string) {
  if (kind !== 'video') stopPlayer();
  for (const s of SECTIONS) $(s).hidden = s !== kind;
  $('title').textContent = title;
  void fit();
}

function fail(title: string, msg?: string) {
  show('fail', title);
  if (msg) $('fail').querySelector('p')!.textContent = msg;
  void fit();
}

// A widget is exactly as tall as its content; the window has no chrome to hide slack.
// A news window sizes itself to its story and tells the main window how tall it ended up, so the
// next one in the column is placed under it instead of on top of it.
async function report() {
  if (!IS_TAURI) return;
  await fit();
  await emit('news-h', { i: Number(params.get('i') ?? 0), h: Math.ceil(document.body.scrollHeight) });
}

async function fit() {
  if (!IS_TAURI) return;
  await new Promise(requestAnimationFrame); // let the new section lay out first
  // Keep whatever width this window was created with — the news windows are narrower than the
  // result card, and hardcoding one width here made them overlap the neighbour they tile against.
  await win().setSize(new LogicalSize(window.innerWidth, Math.ceil(document.body.scrollHeight)));
}

// Top-right of the current monitor, under the menu bar — the macOS widget-stack spot, and clear of
// the listening strip at bottom-centre. Placed once: after that the card stays where you drag it.
let placed = false;
async function place() {
  if (!IS_TAURI || placed) return;
  const mon = await currentMonitor();
  if (!mon) return;
  const size = await win().outerSize();
  await win().setPosition(new PhysicalPosition(
    Math.round(mon.position.x + mon.size.width - size.width - 16 * mon.scaleFactor),
    Math.round(mon.position.y + 40 * mon.scaleFactor),
  ));
  placed = true;
}

async function render(p: Pip) {
  current = p;
  switch (p.kind) {
    case 'weather': return weather(p.place);
    case 'video':
      if (!p.src) return fail(p.q, L("Couldn't play that here.", 'เล่นในการ์ดไม่ได้'));
      show('video', p.title || p.q);
      player.src = p.src;
      void player.play().catch(() => { /* user gesture policy in a plain browser — controls are there */ });
      return void fit();
    case 'search': {
      if (!p.results?.length) return fail(p.q, L('No results.', 'ไม่พบผลการค้นหา'));
      show('search', p.q);
      $('search').replaceChildren(...p.results.map((r) => {
        const a = document.createElement('a');
        const b = document.createElement('b');
        b.textContent = r.title;
        const i = document.createElement('i');
        i.textContent = r.snippet;
        a.append(b, i);
        a.onclick = () => void openExternal(r.url);
        return a;
      }));
      return void fit();
    }
    case 'news': {
      if (!p.item) return fail(p.q, L('No news found.', 'ไม่พบข่าว'));
      const { title, source, url, iso, img } = p.item;
      show('news', p.q ? `📰 ${p.q}` : '📰');
      $('news-title').textContent = title;
      $('news-meta').textContent = [source, since(iso)].filter(Boolean).join(' · ');
      // Both the card and the little ↗ open the story; openUrl with no app named hands it to
      // whatever the system calls the default browser.
      $('news').onclick = () => void openExternal(url);
      $('news-open').onclick = (e) => { e.stopPropagation(); void openExternal(url); };
      const cover = $<HTMLImageElement>('news-img');
      if (img) {
        // The height is measured after this settles either way, so both paths end in report().
        cover.onload = () => { cover.hidden = false; void report(); };
        cover.onerror = () => { cover.hidden = true; void report(); }; // hotlink blocked → text only
        cover.src = img;
      } else {
        cover.hidden = true;
        void report();
      }
      return;
    }
    case 'text':
      show('text', p.title);
      $('text').textContent = p.body;
      return void fit();
  }
}

// "3 ชม." — the feed gives an RFC-822 date, the card wants how long ago that was.
function since(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.round(ms / 60000);
  if (m < 60) return L(`${m}m ago`, `${m} นาทีที่แล้ว`);
  const h = Math.round(m / 60);
  if (h < 24) return L(`${h}h ago`, `${h} ชม.ที่แล้ว`);
  return L(`${Math.round(h / 24)}d ago`, `${Math.round(h / 24)} วันที่แล้ว`);
}

// ---- Weather. Open-Meteo needs no key and allows cross-origin reads, so this window fetches it
// itself — no shell, no plugin, and it works in a plain browser preview too.
async function weather(place: string) {
  show('weather', L('Weather', 'สภาพอากาศ'));
  $('wx-place').textContent = place || L('Here', 'ตำแหน่งปัจจุบัน');
  $('wx-temp').textContent = '…';
  $('wx-cond').textContent = '';
  $('wx-hours').replaceChildren();
  try {
    const spot = await geocode(place);
    if (!spot) return fail(L('Weather', 'สภาพอากาศ'), L(`Can't find "${place}".`, `ไม่พบเมือง “${place}”`));
    const r = await fetch('https://api.open-meteo.com/v1/forecast'
      + `?latitude=${spot.latitude}&longitude=${spot.longitude}&timezone=auto`
      + '&current=temperature_2m,weather_code&hourly=temperature_2m,weather_code&forecast_hours=4');
    const w = await r.json();
    const now = wmo(w.current.weather_code);
    $('wx-place').textContent = spot.name;
    $('wx-temp').textContent = `${Math.round(w.current.temperature_2m)}°`;
    $('wx-cond').textContent = `${now.icon} ${L(now.en, now.th)}`;
    $('wx-hours').replaceChildren(...(w.hourly?.time ?? []).slice(1, 4).map((t: string, i: number) => {
      const code = wmo(w.hourly.weather_code[i + 1]);
      const el = document.createElement('div');
      el.innerHTML = `<span class="ic">${code.icon}</span><b>${Math.round(w.hourly.temperature_2m[i + 1])}°</b>`;
      el.prepend(t.slice(11, 16)); // 'YYYY-MM-DDTHH:MM' → 'HH:MM'
      return el;
    }));
    void fit();
  } catch {
    fail(L('Weather', 'สภาพอากาศ'), L('Offline.', 'ออฟไลน์'));
  }
}

// STT hands us everything after the keyword ("กรุงเทพ เป็นไงบ้าง"), so a miss retries with just the
// first word before giving up. An empty place means "wherever I am" — Bangkok is the app's home.
// `language` picks which name index is searched, so it follows the SCRIPT of what was said, not the
// UI language: "เชียงใหม่" is simply absent from the English index (verified — it returns nothing).
async function geocode(place: string): Promise<{ name: string; latitude: number; longitude: number } | null> {
  const first = place.trim() || 'กรุงเทพ';
  const langs = /[฀-๿]/.test(first) ? ['th', 'en'] : ['en', 'th'];
  for (const q of [first, first.split(/\s+/)[0]]) {
    for (const lang of langs) {
      const r = await fetch('https://geocoding-api.open-meteo.com/v1/search'
        + `?name=${encodeURIComponent(q)}&count=1&language=${lang}&format=json`);
      const hit = (await r.json()).results?.[0];
      if (hit) return hit;
    }
    if (q === first.split(/\s+/)[0]) break; // one word only — the retry would repeat it
  }
  return null;
}

// 50 = see through it, 100 = solid. Applied to the whole panel, which is what "window opacity"
// means everywhere else; set from the tray and pushed live to every open card.
const setOpacity = (pct: number) => { $('panel').style.opacity = String(Math.min(100, Math.max(50, pct)) / 100); };
setOpacity(Number(localStorage.getItem(OPACITY_KEY) ?? 100));

$('close').onclick = () => {
  stopPlayer(); // stop the audio, not just the window
  if (!IS_TAURI) return;
  void (NEWS ? win().close() : win().hide());
};

if (IS_TAURI) {
  if (!NEWS) void win().onCloseRequested((e) => { e.preventDefault(); stopPlayer(); void win().hide(); });
  $('open-browser').onclick = () => { if (current) void openExternal(resultUrl(current)); };
  void listen<number>('opacity', (e) => setOpacity(e.payload));
  if (NEWS) {
    void render({
      kind: 'news',
      q: params.get('q') ?? '',
      item: {
        title: params.get('title') ?? '',
        source: params.get('source') ?? '',
        url: params.get('url') ?? '',
        iso: params.get('iso') ?? '',
        img: params.get('img') ?? undefined,
      },
    });
  } else {
    void listen<Pip>('pip', async (e) => {
      await render(e.payload);
      await place();
      await win().show();
    });
  }
} else {
  // Browser preview: /pip.html?kind=weather&place=เชียงใหม่ — every card renders without the app.
  const q = new URLSearchParams(location.search);
  const kind = q.get('kind') ?? 'weather';
  $('open-browser').onclick = () => { if (current) void openExternal(resultUrl(current)); };
  void render(
    kind === 'video' ? { kind: 'video', q: q.get('q') ?? '', src: q.get('src') ?? undefined, title: q.get('title') ?? undefined }
      : kind === 'search' ? { kind: 'search', q: q.get('q') ?? 'test', results: [{ title: 'A result', url: 'https://example.com', snippet: 'A snippet that is long enough to wrap onto a second line so the clamp shows.' }] }
        : kind === 'text' ? { kind: 'text', title: q.get('title') ?? 'claude', body: q.get('body') ?? 'reply' }
          : { kind: 'weather', place: q.get('place') ?? 'กรุงเทพ' },
  );
}
