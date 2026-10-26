// Fired Up — двигателят на състезанието.
// 100 бота търгуват penny stocks, всеки с фалшиви $2 000 и своя стратегия — но като с истински пари: поръчка се изпълнява на следващата минута,
// плаща се спред и такси на брокера, не се купува повече, отколкото пазарът реално търгува. Уволнение по 3 правила.
// Данни в реално време: Yahoo Finance (минутни свещи с обем, без ключ). Ако Yahoo откаже —
// Alpaca IEX в реално време (нужни ALPACA_KEY_ID / ALPACA_SECRET_KEY, по желание).
// Нужно във Vercel: свързана Upstash памет (KV_REST_API_URL / KV_REST_API_TOKEN).

const START_CASH = Number(process.env.START_CASH || 2000);   // по $2 000 — при цели акции закръглянето е под 0,5%, а сумата е малка спрямо обема
const SLIP = 0.002;          // 0,2% приплъзване при покупка и при продажба (широк спред при penny stocks)
const SLIP_PRE = 0.005;      // 0,5% в премаркета — спредовете тогава са много по-широки
let REG_START = 0;           // кога е истинското отваряне днес (9:30 НЙ)
const slipAt = t => (REG_START && t < REG_START ? SLIP_PRE : SLIP);
// половината спред: поне 0,2% (0,5% в премаркета), но и поне половин цент — при $1–5 акции котировката е през $0,01
function halfSpread(px, t) { const pre = REG_START && t < REG_START; return Math.max(pre ? SLIP_PRE : SLIP, (px >= 1 ? (pre ? 0.01 : 0.005) : (pre ? 0.001 : 0.0005)) / px); }
// Брокер без комисиона (като Trading 212 / Alpaca) — при малка сметка таксата на IBKR (мин. $1) изяжда печалбата.
// Плащат се спредът и регулаторните такси на САЩ при продажба. BROKER=ibkr във Vercel връща таксите на Interactive Brokers.
const IBKR = process.env.BROKER === 'ibkr';
const COMM_SH = 0.005, COMM_MIN = IBKR ? 1 : 0, COMM_MAX = 0.01;
// при продажба и регулаторните такси в САЩ: SEC $20,60 на $1 млн. (от 04.04.2026) и FINRA TAF $0,000166 на акция (макс. $8,30)
const SEC_FEE = 20.6 / 1e6, TAF_SH = 0.000166, TAF_MAX = 8.3;
const LIQ_SHARE = 0.1;      // не купува повече от 10% от средния минутен обем — иначе сам би вдигнал цената
const commission = (q, px) => IBKR ? Math.min(Math.max(q * COMM_SH, COMM_MIN), q * px * COMM_MAX) : 0;
const sellFees = (q, px) => q * px * SEC_FEE + Math.min(q * TAF_SH, TAF_MAX);
const N_BOTS = Number(process.env.N_BOTS || 100);
const STRIKES_TO_FIRE = Number(process.env.STRIKES_TO_FIRE || 5);   // уволнение: 5 поредни загуби
const DD_FIRE = Number(process.env.DD_FIRE || 0);                   // по желание: % спад от върха (0 = изключено)
const LOSER_TRADES = Number(process.env.LOSER_TRADES || 0);         // по желание: на минус след толкова сделки (0 = изключено)
const MIN_ORDER = Math.max(1, START_CASH * 0.05);                   // най-малка поръчка (при $2 000 → $100)
const PRICE_MIN = 1, PRICE_MAX = 20;   // само акции от $1 до $20
const UNIVERSE_N = Number(process.env.UNIVERSE_N || 24);    // резерва: толкова акции, ако груповата заявка не работи
const RADAR_N = Number(process.env.RADAR_N || 120);         // радар: толкова акции се сканират всяка минута (с групови заявки)
const FOCUS_N = Number(process.env.FOCUS_N || 40);          // общо толкова акции на минута (държаните + най-живите от всяка територия) се гледат с пълни минутни свещи
// територии: всеки трейдър ловува само в своята част от пазара
const ZONES = {
  low: { name: '$1–3', txt: 'само акции между $1 и $3' },
  mid: { name: '$3–8', txt: 'само акции между $3 и $8' },
  high: { name: '$8–20', txt: 'само акции между $8 и $20' },
  gainers: { name: 'Най-поскъпналите', txt: 'само акции, поскъпнали с над 15% днес' },
  active: { name: 'Най-търгуваните', txt: 'само 30-те най-търгувани акции на деня' },
  gappers: { name: 'Сутрешен скок', txt: 'само акции, започнали деня с над 8% над вчерашната цена' },
};
const ZONE_KEYS = Object.keys(ZONES);
const FALLBACK = ['SNDL','PLUG','BBAI','SOUN','GSAT','TELL','OPEN','SENS','CLOV','NIO','RIG','ACHR','TLRY','HIVE','BITF','CIFR','QS','LAZR','DNA','NKLA','FCEL','IQ','GRAB','SIRI'];
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36', Accept: 'application/json' };

