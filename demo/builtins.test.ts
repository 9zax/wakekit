// Command matching and the search parser — the parts that break silently. A wake-word utterance
// rarely starts with the keyword, Thai dictation sprays spaces through it, and the parser runs on
// HTML we don't own. `npm run test:cmds`. Fixtures below are trimmed from real responses.
import { BUILTIN, flexMatch, newsFeed, parseDdg, parseNews, parseOgImage, resultUrl, wmo } from './builtins';
import { strict as assert } from 'node:assert';

const hit = (t: string) => {
  for (const b of BUILTIN) {
    const arg = flexMatch(t, b);
    if (arg !== null && !(b.needsArg && !arg)) return { word: b.word, arg, pip: b.run(arg) };
  }
  return null;
};

// ---- matching: words before and after the keyword both land
assert.deepEqual(hit('เปิดเพลง lada')?.pip, { kind: 'video', q: 'lada' });
assert.equal(hit('ช่วยเปิดเพลง lada หน่อย')?.arg, 'lada หน่อย');
assert.equal(hit('ขอ เพ ลง คิดถึง')?.arg, 'คิดถึง'); // STT split the keyword
assert.deepEqual(hit('อากาศ กรุงเทพ')?.pip, { kind: 'weather', place: 'กรุงเทพ' });
assert.equal(hit('วันนี้สภาพอากาศเป็นไง')?.arg, 'เป็นไง');
assert.deepEqual(hit('อากาศ')?.pip, { kind: 'weather', place: '' }); // city is optional

assert.equal(hit('เปิดเพลง'), null); // needsArg: nothing to search for
assert.equal(hit('สรุปเมลล่าสุดให้หน่อย'), null); // unrelated speech stays unrelated

// prefix commands still anchor
assert.equal(flexMatch('ช่วยสรุปเมล', { word: 'สรุปเมล', match: 'prefix' }), null);
assert.equal(flexMatch('สรุปเมล ล่าสุด', { word: 'สรุปเมล', match: 'prefix' }), 'ล่าสุด');

// ---- the browser fallback every failure path uses
assert.match(resultUrl({ kind: 'video', q: 'lada' }), /youtube\.com.*lada/);
assert.match(resultUrl({ kind: 'weather', place: 'กรุงเทพ' }), /google\.com.*%E0/);
assert.match(resultUrl({ kind: 'search', q: 'x' }), /google\.com.*q=x/);
assert.equal(resultUrl({ kind: 'text', title: 'a', body: 'b' }), '');

// ---- DuckDuckGo: title rows and snippet rows zip in order, <b> and entities stripped
const DDG = '<a rel="nofollow" class="result__a" href="https://github.com/livekit/livekit-wakeword">'
  + 'GitHub &amp; livekit: <b>wake</b> word library</a>'
  + '<a class="result__snippet" href="https://github.com/livekit/livekit-wakeword">An open-source <b>wake</b> <b>word</b> library.</a>'
  + '<a rel="nofollow" class="result__a" href="https://docs.livekit.io/x">Wakeword detection</a>'
  + '<a class="result__snippet" href="https://docs.livekit.io/x">Say hey livekit.</a>';
const rows = parseDdg(DDG);
assert.equal(rows.length, 2);
assert.deepEqual(rows[0], {
  url: 'https://github.com/livekit/livekit-wakeword',
  title: 'GitHub & livekit: wake word library',
  snippet: 'An open-source wake word library.',
});
assert.equal(rows[1].title, 'Wakeword detection');
assert.equal(parseDdg(DDG, 1).length, 1); // max respected
assert.deepEqual(parseDdg('<html>no results</html>'), []);

// ---- News: the real article hides in Bing's click-tracker link, " - Source" comes off the title
const item = (t: string, s: string, real: string, d: string) =>
  `<item><title>${t}</title><link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;url=${encodeURIComponent(real)}&amp;c=1</link>`
  + `<News:Source>${s}</News:Source><pubDate>${d}</pubDate></item>`;
const RSS = '<rss><channel>'
  + item('แรงไม่หยุด &quot;Make It Right&quot; - คมชัดลึก', 'คมชัดลึก', 'https://www.komchadluek.net/entertainment/620873', 'Mon, 10 Aug 2026 04:49:08 GMT')
  + item('IT workers unemployment climbs', 'Healthcare IT News', 'https://www.healthcareitnews.com/news/it-workers', 'Mon, 10 Aug 2026 09:05:00 GMT')
  + item('duplicate of the first', 'คมชัดลึก', 'https://www.komchadluek.net/entertainment/620873', 'Mon, 10 Aug 2026 09:06:00 GMT')
  + '</channel></rss>';
const news = parseNews(RSS);
assert.equal(news.length, 2); // the repeated article is dropped, not shown twice
assert.deepEqual(news[0], {
  title: 'แรงไม่หยุด "Make It Right"', // "- คมชัดลึก" trimmed, &quot; decoded
  source: 'คมชัดลึก',
  url: 'https://www.komchadluek.net/entertainment/620873', // the publisher, not bing.com
  iso: 'Mon, 10 Aug 2026 04:49:08 GMT',
});
assert.equal(news[1].url, 'https://www.healthcareitnews.com/news/it-workers');
assert.equal(parseNews(RSS, 1).length, 1); // max respected
assert.deepEqual(parseNews('<rss><channel></channel></rss>'), []);
assert.match(newsFeed('IT'), /bing\.com\/news\/search\?q=IT.*format=RSS.*th-TH/);
assert.match(newsFeed('IT', 'en-US'), /en-US/);
assert.match(newsFeed(''), /q=%E0/); // bare "ข่าว" still searches for something
assert.match(resultUrl({ kind: 'news', q: 'IT' }), /bing\.com\/news/);
assert.equal(parseOgImage('<meta property="og:image" content="https://x/i.jpg?a=1&amp;b=2">'), 'https://x/i.jpg?a=1&b=2');
assert.equal(parseOgImage('<meta content="https://x/r.jpg" property="og:image">'), 'https://x/r.jpg'); // attrs reversed
assert.equal(parseOgImage('<meta name="twitter:image" content="https://x/t.jpg">'), 'https://x/t.jpg');
// no card metadata → first real body image, skipping the logo, the sprite and the tiny one
assert.equal(parseOgImage('<img src="https://x/logo.png"><img src="https://x/sprite-a.jpg">'
  + '<img src="https://x/thumb.jpg" width="80"><img data-src="https://x/hero.jpg">'), 'https://x/hero.jpg');
assert.equal(parseOgImage('<img src="/relative.jpg"><img src="https://x/icon.svg">'), null);
assert.equal(parseOgImage('<meta property="og:title" content="no image here">'), null);
assert.equal(resultUrl({ kind: 'news', q: 'IT', item: news[0] }), news[0].url);

// ---- WMO buckets at their boundaries
assert.equal(wmo(0).en, 'Clear');
assert.equal(wmo(3).en, 'Partly cloudy');
assert.equal(wmo(45).en, 'Fog');
assert.equal(wmo(65).en, 'Rain');
assert.equal(wmo(82).th, 'ฝนตกหนัก');
assert.equal(wmo(95).en, 'Thunderstorm');

console.log('builtins: ok');
