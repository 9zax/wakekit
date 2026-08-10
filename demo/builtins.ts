// demo/builtins.ts — the phrases that work out of the box, the matcher both kinds of command share,
// and the pure parsers that turn a fetched page into a card. main.ts matches and runs them,
// commands.ts lists them, pip.ts renders them; nothing here may import from main.ts (it must stay
// DOM-free so builtins.test.ts can run it in node).

export type Match = { word: string; match: 'prefix' | 'include' };

// `word` may hold comma-separated aliases; Thai recognizers insert spaces unpredictably, so each
// alias matches with optional whitespace between its characters ('^'-anchored for prefix).
// Returns the text AFTER the match — the command's argument — or null when nothing matches.
export function flexMatch(t: string, c: Match): string | null {
  for (const alias of c.word.split(',').map((w) => w.replace(/\s+/g, '')).filter(Boolean)) {
    const re = new RegExp((c.match === 'include' ? '' : '^') +
      alias.split('').map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*'));
    const m = re.exec(t);
    if (m) return t.slice(m.index + m[0].length).trim();
  }
  return null;
}

// What a command produces. The main window fills in the parts that need the network (`id`/`title`
// for a video, `results` for a search) before pushing it to the pip window; pip.ts fetches its own
// weather because Open-Meteo allows cross-origin reads and the window needs no permission for it.
export type NewsItem = { title: string; source: string; url: string; iso: string; img?: string };

export type Pip =
  | { kind: 'weather'; place: string }
  | { kind: 'video'; q: string; src?: string; title?: string } // src = a direct stream, played in our own <video>
  | { kind: 'news'; q: string; item?: NewsItem } // one window per item — main fans them out

  | { kind: 'search'; q: string; results?: Array<{ title: string; url: string; snippet: string }> }
  | { kind: 'text'; title: string; body: string };

// Where the browser would have gone: the website (which has no pip window), every failed lookup,
// and the card's own "open in browser" button all fall back to this.
export function resultUrl(p: Pip): string {
  const q = (s: string) => encodeURIComponent(s);
  switch (p.kind) {
    case 'video': return `https://www.youtube.com/results?search_query=${q(p.q)}`;
    case 'weather': return `https://www.google.com/search?q=${q(`สภาพอากาศ ${p.place}`.trim())}`;
    case 'search': return `https://www.google.com/search?q=${q(p.q)}`;
    // the feed URL would make a browser download the RSS rather than show the page
    case 'news': return p.item?.url ?? newsFeed(p.q).replace('&format=RSS', '');
    case 'text': return ''; // a claude reply has no page behind it
  }
}

// Bing's news RSS, not Google's. Google News hides every article behind an encrypted redirect, so
// there is no publisher page to take a cover image from — its own page only ever yields the
// generic Google News logo. Bing puts the real article URL in the link, which is what makes a real
// cover possible. Cost: it returns fewer Thai items, so the caller tops up from the world market.
// sortbydate: without it the feed happily returns a two-year-old article as today's news.
export const newsFeed = (q: string, mkt = 'th-TH') =>
  `https://www.bing.com/news/search?q=${encodeURIComponent(q || 'ข่าววันนี้')}`
  + `&format=RSS&setmkt=${mkt}&qft=sortbydate%3d%221%22`;

// How many stories one command opens. More than the market has to offer just opens fewer.
export const NEWS_N_KEY = 'wakekit-news-n';
export const NEWS_COUNTS = [5, 10, 15, 20];
// Thai first, then the English markets in turn — one market rarely fills a 20-story ask alone.
export const NEWS_MARKETS = ['th-TH', 'en-US', 'en-GB', 'en-AU', 'en-IN', 'en-CA'];

// All built-ins match 'include': a wake-word utterance rarely starts with the keyword
// ("จาร์วิส ช่วยเปิดเพลง … หน่อย").
export type Builtin = Match & {
  say: string; // how the phrase reads in the commands window
  does: string; // where it ends up
  needsArg?: boolean; // no argument, no action ("เปิดเพลง" alone would search YouTube for nothing)
  run(arg: string): Pip;
  toast(arg: string): string;
};

export const BUILTIN: Builtin[] = [
  {
    word: 'เพลง',
    match: 'include',
    needsArg: true,
    say: '…เพลง <ชื่อเพลง>',
    does: 'YouTube',
    run: (song) => ({ kind: 'video', q: song }),
    toast: (song) => `▶ ${song}`,
  },
  {
    word: 'ข่าว',
    match: 'include',
    say: '…ข่าว <เรื่อง>', // topic optional — bare "ข่าว" is today's headlines
    does: 'Google News ×5',
    run: (topic) => ({ kind: 'news', q: topic }),
    toast: (topic) => `📰 ${topic || 'ข่าววันนี้'}`,
  },
  {
    // ponytail: plain substring, so "บรรยากาศ" also fires. Give flexMatch a `not` list if that
    // ever bites — a real utterance to the assistant almost never contains it.
    word: 'อากาศ',
    match: 'include',
    say: '…อากาศ <เมือง>', // city optional — bare "อากาศ" means wherever you are
    does: 'Open-Meteo',
    run: (place) => ({ kind: 'weather', place }),
    toast: (place) => `⛅ ${`สภาพอากาศ ${place}`.trim()}`,
  },
];

// ---- Page parser. Runs on HTML fetched by main.ts through curl (DuckDuckGo allows no
// cross-origin read) and returns [] rather than throwing — the caller then falls back to
// resultUrl() and the user still gets their answer, in the browser.

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#x27': "'", '#39': "'", '#x2F': '/',
};
// Tags stripped (DuckDuckGo wraps matched terms in <b>), then the entities those pages actually use.
const text = (html: string) => html
  .replace(/<[^>]*>/g, '')
  .replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (m, e: string) => ENTITIES[e] ?? (
    /^#x/i.test(e) ? String.fromCodePoint(parseInt(e.slice(2), 16))
      : /^#/.test(e) ? String.fromCodePoint(parseInt(e.slice(1), 10)) : m))
  .trim();

// DuckDuckGo's HTML endpoint: title rows and snippet rows come in the same order, so they zip.
export function parseDdg(html: string, max = 5): Array<{ title: string; url: string; snippet: string }> {
  const links = [...html.matchAll(/class="result__a"\s+href="([^"]+)">([\s\S]*?)<\/a>/g)];
  const snippets = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)];
  return links.slice(0, max).map((m, i) => ({
    url: text(m[1]),
    title: text(m[2]),
    snippet: snippets[i] ? text(snippets[i][1]) : '',
  })).filter((r) => r.url.startsWith('http') && r.title);
}