/* ---------------- памет (Upstash Redis REST) ---------------- */
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
async function kv(cmd) {
  if (!KV_URL || !KV_TOKEN) throw new Error('no_kv');
  const r = await fetch(KV_URL, { method: 'POST', headers: { Authorization: `Bearer ${KV_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(cmd) });
  const d = await r.json().catch(() => ({}));
  if (d.error) throw new Error('kv: ' + d.error);
  return d.result ?? null;
}
const sgnP = n => (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(1).replace('.', ',') + '%';
const STATE_KEY = process.env.STATE_KEY || 'arena:v4'; // v4 = 100 × $2 000 (старите състезания остават в arena:v3 и arena:v2)
const zlib = require('zlib');
// пази се компресирано — 100 трейдъри с история иначе изяждат безплатния трафик на Upstash
async function loadState() { const s = await kv(['GET', STATE_KEY]); if (!s) return null; return JSON.parse(s.startsWith('z:') ? zlib.gunzipSync(Buffer.from(s.slice(2), 'base64')).toString() : s); }
async function saveState(st) { await kv(['SET', STATE_KEY, 'z:' + zlib.gzipSync(JSON.stringify(st), { level: 6 }).toString('base64')]); }
// историята на парите на всеки трейдър е в отделен запис и се пише на 5 минути (иначе трафикът към Upstash е твърде голям)
const HIST_KEY = STATE_KEY + ':h';
async function loadHist() { const s = await kv(['GET', HIST_KEY]); return s ? JSON.parse(zlib.gunzipSync(Buffer.from(s, 'base64')).toString()) : {}; }
async function saveHist(H) { await kv(['SET', HIST_KEY, zlib.gzipSync(JSON.stringify(H), { level: 6 }).toString('base64')]); }

/* ---------------- време (Ню Йорк) ---------------- */
function etParts(ms) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, min: (+p.hour % 24) * 60 + +p.minute };
}

/* ---------------- данни: Yahoo Finance (основно) ---------------- */
async function yget(path) {
  let last;
  for (const host of ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']) {
    try {
      const r = await fetch(host + path, { headers: UA });
      if (r.ok) return await r.json();
      last = new Error(`yahoo ${r.status}`);
    } catch (e) { last = e; }
  }
  throw last;
}
function ybars(res) {
  const ts = res?.timestamp || [], q = res?.indicators?.quote?.[0] || {};
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const c = q.close?.[i], o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], v = q.volume?.[i];
    if (c == null || o == null || h == null || l == null) continue;
    out.push({ t: ts[i] * 1000, o, h, l, c, v: v || 0 });
  }
  return out;
}
async function yIntraday(sym) {
  const d = await yget(`/v8/finance/chart/${encodeURIComponent(sym)}?interval=1m&range=1d&includePrePost=true`);
  const res = d?.chart?.result?.[0];
  if (!res) throw new Error('yahoo empty ' + sym);
  const tp = res.meta?.currentTradingPeriod?.regular, pre = res.meta?.currentTradingPeriod?.pre;
  return { bars: ybars(res), session: tp ? { start: (pre?.start || tp.start) * 1000, regStart: tp.start * 1000, end: tp.end * 1000 } : null, prevClose: res.meta?.chartPreviousClose ?? res.meta?.previousClose };
}
async function yDaily(sym) {
  const d = await yget(`/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=2mo`);
  return ybars(d?.chart?.result?.[0]);
}
async function yScreen(id) {
  const d = await yget(`/v1/finance/screener/predefined/saved?scrIds=${id}&count=100`);
  return (d?.finance?.result?.[0]?.quotes || []).map(q => ({ sym: q.symbol, price: q.regularMarketPrice, vol: q.regularMarketVolume, chg: q.regularMarketChangePercent, exch: q.exchange, delay: q.exchangeDataDelayedBy, type: q.quoteType }));
}

/* ---------------- данни: Alpaca IEX в реално време (резерва) ---------------- */
function akeys() {
  const id = process.env.ALPACA_KEY_ID || process.env.APCA_API_KEY_ID, sec = process.env.ALPACA_SECRET_KEY || process.env.APCA_API_SECRET_KEY;
  return id && sec ? { 'APCA-API-KEY-ID': id, 'APCA-API-SECRET-KEY': sec } : null;
}
async function alpacaIntraday(syms, startMs) {
  const k = akeys(); if (!k) throw new Error('no_fallback');
  const out = {}; let token = '';
  for (let page = 0; page < 6; page++) {
    const r = await fetch(`https://data.alpaca.markets/v2/stocks/bars?symbols=${syms.join(',')}&timeframe=1Min&start=${new Date(startMs).toISOString()}&limit=10000&feed=iex${token ? '&page_token=' + token : ''}`, { headers: k });
    const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error('alpaca ' + r.status);
    for (const [s, arr] of Object.entries(d.bars || {})) (out[s] = out[s] || []).push(...arr.map(b => ({ t: Date.parse(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })));
    if (!d.next_page_token) break; token = d.next_page_token;
  }
  return out;
}

/* ---------------- избор на акции за деня ---------------- */
const okSym = s => /^[A-Z]{1,5}$/.test(s || '');
const OTC = new Set(['PNK', 'OQB', 'OQX', 'OBB', 'OTC', 'OEM', 'GREY']);
// По желание: Finnhub (безплатен ключ на finnhub.io → FINNHUB_KEY във Vercel) — последната цена в реално време
const FINNHUB = process.env.FINNHUB_KEY || '';
async function liveQuotes(st, syms, nowMs) {
  if (!FINNHUB || !syms.length) return;
  if (st.fhAt && nowMs - st.fhAt < 15000) return; st.fhAt = nowMs; st.live = st.live || {};
  const res = await Promise.allSettled(syms.slice(0, 25).map(s => fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(s)}&token=${FINNHUB}`).then(r => r.ok ? r.json() : null)));
  res.forEach((r, k) => { const q = r.status === 'fulfilled' && r.value; if (q && q.c > 0 && q.t) st.live[syms[k]] = { px: q.c, t: q.t * 1000 }; });
}
// групова заявка: минутните цени (само затваряния) на до 20 акции наведнъж
function parseSpark(d) {
  const out = {};
  const arr = d && d.spark && d.spark.result;
  if (Array.isArray(arr)) for (const r of arr) { const res = r.response && r.response[0]; if (!res) continue; const q = res.indicators && res.indicators.quote && res.indicators.quote[0]; out[r.symbol] = { t: (res.timestamp || []).map(x => x * 1000), c: (q && q.close) || [], pdc: res.meta && (res.meta.chartPreviousClose ?? res.meta.previousClose) }; }
  else if (d && typeof d === 'object') for (const [k, v] of Object.entries(d)) if (v && Array.isArray(v.close)) out[k] = { t: (v.timestamp || []).map(x => x * 1000), c: v.close, pdc: v.chartPreviousClose ?? v.previousClose };
  return out;
}
async function ySpark(syms) {
  const ch = []; for (let i = 0; i < syms.length; i += 20) ch.push(syms.slice(i, i + 20));
  const res = await Promise.allSettled(ch.map(c => yget(`/v8/finance/spark?symbols=${c.map(encodeURIComponent).join(',')}&range=1d&interval=1m&includePrePost=true`)));
  const out = {}; for (const r of res) if (r.status === 'fulfilled') Object.assign(out, parseSpark(r.value));
  return out;
}
// радарът: до 120 акции от няколко скенера на Yahoo (обновява се на 20 минути)
async function pickRadar() {
  const meta = new Map();
  const res = await Promise.allSettled(['small_cap_gainers', 'day_gainers', 'most_actives', 'aggressive_small_caps'].map(id => yScreen(id)));
  for (const r of res) if (r.status === 'fulfilled') for (const q of r.value) {
    if (!okSym(q.sym) || !(q.price >= PRICE_MIN && q.price <= PRICE_MAX) || !(q.vol > 200000)) continue;
    if (OTC.has(q.exch) || (q.delay != null && q.delay > 0) || (q.type && q.type !== 'EQUITY')) continue;
    const m = meta.get(q.sym) || { s: q.sym, n: 0 }; m.n++; m.px = q.price; m.chg = q.chg || 0; m.vol = Math.max(m.vol || 0, q.vol || 0); meta.set(q.sym, m);
  }
  const list = [...meta.values()].sort((a, b) => b.vol - a.vol); list.forEach((m, k) => { m.vr = k + 1; });
  return list.sort((a, b) => (b.n * 3 + Math.min(5, b.chg / 10)) - (a.n * 3 + Math.min(5, a.chg / 10))).slice(0, RADAR_N);
}
// попада ли акцията в територията (по последните данни)
function zoneHit(z, m) {
  if (!z || !m) return !z;
  if (z === 'low') return m.px < 3;
  if (z === 'mid') return m.px >= 3 && m.px < 8;
  if (z === 'high') return m.px >= 8;
  if (z === 'gainers') return m.chg >= 15;
  if (z === 'active') return (m.vr || 999) <= 30;
  if (z === 'gappers') return (m.gap ?? m.chg) >= 8;
  return true;
}
// същото, но в момента на сигнала — по минутните свещи
function inZone(z, I, i, m) {
  if (!z) return true;
  const px = I.c[i], pdc = I.ctx && I.ctx.pdc;
  if (z === 'low') return px < 3;
  if (z === 'mid') return px >= 3 && px < 8;
  if (z === 'high') return px >= 8;
  if (z === 'gainers') return pdc ? px / pdc - 1 >= 0.15 : false;
  if (z === 'gappers') { const ri = I.ctx && I.ctx.regIdx; const k = ri != null && ri <= i ? ri : 0; return pdc ? I.o[k] / pdc - 1 >= 0.08 : false; }
  if (z === 'active') return !!m && (m.vr || 999) <= 30;
  return true;
}
// всяка минута: групова заявка за целия радар → кои акции „живеят“ сега → най-живите от всяка територия се гледат отблизо
async function pickFocus(st, nowMs, start) {
  const radar = st.radar || []; const M = {}; for (const m of radar) M[m.s] = { ...m };
  let live = {}; try { live = await ySpark(radar.map(m => m.s)); } catch (e) { live = {}; }
  let liveN = 0;
  for (const [s, d] of Object.entries(live)) {
    const m = M[s]; if (!m) continue;
    const pts = []; for (let k = 0; k < d.t.length; k++) if (d.c[k] != null && d.t[k] >= start - 60000) pts.push([d.t[k], d.c[k]]);
    if (!pts.length) continue; liveN++;
    const last = pts[pts.length - 1][1], back = pts[Math.max(0, pts.length - 6)][1], pdc = d.pdc || (m.px / (1 + (m.chg || 0) / 100));
    m.px = last; m.chg5 = back ? (last / back - 1) * 100 : 0; if (pdc) { m.chg = (last / pdc - 1) * 100; m.gap = (pts[0][1] / pdc - 1) * 100; }
  }
  for (const m of Object.values(M)) m.hot = Math.abs(m.chg5 || 0) * 3 + Math.abs(m.chg || 0) / 5 + Math.min(3, (m.vol || 0) / 2e7);
  const keep = [...new Set([...st.bots.flatMap(b => b.positions.map(p => p.sym)), ...st.bots.filter(b => b.pending).map(b => b.pending.s)])];
  const per = Math.max(3, Math.ceil(FOCUS_N / ZONE_KEYS.length));
  const picks = ZONE_KEYS.map(z => Object.values(M).filter(m => zoneHit(z, m)).sort((a, b) => b.hot - a.hot).slice(0, per).map(m => m.s));
  // общо до FOCUS_N акции на минута (заедно с държаните) — за да не ни блокира Yahoo; поне по 2 на територия
  const cap = Math.max(FOCUS_N, keep.length + 2 * ZONE_KEYS.length);
  const focus = [...keep]; for (let k = 0; k < per; k++) for (const p of picks) if (p[k] && !focus.includes(p[k]) && focus.length < cap) focus.push(p[k]);
  for (const m of Object.values(M).sort((a, b) => b.hot - a.hot)) { if (focus.length >= cap) break; if (!focus.includes(m.s)) focus.push(m.s); }
  st.radarMeta = Object.fromEntries(Object.values(M).map(m => [m.s, { px: round4(m.px || 0), chg: round2(m.chg || 0), vr: m.vr, gap: m.gap != null ? round2(m.gap) : undefined }]));
  st.scan = { radar: radar.length, live: liveN, focus: focus.length, mode: liveN >= radar.length / 3 ? 'spark' : 'screener', t: nowMs };
  return focus;
}
async function pickUniverse() {
  const score = new Map();
  for (const [id, w] of [['small_cap_gainers', 3], ['day_gainers', 2], ['most_actives', 2]]) {
    try {
      for (const q of await yScreen(id)) {
        if (!okSym(q.sym) || !(q.price >= PRICE_MIN && q.price <= PRICE_MAX) || !(q.vol > 300000)) continue;
        // само акции с цени на живо: без OTC (там Yahoo е с 15 мин закъснение) и без закъснели борси
        if (OTC.has(q.exch) || (q.delay != null && q.delay > 0) || (q.type && q.type !== 'EQUITY')) continue;
        score.set(q.sym, (score.get(q.sym) || 0) + w + Math.min(3, (q.chg || 0) / 15) + Math.min(2, (q.vol || 0) / 2e7));
      }
    } catch (e) { console.error('screener', id, e.message); }
  }
  let list = [...score.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s).slice(0, UNIVERSE_N);
  if (list.length < 6) list = [...new Set([...list, ...FALLBACK])].slice(0, UNIVERSE_N);
  return list;
}

/* ---------------- индикатори ---------------- */
function ema(a, n) { const k = 2 / (n + 1); const o = []; let e; for (let i = 0; i < a.length; i++) { e = i === 0 ? a[0] : a[i] * k + e * (1 - k); o.push(e); } return o; }
function rsi(a, n) { const o = Array(a.length).fill(50); let g = 0, l = 0; for (let i = 1; i < a.length; i++) { const d = a[i] - a[i - 1]; const up = Math.max(d, 0), dn = Math.max(-d, 0); if (i <= n) { g += up / n; l += dn / n; } else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; } if (i >= n) o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } return o; }
function sma(a, n) { const o = []; let s = 0; for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= n) s -= a[i - n]; o.push(i >= n - 1 ? s / n : s / (i + 1)); } return o; }
function stdev(a, n, m) { return a.map((_, i) => { if (i < n - 1) return 0; let s = 0; for (let j = i - n + 1; j <= i; j++) s += (a[j] - m[i]) ** 2; return Math.sqrt(s / n); }); }
function indic(bars, ctx = {}) {
  const c = bars.map(b => b.c), h = bars.map(b => b.h), l = bars.map(b => b.l), o = bars.map(b => b.o), v = bars.map(b => b.v);
  let pv = 0, vv = 0; const vwap = bars.map(b => { pv += ((b.h + b.l + b.c) / 3) * b.v; vv += b.v; return vv ? pv / vv : b.c; });
  const m20 = sma(c, 20), sd = stdev(c, 20, m20);
  const e12 = ema(c, 12), e26 = ema(c, 26); const macd = e12.map((x, i) => x - e26[i]); const sig = ema(macd, 9);
  const tr = bars.map((b, i) => i ? Math.max(b.h - b.l, Math.abs(b.h - c[i - 1]), Math.abs(b.l - c[i - 1])) : b.h - b.l);
  const atr = ema(tr, 14);
  const hod = [], lod = [], cumV = []; let mx = -Infinity, mn = Infinity, cv = 0;
  for (let i = 0; i < bars.length; i++) { mx = Math.max(mx, h[i]); mn = Math.min(mn, l[i]); cv += v[i]; hod.push(mx); lod.push(mn); cumV.push(cv); }
  const k14 = c.map((x, i) => { if (i < 13) return 50; let H = -Infinity, L = Infinity; for (let j = i - 13; j <= i; j++) { H = Math.max(H, h[j]); L = Math.min(L, l[j]); } return H > L ? (x - L) / (H - L) * 100 : 50; });
  const d3 = sma(k14, 3);
  const cache = {};
  return { c, h, l, o, v, vwap, bbLow: m20.map((m, i) => m - 2 * sd[i]), macd, sig, atr, hod, lod, cumV, k14, d3, avgV: sma(v, 20), dayOpen: o[0], ctx,
    ema: n => cache['e' + n] || (cache['e' + n] = ema(c, n)), rsi: n => cache['r' + n] || (cache['r' + n] = rsi(c, n)) };
}
function dailyCtx(dbars, todayStartMs) {
  const past = dbars.filter(b => b.t < todayStartMs - 3600e3);
  if (!past.length) return {};
  const y = past[past.length - 1], last20 = past.slice(-20);
  return { pdh: y.h, pdc: y.c, hi20: Math.max(...last20.map(b => b.h)), avgDayVol: last20.reduce((s, b) => s + b.v, 0) / last20.length };
}

/* ---------------- стратегии (гени) ---------------- */
const R = a => a[Math.floor(Math.random() * a.length)];
// класически penny stock сетъпи (по-често) + индикаторни
const TRIGGERS = {
  orb: () => ({ n: R([5, 15, 30]) }),
  donchian20: () => ({ k: R([1.5, 2, 3]) }),
  pdh_break: () => ({}),
  hod_break: () => ({ pull: R([2, 3, 5]) }),
  bull_flag: () => ({ run: R([4, 6, 10]) }),
  fib_bounce: () => ({ lvl: R([0.5, 0.618]) }),
  red_to_green: () => ({}),
  gap_go: () => ({ g: R([8, 15, 25]) }),
  vwap_bounce: () => ({}),
  stoch_cross: () => ({ lvl: R([20, 25]) }),
  ema_cross: () => ({ f: R([5, 8, 9]), s: R([20, 21, 34]) }),
  rsi_bounce: () => ({ n: R([7, 9, 14]), th: R([25, 30]) }),
  macd_cross: () => ({}),
  bb_bounce: () => ({}),
  vol_spike: () => ({ k: R([3, 4, 5]) }),
};
const TRIGGER_POOL = ['orb', 'orb', 'donchian20', 'donchian20', 'pdh_break', 'hod_break', 'hod_break', 'bull_flag', 'bull_flag', 'fib_bounce', 'fib_bounce', 'red_to_green', 'gap_go', 'vwap_bounce', 'vwap_bounce', 'stoch_cross', 'ema_cross', 'rsi_bounce', 'macd_cross', 'bb_bounce', 'vol_spike'];
const FILTERS = {
  above_vwap: () => ({}),
  above_ema: () => ({ n: R([20, 50]) }),
  rsi_range: () => { const lo = R([40, 45, 50]); return { lo, hi: lo + R([25, 30]) }; },
  day_gainer: () => ({ g: R([5, 10, 20]) }),
  rvol: () => ({ k: R([1.5, 2, 3]) }),
  vol_confirm: () => ({ k: R([1.5, 2]) }),
  green_streak: () => ({ k: R([2, 3]) }),
};
function newGenome(avoid = [], force = null) {
  const free = TRIGGER_POOL.filter(t => !avoid.includes(t));
  const trig = force || R(free.length ? free : TRIGGER_POOL);
  const fkeys = Object.keys(FILTERS).sort(() => Math.random() - 0.5).slice(0, R([0, 1, 1, 2]));
  const atrStop = Math.random() < 0.4;
  return {
    trigger: { t: trig, ...TRIGGERS[trig]() },
    filters: fkeys.map(k => ({ t: k, ...FILTERS[k]() })),
    tp: R([4, 5, 8, 10, 15]), sl: atrStop ? 0 : R([2, 3, 4, 5]), atr: atrStop ? R([1.5, 2, 3]) : 0,
    trail: R([0, 0, 2, 3, 5]), be: R([0, 0, 2, 3]), hold: R([20, 30, 60, 90, 180]),
    rsiExit: Math.random() < 0.25, vwapExit: Math.random() < 0.25,
    size: R([0.25, 0.5, 0.5, 1]), maxPos: R([1, 1, 2]),
    zone: R(ZONE_KEYS),
  };
}
function sig(g, I, i) {
  if (i < 6) return false;
  const T = g.trigger, c = I.c, h = I.h, l = I.l, o = I.o, X = I.ctx;
  let ok = false;
  switch (T.t) {
    case 'orb': { const r0 = X.regIdx; if (r0 == null || i <= r0 + T.n) break; let H = -Infinity; for (let j = r0; j < r0 + T.n; j++) H = Math.max(H, h[j]); ok = c[i] > H && c[i - 1] <= H && I.v[i] > I.avgV[i - 1]; break; }
    case 'donchian20': ok = X.hi20 > 0 && c[i] > X.hi20 && c[i - 1] <= X.hi20 && I.v[i] > T.k * I.avgV[i - 1]; break;
    case 'pdh_break': ok = X.pdh > 0 && c[i] > X.pdh && c[i - 1] <= X.pdh && c[i] > o[i]; break;
    case 'hod_break': { if (i < 15) break; const prev = I.hod[i - 1]; let lo = Infinity; for (let j = i - 10; j < i; j++) lo = Math.min(lo, l[j]); ok = c[i] > prev && lo <= prev * (1 - T.pull / 100); break; }
    case 'bull_flag': {
      if (i < 20) break; let p = -1, ph = -Infinity; for (let j = i - 8; j <= i - 2; j++) if (h[j] > ph) { ph = h[j]; p = j; }
      let base = Infinity; for (let j = Math.max(0, p - 10); j < p; j++) base = Math.min(base, l[j]);
      if (!(ph / base - 1 >= T.run / 100)) break;
      let fl = Infinity, fh = -Infinity, fv = 0, pv = 0; for (let j = p + 1; j < i; j++) { fl = Math.min(fl, l[j]); fh = Math.max(fh, h[j]); fv += I.v[j]; } for (let j = Math.max(0, p - 5); j <= p; j++) pv += I.v[j];
      const retr = (ph - fl) / (ph - base); const n = i - p - 1;
      ok = n >= 1 && retr > 0.15 && retr < 0.6 && fv / n < pv / Math.min(6, p + 1) && c[i] > fh && c[i] > o[i]; break;
    }
    case 'fib_bounce': {
      if (i < 20) break; let a = 0, b = 0; for (let j = 0; j < i; j++) { if (l[j] < l[a]) a = j; } for (let j = a; j < i; j++) if (h[j] > h[b] || b < a) b = j;
      if (!(b > a && h[b] / l[a] - 1 > 0.08 && i - b >= 3)) break;
      const L = h[b] - T.lvl * (h[b] - l[a]); ok = l[i - 1] <= L * 1.005 && l[i - 1] >= L * 0.97 && c[i] > L && c[i] > o[i]; break;
    }
    case 'red_to_green': ok = X.pdc > 0 && c[i] > X.pdc && c[i - 1] <= X.pdc && I.v[i] > I.avgV[i - 1]; break;
    case 'gap_go': { const r0 = X.regIdx; if (r0 == null || !(X.pdc > 0 && o[r0] / X.pdc - 1 >= T.g / 100) || i > r0 + 60 || i <= r0 + 5) break; let H = -Infinity; for (let j = r0; j < r0 + 5; j++) H = Math.max(H, h[j]); ok = c[i] > H && c[i - 1] <= H; break; }
    case 'vwap_bounce': { if (i < 20) break; const w = I.vwap; ok = l[i] <= w[i] * 1.003 && c[i] > w[i] && c[i] > o[i] && c[i - 5] > w[i - 5] && c[i - 10] > w[i - 10]; break; }
    case 'stoch_cross': ok = I.k14[i] > I.d3[i] && I.k14[i - 1] <= I.d3[i - 1] && I.k14[i - 1] < T.lvl; break;
    case 'ema_cross': { const f = I.ema(T.f), s = I.ema(T.s); ok = f[i] > s[i] && f[i - 1] <= s[i - 1]; break; }
    case 'rsi_bounce': { const r = I.rsi(T.n); ok = r[i - 1] < T.th && r[i] >= T.th; break; }
    case 'macd_cross': ok = I.macd[i] > I.sig[i] && I.macd[i - 1] <= I.sig[i - 1] && I.macd[i] < 0; break;
    case 'bb_bounce': ok = c[i - 1] < I.bbLow[i - 1] && c[i] > I.bbLow[i]; break;
    case 'vol_spike': ok = I.v[i] > T.k * I.avgV[i - 1] && c[i] > o[i] && c[i] > c[i - 1]; break;
  }
  if (!ok) return false;
  for (const F of g.filters) {
    switch (F.t) {
      case 'above_vwap': if (!(c[i] > I.vwap[i])) return false; break;
      case 'above_ema': if (!(c[i] > I.ema(F.n)[i])) return false; break;
      case 'rsi_range': { const r = I.rsi(14)[i]; if (!(r > F.lo && r < F.hi)) return false; break; }
      case 'day_gainer': { const base = X.pdc || I.dayOpen; if (!((c[i] / base - 1) * 100 > F.g)) return false; break; }
      case 'rvol': { if (X.avgDayVol > 0) { const frac = Math.max(0.05, (I.t ? (I.t[i] - X.sessStart) / (X.sessEnd - X.sessStart) : (i + 1) / 390)); if (!(I.cumV[i] > F.k * X.avgDayVol * frac)) return false; } break; }
      case 'vol_confirm': if (!(I.v[i] > F.k * I.avgV[i - 1])) return false; break;
      case 'green_streak': for (let j = 0; j < F.k; j++) if (!(c[i - j] > o[i - j])) return false; break;
    }
  }
  return I.avgV[i] * c[i] > 3000; // поне ~$3000 оборот на минута, иначе не може реално да се купи
}
const fmtP = n => String(n).replace('.', ',');
function describe(g) {
  // обяснено с прости думи — какво чака, кога продава и защо
  const T = g.trigger;
  const [trig, idea] = {
    orb: [`цената излезе над най-високото от първите ${T.n} минути след отварянето и в същото време се търгува повече от обикновено`, 'Първите минути показват накъде иска да тръгне акцията — ако пробие нагоре, често продължава.'],
    donchian20: [`цената стане по-висока от всичко през последния месец (20 търговски дни), а се търгува ${fmtP(T.k)} пъти повече от обикновено`, 'Нов месечен връх с много купувачи често е началото на голямо движение.'],
    pdh_break: ['цената мине над най-високата цена от вчера', 'Вчерашният връх е „таван“ — като го пробие, пътят нагоре е по-свободен.'],
    hod_break: [`акцията поспадне с поне ${T.pull}% от днешния си връх, а после пак го надмине`, 'Купува силна акция, която си е починала и отново тръгва нагоре.'],
    bull_flag: [`акцията вече е скочила с поне ${T.run}%, после постои спокойно (без много продажби) и пак тръгне нагоре`, 'След силен скок и кратка почивка движението често продължава.'],
    fib_bounce: [`акцията върне ${T.lvl === 0.5 ? 'половината' : 'около 60%'} от днешния си ръст и оттам започне да се качва`, 'Купува „на намаление“ след ръст — в момента, в който цената се обърне нагоре.'],
    red_to_green: ['акцията мине от минус в плюс за деня (над вчерашната си цена)', 'Когато акция излезе от червено в зелено, много хора купуват наведнъж.'],
    gap_go: [`акцията е започнала деня с над ${T.g}% по-високо от вчера и в първите минути продължи нагоре`, 'Голям сутрешен скок (обикновено заради новини) често продължава в началото.'],
    vwap_bounce: ['цената слезе до средната си цена за деня и отскочи нагоре', 'Средната цена за деня работи като под — купува, когато цената се оттласне от него.'],
    stoch_cross: ['акцията е била силно продавана и започне да се обръща нагоре', 'Купува, когато продавачите се изморят и цената тръгне обратно.'],
    ema_cross: [`средната цена от последните ${T.f} минути мине над средната от последните ${T.s} минути`, 'Значи, че цената се ускорява нагоре — началото на възход.'],
    rsi_bounce: ['акцията е паднала твърде много и твърде бързо и започне да се възстановява', 'Купува отскока след прекалено голям спад.'],
    macd_cross: ['спадът започне да губи сила и цената се обърне нагоре', 'Хваща момента, в който падането спира.'],
    bb_bounce: ['цената падне необичайно ниско спрямо последните минути и отскочи', 'Когато цената се отклони твърде много надолу, често се връща обратно.'],
    vol_spike: [`изведнъж се купува ${T.k} пъти повече от обикновено и цената се качва`, 'Внезапен голям интерес към акцията често води до бърз скок.'],
  }[T.t];
  const filt = g.filters.map(F => ({
    above_vwap: 'цената е над средната си цена за деня', above_ema: `цената е над средната си цена от последните ${F.n} минути`, rsi_range: 'акцията не е нито прегряла, нито прекалено продавана',
    day_gainer: `акцията вече е нагоре с поне ${F.g}% днес`, rvol: `днес се търгува ${fmtP(F.k)} пъти повече от обикновено`,
    vol_confirm: `в тази минута се търгува поне ${fmtP(F.k)} пъти повече от обикновено`, green_streak: `последните ${F.k} минути цената е само нагоре`,
  }[F.t]));
  const buy = (g.zone ? `Ловува ${ZONES[g.zone].txt}. ` : '') + `Купува, когато ${trig}` + (filt.length ? `, но само ако ${filt.join(' и ')}` : '') + '.';
  const stop = g.atr ? `, ако падне повече от обичайното (${fmtP(g.atr)} пъти колкото акцията мърда средно за минута)` : ` при −${g.sl}%`;
  const sell = `С печалба продава при +${g.tp}%. Със загуба продава${stop}.` +
    (g.trail ? ` Ако е на печалба и цената се върне с ${g.trail}% от най-високото, продава, за да запази печалбата.` : '') +
    (g.be ? ` След +${g.be}% се пази: ако цената се върне до покупката, продава (губи само таксите).` : '') +
    ` Не държи повече от ${g.hold} минути.` + (g.rsiExit ? ' Продава и ако акцията „прегрее“ (поскъпне твърде бързо).' : '') + (g.vwapExit ? ' Продава и ако цената падне под средната за деня.' : '');
  const size = `Влага ${Math.round(g.size * 100)}% от парите си в една сделка и държи ${g.maxPos === 1 ? 'само по една акция наведнъж' : `най-много ${g.maxPos} акции едновременно`}.`;
  return { buy, sell, size, idea };
}
// имената с прости думи (TECH = как се казват по учебник)
const STYLE = { orb: 'Пробив след отварянето', donchian20: 'Нов връх за месеца', pdh_break: 'Над вчерашния връх', hod_break: 'Нов връх за деня', bull_flag: 'Скок, почивка, скок', fib_bounce: 'Покупка на отстъпка', red_to_green: 'От минус в плюс', gap_go: 'Сутрешен скок', vwap_bounce: 'Отскок от средната цена', stoch_cross: 'Продавачите се изморяват', ema_cross: 'Ускорение нагоре', rsi_bounce: 'Отскок след голям спад', macd_cross: 'Краят на спада', bb_bounce: 'Твърде ниско — връща се', vol_spike: 'Внезапен интерес' };
const TECH = { orb: 'ORB', donchian20: '20-дневен пробив', pdh_break: 'Вчерашен връх', hod_break: 'Нов връх на деня', bull_flag: 'Бичи флаг', fib_bounce: 'Фибоначи', red_to_green: 'Red-to-green', gap_go: 'Gap & Go', vwap_bounce: 'VWAP отскок', stoch_cross: 'Стохастик', ema_cross: 'EMA кръст', rsi_bounce: 'RSI отскок', macd_cross: 'MACD', bb_bounce: 'Болинджър', vol_spike: 'Скок в обема' };
const NAMES = {
  orb: ['Орлин Пробива', 'Ори Първите 15'], donchian20: ['Дончо Двайсетака', 'Дони Канала'], pdh_break: ['Вчерашния Вальо', 'Пешо Пробива'],
  hod_break: ['Христо Върха', 'Ходи Новия Връх'], bull_flag: ['Флагмана Фичо', 'Бичка Флагова'], fib_bounce: ['Фиби Фибоначи', 'Леонардо 61,8'],
  red_to_green: ['Зеления Злати', 'Ред-Грийн Роки'], gap_go: ['Гошо Гапа', 'Гап Галя'], vwap_bounce: ['Вики VWAP', 'Валя Средната'],
  stoch_cross: ['Стоян Стохастика', 'Стефка Осцилатора'], ema_cross: ['Ема Трендова', 'Тошко Тренда'], rsi_bounce: ['Роси RSI', 'Ради Отскока'],
  macd_cross: ['Мачо MACD', 'Марин Моментума'], bb_bounce: ['Бони Болинджър', 'Лили Лентата'], vol_spike: ['Ванката Обема', 'Деси Децибела'],
};
const ALT = ['Бай Ганьо', 'Акулата', 'Вълчо', 'Професора', 'Лудата Лили', 'Баба Пена', 'Кирчо Котангенса', 'Ники Никела', 'Сладкия Стоп', 'Митко Мечката', 'Буля Бичка', 'Цецо Свещта', 'Жоро Ракетата', 'Пенчо Пени'];
const COLORS = ['#F2B544', '#5BC0EB', '#E86A92', '#7BD389', '#B794F6', '#FF8A5B', '#4FD1C5', '#F6E05E', '#90CDF4', '#FBB6CE'];
const gsig = g => JSON.stringify([g.zone, g.trigger, g.filters.map(f => JSON.stringify(f)).sort(), g.tp, g.sl, g.atr, g.trail, g.be, g.hold, g.rsiExit, g.vwapExit, g.size, g.maxPos]);
const KINDS = [...new Set(TRIGGER_POOL)];
// всеки има СВОЯ стратегия (няма двама с напълно еднакви правила); видовете са разпределени поравно
function pickGenome(st, also = []) {
  const cnt = Object.fromEntries(KINDS.map(k => [k, 0])); for (const b of st.bots) cnt[b.genome.trigger.t] = (cnt[b.genome.trigger.t] || 0) + 1;
  const min = Math.min(...KINDS.map(k => cnt[k])); let pool = KINDS.filter(k => cnt[k] === min && !also.includes(k)); if (!pool.length) pool = KINDS.filter(k => cnt[k] === min);
  const taken = new Set(st.bots.map(b => gsig(b.genome)));
  const zc = Object.fromEntries(ZONE_KEYS.map(z => [z, 0])); for (const b of st.bots) if (zc[b.genome.zone] != null) zc[b.genome.zone]++;
  const zmin = Math.min(...ZONE_KEYS.map(z => zc[z])); const zpool = ZONE_KEYS.filter(z => zc[z] === zmin);
  let g; for (let i = 0; i < 50; i++) { g = newGenome([], R(pool)); g.zone = R(zpool); if (!taken.has(gsig(g))) break; }
  return g;
}
// готини имена на английски: име + прякор според стратегията (напр. „Nova Gap Hunter“)
const FIRST = ['Max', 'Luna', 'Jax', 'Nova', 'Kai', 'Zoe', 'Rex', 'Ivy', 'Leo', 'Mia', 'Ace', 'Sky', 'Finn', 'Ruby', 'Cole', 'Jade', 'Axel', 'Nina', 'Theo', 'Lexi', 'Dash', 'Rio', 'Zane', 'Vera', 'Blake', 'Sasha', 'Ryder', 'Quinn', 'Milo', 'Kira', 'Cruz', 'Ella', 'Knox', 'Remy', 'Hugo', 'Skye', 'Nash', 'Duke', 'Roxy', 'Viper', 'Echo', 'Storm', 'Blaze', 'Ghost', 'Maverick', 'Raven', 'Phoenix', 'Diesel', 'Jet', 'Sage'];
const NICK = {
  orb: ['Breakout', 'Opening Bell', 'First Strike', 'Early Bird'], donchian20: ['Monthly High', 'Record Breaker', 'Peak Hunter', 'New Highs'], pdh_break: ['Ceiling Smasher', 'Roofbreaker', 'Overpass', 'Sky Ladder'],
  hod_break: ['High Climber', 'Summit', 'Day High', 'Ladder'], bull_flag: ['Flagpole', 'Bull Flag', 'Second Wind', 'Pause & Go'], fib_bounce: ['Dip Buyer', 'Discount', 'Bargain', 'Golden Ratio'],
  red_to_green: ['Red-to-Green', 'Flipper', 'Green Light', 'Turnaround'], gap_go: ['Gap Hunter', 'Morning Rocket', 'Headline', 'Gap & Go'], vwap_bounce: ['VWAP Bouncer', 'Floor Walker', 'Rebound', 'Average Joe'],
  stoch_cross: ['Patient Hunter', 'Bottom Picker', 'Reversal', 'Exhaustion'], ema_cross: ['Momentum', 'Turbo', 'Trend Rider', 'Accelerator'], rsi_bounce: ['Panic Buyer', 'Oversold', 'Comeback', 'Cool Head'],
  macd_cross: ['Turning Point', 'Brakeman', 'Wave Rider', 'Pivot'], bb_bounce: ['Rubber Band', 'Snapback', 'Spring', 'Band Bouncer'], vol_spike: ['Volume Spike', 'Crowd Surfer', 'Hype Rider', 'Loud Money'],
};
function genName(st, k) {
  const used = new Set([...st.bots.map(b => b.name), ...(st.fired || []).slice(0, 60).map(f => f.name)]);
  for (let i = 0; i < 80; i++) { const n = `${R(FIRST)} ${R(NICK[k] || ['Трейдъра'])}`; if (!used.has(n)) return n; }
  return `Trader #${st.nameSeq}`;
}
function genColor(n) { // различен цвят за всеки (златен ъгъл), като hex
  const h = (n * 137.508) % 360, s = 0.68, l = 0.66, a = s * Math.min(l, 1 - l), f = k => { const x = (k + h / 30) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(x - 3, 9 - x, 1)))).toString(16).padStart(2, '0'); };
  return '#' + f(0) + f(8) + f(4);
}
function hire(st, t, also = []) {
  const g = pickGenome(st, also);
  st.nameSeq = (st.nameSeq || 0) + 1;
  const bot = {
    id: 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: genName(st, g.trigger.t),
    color: genColor(st.nameSeq), genome: g, style: STYLE[g.trigger.t], desc: describe(g),
    hiredAt: t, cash: START_CASH, positions: [], trades: [], strikes: 0, wins: 0, losses: 0, realized: 0,
    dayStart: START_CASH, mini: [START_CASH], gen: st.nameSeq,
  };
  st.bots.push(bot);
  st.stats = st.stats || {}; const k = g.trigger.t;
  (st.stats[k] = st.stats[k] || { style: bot.style, trades: 0, wins: 0, pnl: 0, pctSum: 0, best: 0, worst: 0, hired: 0, fired: 0, minutes: 0 }).hired++;
  bot.peakEq = START_CASH;
  return bot;
}

function dedupe(st, t) {
  const seen = new Set();
  for (const bot of st.bots) { const k = gsig(bot.genome); if (!seen.has(k)) { seen.add(k); continue; }
    if (bot.positions.length || bot.trades.length) continue;
    const g = pickGenome(st); bot.genome = g; bot.style = STYLE[g.trigger.t]; bot.desc = describe(g); seen.add(gsig(g)); }
}

/* ---------------- спиране на търговията (halt) ---------------- */
// Официалният списък на Nasdaq Trader (за всички американски борси, в реално време, безплатен).
function nyMs(dateStr, timeStr) { // "10/21/2026", "15:30:20(.740)" по Ню Йорк → ms
  const [mo, d, y] = dateStr.split('/').map(Number); const [hh, mm, ss] = timeStr.split(':').map(x => Math.floor(Number(x)));
  for (const off of [4, 5]) { const g = Date.UTC(y, mo - 1, d, hh + off, mm, ss || 0); const e = etParts(g); if (e.min === hh * 60 + mm) return g; }
  return Date.UTC(y, mo - 1, d, hh + 4, mm, ss || 0);
}
async function loadHalts(st, nowMs) {
  if (st.haltsAt && nowMs - st.haltsAt < 50000) return;
  try {
    const r = await fetch('https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts', { headers: { 'User-Agent': UA['User-Agent'] } });
    if (!r.ok) throw new Error('halts ' + r.status);
    const xml = await r.text(); const tag = (it, n) => ((it.match(new RegExp(`<ndaq:${n}>([^<]*)</ndaq:${n}>`)) || [])[1] || '').trim();
    const H = {};
    for (const it of xml.split('<item>').slice(1)) {
      const sym = tag(it, 'IssueSymbol'), hd = tag(it, 'HaltDate'), ht = tag(it, 'HaltTime'); if (!sym || !hd || !ht) continue;
      const rd = tag(it, 'ResumptionDate'), rt = tag(it, 'ResumptionTradeTime');
      const h = { reason: tag(it, 'ReasonCode'), at: nyMs(hd, ht), resume: rd && rt ? nyMs(rd, rt) : null };
      if (!H[sym] || H[sym].at < h.at) H[sym] = h;
    }
    st.halts = H; st.haltsAt = nowMs;
  } catch (e) { console.error('halts', e.message); st.haltsAt = nowMs; }
}
function isHalted(st, sym, t) {
  const h = st.halts && st.halts[sym]; if (!h || h.at > t) return false;
  if (h.resume) return h.resume > t;
  if (h.reason === 'LUDP' || h.reason === 'LUDS') return t - h.at < 10 * 60000; // паузите заради волатилност са по 5–10 мин
  return t - h.at < 3 * 86400e3; // T1/T12 и др. — до обявено подновяване
}
const HALT_TXT = { LUDP: 'пауза заради резки движения (LULD)', LUDS: 'пауза заради резки движения (LULD)', T1: 'предстояща новина', T2: 'новина', T12: 'борсата иска информация', H10: 'спряна от SEC', H4: 'неспазени изисквания', MWC1: 'спад на целия пазар' };

/* ---------------- търговия ---------------- */
const round2 = n => Math.round(n * 100) / 100;
const round4 = n => Math.round(n * 10000) / 10000;
function liqValue(p, px) { const bid = px * (1 - Math.max(SLIP, (px >= 1 ? 0.005 : 0.0005) / px)); return p.qty * bid - commission(p.qty, bid) - sellFees(p.qty, bid); }
function equity(bot, prices) { return bot.cash + bot.positions.reduce((s, p) => s + liqValue(p, prices[p.sym] ?? p.entry), 0); }
// известия на телефона: събират се по време на стъпката и се пращат след записа
let PUSH = null; try { PUSH = require('./_push'); } catch (e) { PUSH = null; }
function note(st, cat, title, body, bot) { (st.outbox = st.outbox || []).push({ cat, title, body, bot: bot || null }); if (st.outbox.length > 200) st.outbox = st.outbox.slice(-200); }
const pctF = x => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(2).replace('.', ',') + '%';
const sgnM = x => (x >= 0 ? '+' : '') + money(x);
function feed(st, t, botId, kind, text) { st.feed.unshift({ t, b: botId, k: kind, x: text }); st.feed = st.feed.slice(0, 120); }
const money = n => (n < 0 ? '−$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtyF = n => n.toLocaleString('bg-BG');
const pxF = n => '$' + n.toFixed(n < 1 ? 4 : 2);

function closePos(st, bot, p, price, t, reason, limit = false) {
  const px = limit ? price : price * (1 - halfSpread(price, t)); // лимитната поръчка (целта) се изпълнява точно на цената си
  const fees = commission(p.qty, px) + sellFees(p.qty, px);
  const pnl = (px - p.entry) * p.qty - (p.feeIn || 0) - fees;
  bot.cash += p.qty * px - fees;
  bot.positions = bot.positions.filter(x => x !== p);
  const pct = pnl / (p.entry * p.qty) * 100;
  bot.trades.unshift({ sym: p.sym, qty: p.qty, entry: p.entry, exit: Math.round(px * 10000) / 10000, pnl: round2(pnl), pct: round2(pct), in: p.t, out: t, why: reason, fees: round2((p.feeIn || 0) + fees), stop: p.stop0, tp: p.tp, sigT: p.sigT, limit: p.limit, feeIn: p.feeIn });
  // такси, успеваемост и рекорди
  const allFees = (p.feeIn || 0) + fees;
  bot.fees = round2((bot.fees || 0) + allFees); st.feesAll = round2((st.feesAll || 0) + allFees); st.feesDay = round2((st.feesDay || 0) + allFees);
  st.dayClosed = (st.dayClosed || 0) + 1; if (pnl > 0) st.dayWins = (st.dayWins || 0) + 1;
  bot.closed = (bot.closed || 0) + 1; if (pnl > 0) bot.won = (bot.won || 0) + 1; bot.pctSum = round2((bot.pctSum || 0) + pct); bot.holdSum = (bot.holdSum || 0) + Math.round((t - p.t) / 60000);
  const rec = st.records = st.records || {};
  const r1 = { pct: round2(pct), pnl: round2(pnl), name: bot.name, sym: p.sym, t };
  if (!rec.best || pct > rec.best.pct) rec.best = r1;
  if (!rec.worst || pct < rec.worst.pct) rec.worst = r1;
  bot.trades = bot.trades.slice(0, 30);
  bot.realized = round2(bot.realized + pnl);
  const WHY = { tp: 'целта', sl: 'стопа (ограничи загубата)', be: 'стопа на входа', trail: 'плъзгащия стоп (пази печалбата)', time: 'времето', rsi: 'акцията прегря (поскъпна твърде бързо)', vwap: 'падна под средната цена за деня', eod: 'края на деня', fired: 'уволнението' };
  if (reason !== 'fired') note(st, 'sell', `${pnl > 0 ? '✅' : '❌'} ${bot.name} продаде ${p.sym} ${pctF(pct)}`, `${qtyF(p.qty)} акции по ${pxF(px)} · ${sgnM(pnl)} след таксите · ${WHY[reason] || reason}`, bot.id);
  feed(st, t, bot.id, pnl > 0 ? 'win' : 'loss', `${bot.name} продаде ${qtyF(p.qty)} ${p.sym} по ${pxF(px)} (${pct >= 0 ? '+' : '−'}${fmtP(Math.abs(pct).toFixed(1))}%, ${pnl >= 0 ? '+' : ''}${money(pnl)}) заради ${WHY[reason] || reason}.`);
  // статистика по стратегия (всички реални излизания)
  const k = bot.genome.trigger.t; st.stats = st.stats || {};
  const S = st.stats[k] = st.stats[k] || { style: bot.style, trades: 0, wins: 0, pnl: 0, pctSum: 0, best: 0, worst: 0, hired: 0, fired: 0, minutes: 0 };
  S.trades++; if (pnl > 0) S.wins++; S.pnl = round2(S.pnl + pnl); S.pctSum = round2(S.pctSum + pct); S.best = Math.max(S.best, round2(pct)); S.worst = Math.min(S.worst, round2(pct)); S.minutes += Math.round((t - p.t) / 60000);
  if (reason === 'fired' || reason === 'eod') return;
  if (pnl < 0) { bot.losses++; bot.strikes++; } else { bot.wins++; bot.strikes = 0; }
}
// дали трябва да бъде уволнен; връща причината или null
function fireReason(bot, prices) {
  if (bot.strikes >= STRIKES_TO_FIRE) return 'streak';
  const eq = equity(bot, prices);
  bot.peakEq = Math.max(bot.peakEq || START_CASH, eq);
  if (DD_FIRE > 0 && (bot.peakEq - eq) / bot.peakEq * 100 >= DD_FIRE) return 'dd';
  if (LOSER_TRADES > 0 && bot.wins + bot.losses >= LOSER_TRADES && eq < START_CASH) return 'loser';
  if (eq < MIN_ORDER && !bot.positions.length) return 'broke';
  return null;
}
const FIRE_TXT = { broke: () => 'защото остана без пари за нова сделка', streak: () => `след ${STRIKES_TO_FIRE} поредни загуби`, dd: () => `след спад ${DD_FIRE}% от най-високия му капитал`, loser: () => `защото е на минус след ${LOSER_TRADES} сделки` };
function fire(st, bot, t, prices, why = 'streak') {
  for (const p of [...bot.positions]) closePos(st, bot, p, prices[p.sym] ?? p.entry, t, 'fired');
  const eq = equity(bot, prices);
  const k = bot.genome.trigger.t; if (st.stats && st.stats[k]) st.stats[k].fired++;
  st.fired.unshift({ id: bot.id, name: bot.name, color: bot.color, style: bot.style, desc: bot.desc, genome: bot.genome, hiredAt: bot.hiredAt, firedAt: t, trades: bot.wins + bot.losses, wins: bot.wins, losses: bot.losses, pnl: round2(eq - START_CASH), gen: bot.gen, why: FIRE_TXT[why]() });
  st.fired = st.fired.slice(0, 60);
  st.firedToday = (st.firedToday || 0) + 1;
  st.firedAllPnl = round2((st.firedAllPnl || 0) + (eq - START_CASH)); // и от началото на състезанието — уволнението не трие загубата
  st.firedDayPnl = round2((st.firedDayPnl || 0) + (eq - (bot.dayStart ?? START_CASH))); // загубата/печалбата му днес остава в сметката на отбора
  st.bots = st.bots.filter(b => b !== bot);
  const nb = hire(st, t, [k]);
  note(st, 'fired', `🔥 ${bot.name} е УВОЛНЕН`, `${FIRE_TXT[why]()} · ${sgnM(eq - START_CASH)} общо · на мястото му идва ${nb.name} (${nb.style})`, nb.id);
  feed(st, t, bot.id, 'fired', `${bot.name} е УВОЛНЕН ${FIRE_TXT[why]()} (${eq - START_CASH >= 0 ? '+' : ''}${money(eq - START_CASH)} общо).`);
  feed(st, t, nb.id, 'hired', `Нов трейдър: ${nb.name} (${nb.style}). ${nb.desc.buy}`);
}

/* ---------------- зареждане на данните за една стъпка ---------------- */
async function loadMarket(st) {
  // минутни свещи — Yahoo; ако откаже за повечето акции, Alpaca IEX
  const bars = {}, prevClose = {}; let src = 'yahoo';
  const res = await Promise.allSettled(st.universe.map(s => yIntraday(s)));
  let okN = 0;
  res.forEach((r, k) => { if (r.status === 'fulfilled') { okN++; bars[st.universe[k]] = r.value.bars; prevClose[st.universe[k]] = r.value.prevClose; } });
  if (okN < Math.max(2, st.universe.length / 3)) {
    console.error('Yahoo failed for most symbols -> Alpaca IEX');
    const a = await alpacaIntraday(st.universe, st.session.start);
    Object.assign(bars, a); src = 'alpaca-iex';
  }
  return { bars, src, prevClose };
}

/* ---------------- една стъпка ---------------- */
async function tick(nowMs = Date.now(), pre = null) {
  let st = pre || await loadState();
  if (!st) { st = { bots: [], fired: [], feed: [], day: null, universe: [], prices: {}, lastBar: 0, created: nowMs, daily: {} }; for (let i = 0; i < N_BOTS; i++) hire(st, nowMs); feed(st, nowMs, null, 'info', `Състезанието започва! ${N_BOTS} трейдъри, по ${money(START_CASH)} фалшиви пари, всеки със своя стратегия, истински цени.`); }
  st.lastTick = nowMs; st.simMs = nowMs;
  if (st.bots.length < N_BOTS) { const add = N_BOTS - st.bots.length; const names = []; for (let i = 0; i < add; i++) names.push(hire(st, nowMs).name); note(st, 'fired', `🆕 Отборът расте: +${add} трейдъри`, names.join(', '), null); feed(st, nowMs, null, 'hired', `Отборът расте! Назначени са ${add} нови трейдъри: ${names.join(', ')}.`); }
  dedupe(st, nowMs);
  if (st.bots.some(b => !ZONES[b.genome.zone])) { st.bots.forEach((b, k) => { if (!ZONES[b.genome.zone]) { b.genome.zone = ZONE_KEYS[k % ZONE_KEYS.length]; b.desc = describe(b.genome); } }); }
  if (!st.enNames) { st.enNames = 1; for (const b of st.bots) if (/[А-Яа-я]/.test(b.name)) { const old = b.name; b.name = '·'; b.name = genName(st, b.genome.trigger.t); feed(st, nowMs, b.id, 'info', `${old} вече е ${b.name}.`); } }
  // еднократно: статистиката отпреди реалистичните сделки (без такси и спред) се нулира, за да са процентите истински
  if (st.statsV !== 2) {
    st.statsV = 2;
    for (const S of Object.values(st.stats || {})) Object.assign(S, { trades: 0, wins: 0, pnl: 0, pctSum: 0, best: 0, worst: 0, minutes: 0 });
    for (const b of st.bots) { const tr = b.trades.filter(x => x.fees != null); b.closed = tr.length; b.won = tr.filter(x => x.pnl > 0).length; b.pctSum = round2(tr.reduce((a, x) => a + x.pct, 0)); b.holdSum = tr.reduce((a, x) => a + Math.round((x.out - x.in) / 60000), 0);
      const S = st.stats && st.stats[b.genome.trigger.t]; if (S) for (const x of tr) { S.trades++; if (x.pnl > 0) S.wins++; S.pnl = round2(S.pnl + x.pnl); S.pctSum = round2(S.pctSum + x.pct); S.best = Math.max(S.best, x.pct); S.worst = Math.min(S.worst, x.pct); S.minutes += Math.round((x.out - x.in) / 60000); } }
  }
  // еднократно: уволнените по-рано днес (преди тази версия) също влизат в сметката на отбора
  if (st.firedAllPnl === undefined) st.firedAllPnl = round2((st.fired || []).reduce((a, f) => a + f.pnl, 0));
  if (st.firedDayPnl === undefined) st.firedDayPnl = round2((st.fired || []).filter(f => st.day && etParts(f.firedAt).date === st.day && etParts(f.hiredAt).date === st.day).reduce((a, f) => a + f.pnl, 0));
  const et = etParts(nowMs);

  // сесията за деня (и почивните дни) от Yahoo — по водещата акция SPY
  if (st.day !== et.date || !st.sessionChecked || (!st.session && nowMs - st.sessionChecked > 30 * 60000)) {
    let session = null;
    try { session = (await yIntraday('SPY')).session; } catch (e) { console.error('session', e.message); }
    const wk = new Date(nowMs).getUTCDay();
    if (!session && wk !== 0 && wk !== 6) { // резерва: 9:30–16:00 в Ню Йорк
      for (const off of [4, 5]) { const s = Date.parse(`${et.date}T09:30:00Z`) + off * 3600e3; if (etParts(s).min === 570) { session = { start: s - 330 * 60000, regStart: s, end: s + 390 * 60000, guess: true }; break; } }
    }
    if (st.day !== et.date) {
      st.day = et.date; st.universe = []; st.radar = []; st.radarMeta = {}; st.lastBar = 0; st.firedToday = 0; st.firedDayPnl = 0; st.dayTrades = 0; st.feesDay = 0; st.dayClosed = 0; st.dayWins = 0; st.daily = {}; st.dayDone = null;
      for (const b of st.bots) { b.pending = null; b.dayStart = round2(equity(b, st.prices)); }
      st.histDue = 1;
    }
    st.session = session && etParts(session.start).date === et.date ? session : null;
    st.sessionChecked = nowMs;
  }
  if (!st.session) { st.status = [0, 6].includes(new Date(nowMs).getUTCDay()) ? 'weekend' : 'holiday'; await saveState(st); return st; }
  const { start, end } = st.session; const regStart = st.session.regStart || start; REG_START = regStart;
  if (nowMs < start) { st.status = 'pre'; await saveState(st); return st; }
  if (st.dayDone === st.day) { st.status = 'closed'; await saveState(st); return st; }
  st.status = nowMs < regStart ? 'premarket' : 'open';

  const reopenPick = st.radarAt && st.radarAt < regStart && nowMs >= regStart + 5 * 60000;
  if (!st.radar || !st.radar.length || reopenPick || (st.radarAt && nowMs - st.radarAt > 20 * 60000 && nowMs < end - 30 * 60000)) {
    const before = new Set((st.radar || []).map(m => m.s));
    try { const r = await pickRadar(); if (r.length >= 6) { st.radar = r; st.radarAt = nowMs; } } catch (e) { console.error('radar', e.message); }
    if (!st.radar || !st.radar.length) { st.radar = (await pickUniverse()).map((s2, k) => ({ s: s2, n: 1, px: 0, chg: 0, vol: 0, vr: k + 1 })); st.radarAt = nowMs; }
    const added = st.radar.map(m => m.s).filter(x => !before.has(x));
    if (added.length) feed(st, nowMs, null, 'info', before.size ? `Радарът се обнови: ${st.radar.length} акции (${added.length} нови).` : `${nowMs < regStart ? 'Премаркет! ' : ''}Радарът сканира ${st.radar.length} акции — всеки трейдър ловува в своята територия.`);
  }
  st.universe = await pickFocus(st, nowMs, start);
  // дневни данни (20-дневен връх, вчерашен връх/затваряне, среден дневен обем) — веднъж на ден за акция
  st.daily = st.daily || {};
  const need = st.universe.filter(s => !st.daily[s]);
  if (need.length) {
    const r = await Promise.allSettled(need.map(s => yDaily(s)));
    r.forEach((x, k) => { st.daily[need[k]] = x.status === 'fulfilled' ? dailyCtx(x.value, start) : {}; });
  }

  await loadHalts(st, nowMs);
  const { bars, src, prevClose } = await loadMarket(st);
  st.src = src;
  const IND = {}, idx = {};
  for (const [s, arr0] of Object.entries(bars)) {
    const arr = arr0.filter(b => b.t >= start && b.t < end);
    if (arr.length < 2) continue;
    const ctx = { ...(st.daily[s] || {}) }; if (!ctx.pdc && prevClose[s]) ctx.pdc = prevClose[s];
    const ri = arr.findIndex(b => b.t >= regStart); ctx.regIdx = ri >= 0 ? ri : null; ctx.sessStart = start; ctx.sessEnd = end;
    IND[s] = indic(arr, ctx); IND[s].t = arr.map(b => b.t); idx[s] = new Map(arr.map((b, i) => [b.t, i]));
  }
  // обработваме само завършени минути, които още не сме видели
  const cutoff = Math.min(nowMs - 60000, end - 60000);
  const times = [...new Set(Object.values(idx).flatMap(m => [...m.keys()]))].sort((a, b) => a - b).filter(t => t > (st.lastBar || 0) && t <= cutoff);
  const entryFrom = start + 5 * 60000, entryTo = end - 30 * 60000, eodAt = end - 5 * 60000;

  for (const t of times) {
    for (const s in IND) { const i = idx[s].get(t); if (i != null) st.prices[s] = IND[s].c[i]; }
    for (let bi = 0; bi < st.bots.length; bi++) {
      let bot = st.bots[bi];
      if (bot.hiredAt >= t) continue; // новоназначеният започва от следващата минута
      const g = bot.genome;
      // 1) поръчката от предишната минута се изпълнява на отварянето на тази (като в истински живот: виждаш сигнала, после купуваш)
      if (bot.pending) {
        const q = bot.pending, I = IND[q.s], i = I && idx[q.s].get(t);
        if (t >= eodAt || t - q.t > 3 * 60000) { bot.pending = null; if (t < eodAt) feed(st, t, bot.id, 'info', `${bot.name} отказа поръчката за ${q.s} — 3 минути никой не продаде на неговата цена.`); }
        else if (i != null && t > q.t) {
          bot.pending = null;
          const o = I.o[i], fill = o * (1 + halfSpread(o, t));
          if (fill > q.limit) feed(st, t, bot.id, 'info', `${bot.name} не успя да купи ${q.s}: цената отвори на ${pxF(o)}, над лимита му ${pxF(q.limit)}.`);
          else {
            const eq = equity(bot, st.prices);
            let qty = Math.floor(Math.min(bot.cash - COMM_MIN, Math.max(eq * g.size, Math.min(bot.cash, MIN_ORDER * 1.2))) / fill);
            qty = Math.min(qty, Math.floor(q.liq));
            while (qty > 0 && qty * fill + commission(qty, fill) > bot.cash) qty--;
            if (qty >= 1 && qty * fill >= MIN_ORDER) {
              const fee = commission(qty, fill);
              const stop = Math.max(0.0001, g.atr ? Math.min(fill * 0.99, fill - g.atr * q.atr) : fill * (1 - g.sl / 100));
              bot.cash -= qty * fill + fee;
              bot.positions.push({ sym: q.s, qty, entry: fill, t, peak: fill, stop, stop0: round4(stop), tp: round4(fill * (1 + g.tp / 100)), feeIn: round2(fee), sigT: q.t, limit: q.limit });
              st.dayTrades = (st.dayTrades || 0) + 1;
              note(st, 'buy', `🟢 ${bot.name} купи ${q.s}`, `${qtyF(qty)} акции по ${pxF(fill)} · ${money(qty * fill)} · ${STYLE[g.trigger.t]}`, bot.id);
              feed(st, t, bot.id, 'buy', `${bot.name} купи ${qtyF(qty)} ${q.s} по ${pxF(fill)} (${money(qty * fill)} + такса ${money(fee)}).`);
            } else if (q.liq < 1 || qty < 1) feed(st, t, bot.id, 'info', `${bot.name} пропусна ${q.s} — твърде малко се търгува, за да влезе с реална сума.`);
          }
        }
      }
      // 2) излизане
      for (const p of [...bot.positions]) {
        const I = IND[p.sym]; const i = I && idx[p.sym].get(t);
        if (isHalted(st, p.sym, t)) { if (!p.haltSeen) { p.haltSeen = t; note(st, 'sell', `⏸ ${p.sym} е спряна (halt)`, `${bot.name} не може да продаде, докато борсата не я пусне.`, bot.id); feed(st, t, bot.id, 'info', `⏸ ${p.sym} е спряна от борсата (halt) — ${bot.name} не може да продаде, докато не я пуснат.`); } continue; }
        if (p.haltSeen) { p.haltSeen = 0; feed(st, t, bot.id, 'info', `▶ ${p.sym} се търгува отново — ${bot.name} може да продава.`); }
        if (i == null) { if (t >= eodAt) closePos(st, bot, p, st.prices[p.sym] ?? p.entry, t, 'eod'); continue; }
        const o = I.o[i], hi = I.h[i], lo = I.l[i], c = I.c[i], pre = t < regStart;
        if (p.exitAt && t > p.exitT) closePos(st, bot, p, o, t, p.exitAt); // решено на затварянето на миналата минута → продава на отварянето
        else {
          // нивата са от предишните минути — не знаем дали в минутата първо е бил върхът или дъното
          if (g.be && p.peak >= p.entry * (1 + g.be / 100)) p.stop = Math.max(p.stop, p.entry);
          const trP = g.trail && p.peak > p.entry * 1.01 ? p.peak * (1 - g.trail / 100) : 0;
          const lvl = Math.max(p.stop, trP), why = trP > p.stop ? 'trail' : p.stop >= p.entry ? 'be' : 'sl';
          const tpP = p.tp || p.entry * (1 + g.tp / 100);
          if (t >= eodAt) closePos(st, bot, p, c, t, 'eod');
          else if (!pre && lo <= lvl) closePos(st, bot, p, Math.min(lvl, o), t, why); // стоп поръчка: при гап се изпълнява по-ниско
          else if (hi >= tpP) closePos(st, bot, p, Math.max(tpP, o), t, 'tp', true); // лимитна поръчка на целта
          else if (pre && c <= lvl) { p.exitAt = why; p.exitT = t; } // в премаркета стоповете не се задействат сами — продава на следващата минута
          else if ((t - p.t) / 60000 >= g.hold) { p.exitAt = 'time'; p.exitT = t; }
          else if (g.rsiExit && I.rsi(14)[i] > 80) { p.exitAt = 'rsi'; p.exitT = t; }
          else if (g.vwapExit && c < I.vwap[i] && t - p.t > 3 * 60000) { p.exitAt = 'vwap'; p.exitT = t; }
          if (bot.positions.includes(p)) p.peak = Math.max(p.peak || p.entry, hi);
        }
        if (bot.strikes >= STRIKES_TO_FIRE && !bot.positions.some(q => isHalted(st, q.sym, t))) { fire(st, bot, t, st.prices, 'streak'); bot = null; break; }
      }
      if (bot && !bot.positions.some(p => isHalted(st, p.sym, t))) { const why = fireReason(bot, st.prices); if (why) { fire(st, bot, t, st.prices, why); bot = null; } }
      if (!bot) { bi--; continue; } // уволненият е махнат; следващият бот се измества на същото място
      if (t < entryFrom || t > entryTo || bot.pending || bot.positions.length >= g.maxPos) continue;
      let best = null;
      for (const s in IND) {
        if (bot.positions.some(p => p.sym === s) || isHalted(st, s, t)) continue;
        const I = IND[s]; const i = idx[s].get(t); if (i == null) continue;
        const px = I.c[i]; if (px < PRICE_MIN || px > PRICE_MAX) continue; // под $1 и над $20 не купува
        if (!inZone(g.zone, I, i, st.radarMeta && st.radarMeta[s])) continue;
        if (!sig(g, I, i)) continue;
        const score = I.v[i] / (I.avgV[i - 1] || 1);
        if (!best || score > best.score) best = { s, px, score, atr: I.atr[i], liq: LIQ_SHARE * Math.max(I.avgV[i] || 0, 1) };
      }
      // 3) сигнал на затварянето на минутата → лимитна поръчка за следващата (до +1%, в премаркета до +2%)
      if (best) bot.pending = { s: best.s, t, px: best.px, limit: round4(best.px * (t < regStart ? 1.02 : 1.01)), atr: best.atr, liq: best.liq };
    }
    st.lastBar = t;
  }
  // най-новата цена за екрана: последната (още незавършена) минута от Yahoo или Finnhub, ако е по-нова
  await liveQuotes(st, st.universe, nowMs).catch(() => {});
  let newest = 0;
  for (const [s, arr0] of Object.entries(bars)) {
    const lb = arr0[arr0.length - 1]; if (!lb || lb.t < start || lb.t >= end + 60000 || isHalted(st, s, nowMs)) continue;
    let px = lb.c, pt = lb.t + 30000; const L = st.live && st.live[s];
    if (L && L.t > pt && nowMs - L.t < 5 * 60000) { px = L.px; pt = L.t; }
    st.prices[s] = px; newest = Math.max(newest, pt);
  }
  st.dataT = newest || st.dataT; st.srcLive = FINNHUB ? 'yahoo+finnhub' : 'yahoo';
  st.ticker = st.universe.map(s => { const px = st.prices[s]; const pc = st.daily?.[s]?.pdc || IND[s]?.ctx?.pdc; return px ? { s, px, chg: pc ? round2((px / pc - 1) * 100) : null, halt: isHalted(st, s, nowMs) || undefined } : null; }).filter(Boolean);
  // точка в историята на парите на всеки трейдър — на 5 минути (и при нов ден); мини графиката се пази в основния запис
  if (st.histDue || !st.histAt || nowMs - st.histAt >= 5 * 60000) {
    const H = await loadHist(); const N = {};
    for (const b of st.bots) { const h = H[b.id] || [[b.hiredAt, START_CASH]]; h.push([nowMs, round2(equity(b, st.prices))]); N[b.id] = thinHist(h, start); b.mini = mini(N[b.id]); }
    await saveHist(N); st.histAt = nowMs; st.histDue = 0;
  }
  if (!st.teamHist) st.teamHist = [];
  const teamNow = round2(st.bots.reduce((a, b) => a + equity(b, st.prices) - START_CASH, 0) + (st.firedAllPnl || 0));
  const lastTeam = st.teamHist[st.teamHist.length - 1];
  if (!lastTeam || nowMs - lastTeam[0] >= 50000) st.teamHist.push([nowMs, teamNow]); else lastTeam[1] = teamNow;
  if (st.teamHist.length > 2600) { // по-старите от 2 дни — по една точка на 15 минути
    const cut = nowMs - 2 * 86400e3, thin = []; let lb = -1;
    for (const p of st.teamHist) { if (p[0] >= cut) { thin.push(p); continue; } const k = Math.floor(p[0] / 900000); if (k !== lb) { thin.push(p); lb = k; } else thin[thin.length - 1] = p; }
    st.teamHist = thin.slice(-2600);
  }
  if (nowMs >= end) {
    for (const b of st.bots) { b.pending = null; for (const p of [...b.positions]) { if (isHalted(st, p.sym, end)) { if (!p.overnight) { p.overnight = 1; feed(st, end, b.id, 'info', `${b.name} остава с ${p.sym} за утре — акцията е спряна и не може да се продаде.`); } continue; } closePos(st, b, p, st.prices[p.sym] ?? p.entry, end, 'eod'); } }
    st.status = 'closed';
    if (st.dayDone !== st.day) {
      st.dayDone = st.day;
      const teamDay = round2(st.bots.reduce((a, b) => a + equity(b, st.prices) - b.dayStart, 0) + (st.firedDayPnl || 0));
      st.dayHist = [...(st.dayHist || []).filter(x => x.d !== st.day), { d: st.day, pnl: teamDay }].slice(-120);
      const top = [...st.bots].sort((a, b) => (equity(b, st.prices) - b.dayStart) - (equity(a, st.prices) - a.dayStart))[0];
      { const R = [...st.bots].map(b => ({ b, d: equity(b, st.prices) / b.dayStart - 1 })).sort((a, b) => b.d - a.d); const wr = st.dayClosed ? Math.round((st.dayWins || 0) / st.dayClosed * 100) : 0;
        note(st, 'summary', `📊 Денят свърши: отборът ${sgnM(teamDay)}`, `${st.dayTrades || 0} сделки · ${st.dayWins || 0} от ${st.dayClosed || 0} на печалба (${wr}%) · уволнени ${st.firedToday || 0}` + (R[0] ? ` · най-добър: ${R[0].b.name} ${sgnP(R[0].d * 100)}` : '') + (R.length > 1 ? ` · най-слаб: ${R[R.length - 1].b.name} ${sgnP(R[R.length - 1].d * 100)}` : ''), null); }
      if (top) { const d = equity(top, st.prices) - top.dayStart; feed(st, end, top.id, 'info', `Денят свърши. Трейдър на деня: ${top.name} (${d >= 0 ? '+' : ''}${money(d)}).`); }
    }
  }
  const out = st.outbox || []; st.outbox = [];
  await saveState(st);
  if (out.length && PUSH) await PUSH.flush(out).catch(e => console.error('push flush', e.message));
  return st;
}

// историята на парите на трейдъра: днес — точка на 2 мин, по-старите дни — на 30 мин (пести памет при 100 трейдъри)
function thinHist(h, dayStartMs) {
  const out = []; let lastK = null;
  for (const p of h) { const k = p[0] < dayStartMs ? 'o' + Math.floor(p[0] / 1800000) : 'd' + Math.floor(p[0] / 120000); if (k === lastK) out[out.length - 1] = p; else { out.push(p); lastK = k; } }
  return out.slice(-500);
}

/* ---------------- публичен изглед ---------------- */
function mini(h, n = 40) { const pick = h.length <= n ? h : Array.from({ length: n }, (_, i) => h[Math.round(i * (h.length - 1) / (n - 1))]); return pick.map(p => p[1]); }
function view(st, nowMs = Date.now(), opts = {}) {
  if (!st) return { empty: true };
  const prices = st.prices || {};
  const bots = st.bots.map(b => {
    const eq = equity(b, prices);
    return {
      id: b.id, name: b.name, color: b.color, style: STYLE[b.genome.trigger.t], tech: TECH[b.genome.trigger.t], strat: b.genome.trigger.t, desc: opts.full === b.id ? describe(b.genome) : undefined, gen: b.gen, hiredAt: b.hiredAt,
      equity: round2(eq), today: round2(eq - b.dayStart), todayPct: round2((eq / b.dayStart - 1) * 100), total: round2(eq - START_CASH),
      strikes: b.strikes, wins: b.wins, losses: b.losses, closed: b.closed || 0, won: b.won || 0,
      winRate: b.closed ? Math.round((b.won || 0) / b.closed * 100) : null, avgPct: b.closed ? round2((b.pctSum || 0) / b.closed) : null, avgHold: b.closed ? Math.round((b.holdSum || 0) / b.closed) : null, cash: round2(b.cash), hist: opts.full === b.id ? [...(opts.hist || [[b.hiredAt, START_CASH]]), [nowMs, round2(eq)]] : undefined, mini: [...(b.mini || [START_CASH]).slice(-39), round2(eq)], full: opts.full === b.id,
      dd: round2(Math.max(0, ((Math.max(b.peakEq || START_CASH, eq) - eq) / Math.max(b.peakEq || START_CASH, eq)) * 100)),
      risk: Math.min(1, Math.max(b.strikes / STRIKES_TO_FIRE, DD_FIRE > 0 ? ((Math.max(b.peakEq || START_CASH, eq) - eq) / Math.max(b.peakEq || START_CASH, eq)) * 100 / DD_FIRE : 0, LOSER_TRADES > 0 && eq < START_CASH ? (b.wins + b.losses) / LOSER_TRADES : 0)),
      positions: b.positions.map(p => { const g = b.genome, now = prices[p.sym] ?? p.entry; const trP = g.trail && p.peak > p.entry * 1.01 ? p.peak * (1 - g.trail / 100) : 0;
        const pnl = round2(liqValue(p, now) - p.entry * p.qty - (p.feeIn || 0));
        return { sym: p.sym, qty: p.qty, entry: p.entry, now, pnl, pct: round2(pnl / (p.entry * p.qty) * 100), t: p.t, stop: round4(Math.max(p.stop, trP)), tp: p.tp || round4(p.entry * (1 + g.tp / 100)), exiting: p.exitAt || null, halted: isHalted(st, p.sym, nowMs) ? (HALT_TXT[(st.halts[p.sym] || {}).reason] || 'спряна от борсата') : null, holdUntil: p.t + g.hold * 60000, sigT: p.sigT || null, limit: p.limit || null, feeIn: p.feeIn || 0 }; }),
      pending: b.pending ? { s: b.pending.s, limit: b.pending.limit, t: b.pending.t } : null,
      trades: opts.full === b.id ? b.trades : undefined, last: b.trades[0] || null,
      todayN: b.trades.filter(t => t.out >= ((st.session && st.session.start) || 0)).length, todayW: b.trades.filter(t => t.out >= ((st.session && st.session.start) || 0) && t.pnl > 0).length, fees: round2(b.fees || 0), hold: b.genome.hold, maxPos: b.genome.maxPos, zone: b.genome.zone ? ZONES[b.genome.zone].name : null,
    };
  }).sort((a, b) => b.todayPct - a.todayPct || b.total - a.total);
  return { scan: st.scan || null, zones: Object.fromEntries(ZONE_KEYS.map(z => [ZONES[z].name, st.bots.filter(b => b.genome.zone === z).length])), dataT: st.dataT || null, srcLive: st.srcLive || 'yahoo', status: st.status, day: st.day, simMs: st.simMs, lastTick: st.lastTick, lastBar: st.lastBar, src: st.src, strikesToFire: STRIKES_TO_FIRE, ddFire: DD_FIRE, loserTrades: LOSER_TRADES, startCash: START_CASH, nBots: N_BOTS, ticker: st.ticker || [],
    stats: Object.entries(st.stats || {}).map(([k, x]) => ({ k, ...x, style: STYLE[k] || x.style, tech: TECH[k], winRate: x.trades ? Math.round(x.wins / x.trades * 100) : null, avgPct: x.trades ? round2(x.pctSum / x.trades) : null, avgMin: x.trades ? Math.round(x.minutes / x.trades) : null })).sort((a, b) => b.pnl - a.pnl),
    session: st.session, universe: st.universe, bots, feed: st.feed.slice(0, 60), fired: st.fired.slice(0, 40).map(f => { const k = Object.keys(TECH).find(q => TECH[q] === f.style || STYLE[q] === f.style); const out = k ? { ...f, style: STYLE[k], strat: k } : { ...f }; if (f.genome) out.desc = describe(f.genome); delete out.genome; return out; }), firedToday: st.firedToday || 0, firedDayPnl: st.firedDayPnl || 0, teamHist: st.teamHist || [], feesAll: st.feesAll || 0, feesDay: st.feesDay || 0, dayClosed: st.dayClosed || 0, dayWins: st.dayWins || 0, dayHist: st.dayHist || [],
    records: (() => { const R = { ...(st.records || {}) }; const ss = st.session && st.session.start || 0;
      const surv = [...st.bots.map(b => ({ name: b.name, ms: nowMs - b.hiredAt, alive: true })), ...(st.fired || []).map(f => ({ name: f.name, ms: f.firedAt - f.hiredAt, alive: false }))].sort((a, b) => b.ms - a.ms)[0];
      const most = st.bots.map(b => ({ name: b.name, n: b.trades.filter(t => t.out >= ss).length })).sort((a, b) => b.n - a.n)[0];
      const bestDay = (st.dayHist || []).slice().sort((a, b) => b.pnl - a.pnl)[0];
      return { ...R, survivor: surv || null, most: most || null, bestDay: bestDay || null }; })(), firedAllPnl: st.firedAllPnl || 0, teamTotal: round2(bots.reduce((a, b) => a + b.total, 0) + (st.firedAllPnl || 0)), teamToday: round2(bots.reduce((a, b) => a + b.today, 0) + (st.firedDayPnl || 0)), dayTrades: st.dayTrades || 0, serverNow: nowMs };
}

async function tickWithLock(nowMs = Date.now(), minGapMs = 50000) {
  // първо малкия запис с часа на последната стъпка — голямото състояние се чете само ако наистина ще работим
  const last = Number(await kv(['GET', STATE_KEY + ':t'])) || 0;
  if (last && nowMs - last < minGapMs) return { st: null, ran: false };
  const got = await kv(['SET', 'arena:lock', String(nowMs), 'NX', 'EX', 55]);
  if (got !== 'OK') return { st: null, ran: false };
  try { const st = await tick(nowMs); await kv(['SET', STATE_KEY + ':t', String(nowMs)]); return { st, ran: true }; }
  finally { await kv(['DEL', 'arena:lock']); }
}

module.exports = { tick, tickWithLock, loadState, loadHist, view, kv, yIntraday, alpacaIntraday, yget, ybars,
  // общи инструменти, които ползва и декът (_desk.js)
  H: { etParts, yScreen, ySpark, pickRadar, yDaily, dailyCtx, indic, loadHalts, isHalted, HALT_TXT, sellFees, okSym, OTC, PRICE_MIN, PRICE_MAX }, _test: { dedupe, newGenome, describe, indic, sig, etParts, TRIGGERS } };