// RSS <item>s → the news cards. Bing wraps every link in its own click tracker and carries the
// real article behind `url=`; that real URL is both what the card opens and where its cover comes
// from, so an item without one is dropped rather than shown as a dead end.
export function parseNews(xml: string, max = 5): NewsItem[] {
  const get = (s: string, tag: string) =>
    new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(s)?.[1] ?? '';
  const out: NewsItem[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const link = text(get(m[1], 'link'));
    const url = /[?&]url=([^&]+)/.exec(link) ? decodeURIComponent(/[?&]url=([^&]+)/.exec(link)![1]) : link;
    const source = text(get(m[1], 'News:Source')) || text(get(m[1], 'source'));
    const title = text(get(m[1], 'title'))
      .replace(new RegExp(`\\s*-\\s*${source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), '');
    if (title && url.startsWith('http') && !out.some((o) => o.url === url)) {
      out.push({ title, source, url, iso: get(m[1], 'pubDate').trim() });
    }
    if (out.length === max) break;
  }
  return out;
}

// The cover image. The RSS carries none, but the article page Google redirects to states one as
// og:image — and Google's own redirect page already has a thumbnail, so one hop is enough.
export function parseOgImage(html: string): string | null {
  const m = /<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/.exec(html)
    ?? /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image["']/.exec(html) // attrs reversed
    ?? /<meta[^>]+name=["']twitter:image["'][^>]*content=["']([^"']+)["']/.exec(html);
  if (m) return text(m[1]);
  // No card metadata: fall back to the first real image in the body. Sprites, spacers, icons and
  // logos are what that would otherwise pick up, so they are filtered out by name and by size.
  for (const img of html.matchAll(/<img[^>]+>/g)) {
    const src = /\ssrc=["']([^"']+)["']/.exec(img[0])?.[1]
      ?? /\sdata-src=["']([^"']+)["']/.exec(img[0])?.[1]; // lazy-loaded
    if (!src || !/^https?:/.test(src)) continue;
    if (/sprite|spacer|blank|pixel|avatar|logo|icon|favicon|1x1|placeholder/i.test(src)) continue;
    if (/\.svg(\?|$)/i.test(src)) continue;
    const w = Number(/\swidth=["']?(\d+)/.exec(img[0])?.[1] ?? 0);
    if (w && w < 200) continue; // thumbnails and badges
    return text(src);
  }
  return null;
}

// WMO weather codes → the one-line condition on the weather card. Coarse on purpose: eight buckets
// read better on a widget than the standard's 28 near-synonyms.
export function wmo(code: number): { en: string; th: string; icon: string } {
  if (code === 0) return { en: 'Clear', th: 'ท้องฟ้าแจ่มใส', icon: '☀️' };
  if (code <= 3) return { en: 'Partly cloudy', th: 'มีเมฆบางส่วน', icon: '⛅' };
  if (code <= 48) return { en: 'Fog', th: 'หมอก', icon: '🌫️' };
  if (code <= 57) return { en: 'Drizzle', th: 'ฝนปรอย', icon: '🌦️' };
  if (code <= 67) return { en: 'Rain', th: 'ฝนตก', icon: '🌧️' };
  if (code <= 77) return { en: 'Snow', th: 'หิมะ', icon: '🌨️' };
  if (code <= 82) return { en: 'Heavy rain', th: 'ฝนตกหนัก', icon: '🌧️' };
  if (code <= 86) return { en: 'Snow showers', th: 'หิมะตกหนัก', icon: '🌨️' };
  return { en: 'Thunderstorm', th: 'พายุฝนฟ้าคะนอง', icon: '⛈️' };
}

// Card opacity, 50 (see-through) to 100 (solid). Set from the tray, read by every card window.
export const OPACITY_KEY = 'wakekit-opacity';
export const OPACITIES = [50, 60, 70, 80, 90, 100];

export type VoiceCmd = Match & { type?: 'claude' | 'chrome' | 'youtube'; prompt: string };
export const CMDS_KEY = 'wakekit-voice-cmds';
export const loadCmds = (): VoiceCmd[] => {
  try { return JSON.parse(localStorage.getItem(CMDS_KEY) ?? '[]'); } catch { return []; } // corrupt — start empty
};
// A user command's destination, phrased the same way as a built-in's `does`.
export const cmdDest = (c: VoiceCmd) =>
  c.type === 'chrome' ? 'Google' : c.type === 'youtube' ? 'YouTube' : `claude -p${c.prompt ? `: ${c.prompt}` : ''}`;
