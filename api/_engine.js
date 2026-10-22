// Fired Up — двигателят на състезанието.
// 5 бота търгуват penny stocks с фалшиви $10 000. Две поредни загуби = уволнение и нов бот с друга стратегия.
// Данни в реално време: Yahoo Finance (минутни свещи с обем, без ключ). Ако Yahoo откаже —
// Alpaca IEX в реално време (нужни ALPACA_KEY_ID / ALPACA_SECRET_KEY, по желание).
// Нужно във Vercel: свързана Upstash памет (KV_REST_API_URL / KV_REST_API_TOKEN).

const START_CASH = 10000;
const SLIP = 0.002;          // 0,2% приплъзване при покупка и при продажба (широк спред при penny stocks)
const SLIP_PRE = 0.005;      // 0,5% в премаркета — спредовете тогава са много по-широки
let REG_START = 0;           // кога е истинското отваряне днес (9:30 НЙ)
const slipAt = t => (REG_START && t < REG_START ? SLIP_PRE : SLIP);
const N_BOTS = Number(process.env.N_BOTS || 10);
const STRIKES_TO_FIRE = Number(process.env.STRIKES_TO_FIRE || 3);   // правило 1: поредни загуби
const DD_FIRE = Number(process.env.DD_FIRE || 5);                   // правило 2: % просадка от най-високия капитал
const LOSER_TRADES = Number(process.env.LOSER_TRADES || 15);        // правило 3: на минус след толкова сделки
const PRICE_MIN = 0.5, PRICE_MAX = 5;
const UNIVERSE_N = 16;
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
const STATE_KEY = 'arena:v2';
async function loadState() { const s = await kv(['GET', STATE_KEY]); return s ? JSON.parse(s) : null; }
async function saveState(st) { await kv(['SET', STATE_KEY, JSON.stringify(st)]); }

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
  return (d?.finance?.result?.[0]?.quotes || []).map(q => ({ sym: q.symbol, price: q.regularMarketPrice, vol: q.regularMarketVolume, chg: q.regularMarketChangePercent }));
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
async function pickUniverse() {
  const score = new Map();
  for (const [id, w] of [['small_cap_gainers', 3], ['day_gainers', 2], ['most_actives', 2]]) {
    try {
      for (const q of await yScreen(id)) {
        if (!okSym(q.sym) || !(q.price >= PRICE_MIN && q.price <= PRICE_MAX) || !(q.vol > 300000)) continue;
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
function newGenome(avoid = []) {
  // всеки трейдър в отбора е с различна стратегия; ако може — и не същата като току-що уволнения
  const free = TRIGGER_POOL.filter(t => !avoid.includes(t));
  const trig = R(free.length ? free : TRIGGER_POOL);
  const fkeys = Object.keys(FILTERS).sort(() => Math.random() - 0.5).slice(0, R([0, 1, 1, 2]));
  const atrStop = Math.random() < 0.4;
  return {
    trigger: { t: trig, ...TRIGGERS[trig]() },
    filters: fkeys.map(k => ({ t: k, ...FILTERS[k]() })),
    tp: R([4, 5, 8, 10, 15]), sl: atrStop ? 0 : R([2, 3, 4, 5]), atr: atrStop ? R([1.5, 2, 3]) : 0,
    trail: R([0, 0, 2, 3, 5]), be: R([0, 0, 2, 3]), hold: R([20, 30, 60, 90, 180]),
    rsiExit: Math.random() < 0.25, vwapExit: Math.random() < 0.25,
    size: R([0.25, 0.5, 0.5, 1]), maxPos: R([1, 1, 2]),
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
  const T = g.trigger;
  const trig = {
    orb: `цената пробие диапазона на първите ${T.n} минути (ORB) с обем над средния`,
    donchian20: `цената пробие най-високото от последните 20 дни с обем ${fmtP(T.k)}× над средния`,
    pdh_break: 'цената пробие вчерашния връх със зелена свещ',
    hod_break: `акцията се отдръпне поне ${T.pull}% и после направи нов връх за деня`,
    bull_flag: `има бичи флаг: ръст поне ${T.run}%, спокойно отдръпване с по-малък обем и пробив нагоре`,
    fib_bounce: `цената се върне до Фибоначи ${T.lvl === 0.5 ? '50%' : '61,8%'} от дневния ръст и отскочи`,
    red_to_green: 'акцията мине от червено в зелено (над вчерашното затваряне) с обем',
    gap_go: `акцията е отворила с гап над ${T.g}% и пробие върха на първите 5 минути`,
    vwap_bounce: 'цената, която е над VWAP, се отдръпне до VWAP и отскочи',
    stoch_cross: `Стохастикът се обърне нагоре под ${T.lvl}`,
    ema_cross: `бързата EMA(${T.f}) пресече нагоре бавната EMA(${T.s})`,
    rsi_bounce: `RSI(${T.n}) излезе нагоре от зоната под ${T.th}`,
    macd_cross: 'MACD пресече сигналната линия нагоре под нулата',
    bb_bounce: 'цената отскочи от долната лента на Болинджър',
    vol_spike: `обемът скочи ${T.k}× над средния със зелена свещ`,
  }[T.t];
  const filt = g.filters.map(F => ({
    above_vwap: 'цената е над VWAP', above_ema: `цената е над EMA(${F.n})`, rsi_range: `RSI(14) е между ${F.lo} и ${F.hi}`,
    day_gainer: `акцията е нагоре с над ${F.g}% за деня`, rvol: `относителният обем (RVOL) е над ${fmtP(F.k)}`,
    vol_confirm: `обемът на свещта е над ${fmtP(F.k)}× средния`, green_streak: `последните ${F.k} свещи са зелени`,
  }[F.t]));
  const buy = `Купува, когато ${trig}` + (filt.length ? `, но само ако ${filt.join(' и ')}` : '') + '.';
  const stop = g.atr ? `стоп ${fmtP(g.atr)}× ATR под входа` : `стоп −${g.sl}%`;
  const sell = `Цел +${g.tp}%, ${stop}` + (g.trail ? `, плъзгащ стоп ${g.trail}% под върха` : '') + (g.be ? `, стопът отива на входа след +${g.be}%` : '') +
    `, най-много ${g.hold} мин в позиция` + (g.rsiExit ? '; излиза и ако RSI(14) мине 80' : '') + (g.vwapExit ? '; излиза и ако цената падне под VWAP' : '') + '.';
  const size = `Влага ${Math.round(g.size * 100)}% от парите си, най-много ${g.maxPos} ${g.maxPos === 1 ? 'позиция' : 'позиции'} наведнъж.`;
  return { buy, sell, size };
}
const STYLE = { orb: 'ORB', donchian20: '20-дневен пробив', pdh_break: 'Вчерашен връх', hod_break: 'Нов връх на деня', bull_flag: 'Бичи флаг', fib_bounce: 'Фибоначи', red_to_green: 'Red-to-green', gap_go: 'Gap & Go', vwap_bounce: 'VWAP отскок', stoch_cross: 'Стохастик', ema_cross: 'EMA кръст', rsi_bounce: 'RSI отскок', macd_cross: 'MACD', bb_bounce: 'Болинджър', vol_spike: 'Скок в обема' };
const NAMES = {
  orb: ['Орлин Пробива', 'Ори Първите 15'], donchian20: ['Дончо Двайсетака', 'Дони Канала'], pdh_break: ['Вчерашния Вальо', 'Пешо Пробива'],
  hod_break: ['Христо Върха', 'Ходи Новия Връх'], bull_flag: ['Флагмана Фичо', 'Бичка Флагова'], fib_bounce: ['Фиби Фибоначи', 'Леонардо 61,8'],
  red_to_green: ['Зеления Злати', 'Ред-Грийн Роки'], gap_go: ['Гошо Гапа', 'Гап Галя'], vwap_bounce: ['Вики VWAP', 'Валя Средната'],
  stoch_cross: ['Стоян Стохастика', 'Стефка Осцилатора'], ema_cross: ['Ема Трендова', 'Тошко Тренда'], rsi_bounce: ['Роси RSI', 'Ради Отскока'],
  macd_cross: ['Мачо MACD', 'Марин Моментума'], bb_bounce: ['Бони Болинджър', 'Лили Лентата'], vol_spike: ['Ванката Обема', 'Деси Децибела'],
};
const ALT = ['Бай Ганьо', 'Акулата', 'Вълчо', 'Професора', 'Лудата Лили', 'Баба Пена', 'Кирчо Котангенса', 'Ники Никела', 'Сладкия Стоп', 'Митко Мечката', 'Буля Бичка', 'Цецо Свещта', 'Жоро Ракетата', 'Пенчо Пени'];
const COLORS = ['#F2B544', '#5BC0EB', '#E86A92', '#7BD389', '#B794F6', '#FF8A5B', '#4FD1C5', '#F6E05E', '#90CDF4', '#FBB6CE'];
function hire(st, t, also = []) {
  const taken = st.bots.map(b => b.genome.trigger.t);
  const free = TRIGGER_POOL.filter(k => !taken.includes(k));
  const g = newGenome(free.some(k => !also.includes(k)) ? [...taken, ...also] : taken);
  st.nameSeq = (st.nameSeq || 0) + 1;
  const used = new Set([...st.bots.map(b => b.name), ...(st.fired || []).map(f => f.name)]);
  const own = (NAMES[g.trigger.t] || []).filter(n => !used.has(n)), alt = ALT.filter(n => !used.has(n));
  const name = own.length && Math.random() < 0.8 ? R(own) : alt.length ? R(alt) : own.length ? R(own) : `Трейдър №${st.nameSeq}`;
  const usedColors = new Set(st.bots.map(b => b.color));
  const bot = {
    id: 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name,
    color: COLORS.find(c => !usedColors.has(c)) || R(COLORS), genome: g, style: STYLE[g.trigger.t], desc: describe(g),
    hiredAt: t, cash: START_CASH, positions: [], trades: [], strikes: 0, wins: 0, losses: 0, realized: 0,
    dayStart: START_CASH, hist: [[t, START_CASH]], gen: st.nameSeq,
  };
  st.bots.push(bot);
  st.stats = st.stats || {}; const k = g.trigger.t;
  (st.stats[k] = st.stats[k] || { style: bot.style, trades: 0, wins: 0, pnl: 0, pctSum: 0, best: 0, worst: 0, hired: 0, fired: 0, minutes: 0 }).hired++;
  bot.peakEq = START_CASH;
  return bot;
}

function dedupe(st, t) {
  const seen = new Set();
  for (const bot of [...st.bots].sort((a, b) => (b.wins + b.losses) - (a.wins + a.losses) || a.hiredAt - b.hiredAt)) {
    const k = bot.genome.trigger.t;
    if (!seen.has(k)) { seen.add(k); continue; }
    if (bot.positions.length) continue; // ще го смени, като затвори сделката
    const taken = st.bots.map(b => b.genome.trigger.t);
    const g = newGenome(taken); const nk = g.trigger.t;
    if (taken.includes(nk)) continue;
    const used = new Set([...st.bots.map(b => b.name), ...(st.fired || []).map(f => f.name)]);
    const own = (NAMES[nk] || []).filter(n => !used.has(n));
    const oldName = bot.name, rename = (NAMES[k] || []).includes(oldName) && own.length;
    if (rename) bot.name = R(own);
    bot.genome = g; bot.style = STYLE[nk]; bot.desc = describe(g);
    st.stats = st.stats || {};
    if (st.stats[k] && st.stats[k].hired > 0) st.stats[k].hired--;
    (st.stats[nk] = st.stats[nk] || { style: bot.style, trades: 0, wins: 0, pnl: 0, pctSum: 0, best: 0, worst: 0, hired: 0, fired: 0, minutes: 0 }).hired++;
    seen.add(nk);
    feed(st, t, bot.id, 'info', `${oldName} сменя стратегията, за да няма двама с еднаква: ${rename ? 'вече е ' + bot.name + ', ' : ''}${bot.style}. ${bot.desc.buy}`);
  }
}

/* ---------------- търговия ---------------- */
const round2 = n => Math.round(n * 100) / 100;
function equity(bot, prices) { return bot.cash + bot.positions.reduce((s, p) => s + p.qty * (prices[p.sym] ?? p.entry), 0); }
function feed(st, t, botId, kind, text) { st.feed.unshift({ t, b: botId, k: kind, x: text }); st.feed = st.feed.slice(0, 120); }
const money = n => (n < 0 ? '−$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtyF = n => n.toLocaleString('bg-BG');
const pxF = n => '$' + n.toFixed(n < 1 ? 4 : 2);

function closePos(st, bot, p, price, t, reason) {
  const px = price * (1 - slipAt(t));
  const pnl = (px - p.entry) * p.qty;
  bot.cash += p.qty * px;
  bot.positions = bot.positions.filter(x => x !== p);
  const pct = (px / p.entry - 1) * 100;
  bot.trades.unshift({ sym: p.sym, qty: p.qty, entry: p.entry, exit: Math.round(px * 10000) / 10000, pnl: round2(pnl), pct: round2(pct), in: p.t, out: t, why: reason });
  bot.trades = bot.trades.slice(0, 40);
  bot.realized = round2(bot.realized + pnl);
  const WHY = { tp: 'целта', sl: 'стопа', be: 'стопа на входа', trail: 'плъзгащия стоп', time: 'времето', rsi: 'RSI над 80', vwap: 'пада под VWAP', eod: 'края на деня', fired: 'уволнението' };
  feed(st, t, bot.id, pnl >= 0 ? 'win' : 'loss', `${bot.name} продаде ${qtyF(p.qty)} ${p.sym} по ${pxF(px)} (${pct >= 0 ? '+' : '−'}${fmtP(Math.abs(pct).toFixed(1))}%, ${pnl >= 0 ? '+' : ''}${money(pnl)}) заради ${WHY[reason] || reason}.`);
  // статистика по стратегия (всички реални излизания)
  const k = bot.genome.trigger.t; st.stats = st.stats || {};
  const S = st.stats[k] = st.stats[k] || { style: bot.style, trades: 0, wins: 0, pnl: 0, pctSum: 0, best: 0, worst: 0, hired: 0, fired: 0, minutes: 0 };
  S.trades++; if (pnl >= 0) S.wins++; S.pnl = round2(S.pnl + pnl); S.pctSum = round2(S.pctSum + pct); S.best = Math.max(S.best, round2(pct)); S.worst = Math.min(S.worst, round2(pct)); S.minutes += Math.round((t - p.t) / 60000);
  if (reason === 'fired' || reason === 'eod') return;
  if (pnl < 0) { bot.losses++; bot.strikes++; } else { bot.wins++; bot.strikes = 0; }
}
// дали трябва да бъде уволнен; връща причината или null
function fireReason(bot, prices) {
  if (bot.strikes >= STRIKES_TO_FIRE) return 'streak';
  const eq = equity(bot, prices);
  bot.peakEq = Math.max(bot.peakEq || START_CASH, eq);
  if ((bot.peakEq - eq) / bot.peakEq * 100 >= DD_FIRE) return 'dd';
  if (bot.wins + bot.losses >= LOSER_TRADES && eq < START_CASH) return 'loser';
  return null;
}
const FIRE_TXT = { streak: () => `след ${STRIKES_TO_FIRE} поредни загуби`, dd: () => `след спад ${DD_FIRE}% от най-високия му капитал`, loser: () => `защото е на минус след ${LOSER_TRADES} сделки` };
function fire(st, bot, t, prices, why = 'streak') {
  for (const p of [...bot.positions]) closePos(st, bot, p, prices[p.sym] ?? p.entry, t, 'fired');
  const eq = equity(bot, prices);
  const k = bot.genome.trigger.t; if (st.stats && st.stats[k]) st.stats[k].fired++;
  st.fired.unshift({ id: bot.id, name: bot.name, color: bot.color, style: bot.style, desc: bot.desc, hiredAt: bot.hiredAt, firedAt: t, trades: bot.wins + bot.losses, wins: bot.wins, losses: bot.losses, pnl: round2(eq - START_CASH), gen: bot.gen, why: FIRE_TXT[why]() });
  st.fired = st.fired.slice(0, 60);
  st.firedToday = (st.firedToday || 0) + 1;
  st.bots = st.bots.filter(b => b !== bot);
  const nb = hire(st, t, [k]);
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
async function tick(nowMs = Date.now()) {
  let st = await loadState();
  if (!st) { st = { bots: [], fired: [], feed: [], day: null, universe: [], prices: {}, lastBar: 0, created: nowMs, daily: {} }; for (let i = 0; i < N_BOTS; i++) hire(st, nowMs); feed(st, nowMs, null, 'info', `Състезанието започва! ${N_BOTS} трейдъри, по $10 000 фалшиви пари, истински цени.`); }
  st.lastTick = nowMs; st.simMs = nowMs;
  if (st.bots.length < N_BOTS) { const add = N_BOTS - st.bots.length; const names = []; for (let i = 0; i < add; i++) names.push(hire(st, nowMs).name); feed(st, nowMs, null, 'hired', `Отборът расте! Назначени са ${add} нови трейдъри: ${names.join(', ')}.`); }
  dedupe(st, nowMs);
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
      st.day = et.date; st.universe = []; st.lastBar = 0; st.firedToday = 0; st.dayTrades = 0; st.daily = {}; st.dayDone = null;
      for (const b of st.bots) { b.dayStart = round2(equity(b, st.prices)); b.hist = [[nowMs, b.dayStart]]; }
    }
    st.session = session && etParts(session.start).date === et.date ? session : null;
    st.sessionChecked = nowMs;
  }
  if (!st.session) { st.status = [0, 6].includes(new Date(nowMs).getUTCDay()) ? 'weekend' : 'holiday'; await saveState(st); return st; }
  const { start, end } = st.session; const regStart = st.session.regStart || start; REG_START = regStart;
  if (nowMs < start) { st.status = 'pre'; await saveState(st); return st; }
  if (st.dayDone === st.day) { st.status = 'closed'; await saveState(st); return st; }
  st.status = nowMs < regStart ? 'premarket' : 'open';

  const reopenPick = st.universeAt && st.universeAt < regStart && nowMs >= regStart + 5 * 60000;
  if (!st.universe.length || reopenPick || (st.universeAt && nowMs - st.universeAt > 45 * 60000 && nowMs < end - 60 * 60000 && nowMs > regStart)) {
    const u = await pickUniverse();
    const held = st.bots.flatMap(b => b.positions.map(p => p.sym));
    const before = new Set(st.universe);
    st.universe = [...new Set([...held, ...u])].slice(0, UNIVERSE_N + held.length); st.universeAt = nowMs;
    const added = st.universe.filter(s => !before.has(s));
    if (added.length) feed(st, nowMs, null, 'info', `${before.size ? (reopenPick ? 'След отварянето — нови акции в радара' : 'Нови акции в радара') : (nowMs < regStart ? 'Премаркет! Днешните акции' : 'Днешните акции')}: ${added.slice(0, 12).join(', ')}${added.length > 12 ? '…' : ''}`);
  }
  // дневни данни (20-дневен връх, вчерашен връх/затваряне, среден дневен обем) — веднъж на ден за акция
  st.daily = st.daily || {};
  const need = st.universe.filter(s => !st.daily[s]);
  if (need.length) {
    const r = await Promise.allSettled(need.map(s => yDaily(s)));
    r.forEach((x, k) => { st.daily[need[k]] = x.status === 'fulfilled' ? dailyCtx(x.value, start) : {}; });
  }

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
      for (const p of [...bot.positions]) {
        const I = IND[p.sym]; const i = I && idx[p.sym].get(t);
        if (i == null) { if (t >= eodAt) closePos(st, bot, p, st.prices[p.sym] ?? p.entry, t, 'eod'); continue; }
        const hi = I.h[i], lo = I.l[i], c = I.c[i];
        p.peak = Math.max(p.peak || p.entry, hi);
        if (g.be && p.peak >= p.entry * (1 + g.be / 100)) p.stop = Math.max(p.stop, p.entry);
        const trP = g.trail && p.peak > p.entry * 1.01 ? p.peak * (1 - g.trail / 100) : 0;
        const tpP = p.entry * (1 + g.tp / 100);
        if (t >= eodAt) closePos(st, bot, p, c, t, 'eod');
        else if (lo <= p.stop) closePos(st, bot, p, Math.min(p.stop, I.o[i]), t, p.stop >= p.entry ? 'be' : 'sl');
        else if (trP && lo <= trP) closePos(st, bot, p, trP, t, 'trail');
        else if (hi >= tpP) closePos(st, bot, p, Math.max(tpP, I.o[i]), t, 'tp');
        else if ((t - p.t) / 60000 >= g.hold) closePos(st, bot, p, c, t, 'time');
        else if (g.rsiExit && I.rsi(14)[i] > 80) closePos(st, bot, p, c, t, 'rsi');
        else if (g.vwapExit && c < I.vwap[i] && t - p.t > 3 * 60000) closePos(st, bot, p, c, t, 'vwap');
        if (bot.strikes >= STRIKES_TO_FIRE) { fire(st, bot, t, st.prices, 'streak'); bot = null; break; }
      }
      if (bot) { const why = fireReason(bot, st.prices); if (why) { fire(st, bot, t, st.prices, why); bot = null; } }
      if (!bot) { bi--; continue; } // уволненият е махнат; следващият бот се измества на същото място
      if (t < entryFrom || t > entryTo || bot.positions.length >= g.maxPos) continue;
      let best = null;
      for (const s in IND) {
        if (bot.positions.some(p => p.sym === s)) continue;
        const I = IND[s]; const i = idx[s].get(t); if (i == null) continue;
        const px = I.c[i]; if (px < PRICE_MIN * 0.8 || px > PRICE_MAX * 1.5) continue;
        if (!sig(g, I, i)) continue;
        const score = I.v[i] / (I.avgV[i - 1] || 1);
        if (!best || score > best.score) best = { s, px, score, atr: I.atr[i] };
      }
      if (best) {
        const eq = equity(bot, st.prices);
        const fill = best.px * (1 + slipAt(t));
        const qty = Math.floor(Math.min(bot.cash, eq * g.size) / fill);
        if (qty >= 1 && qty * fill >= 50) {
          const stop = g.atr ? Math.min(fill * 0.99, fill - g.atr * best.atr) : fill * (1 - g.sl / 100);
          bot.cash -= qty * fill;
          bot.positions.push({ sym: best.s, qty, entry: fill, t, peak: fill, stop: Math.max(0.0001, stop) });
          st.dayTrades = (st.dayTrades || 0) + 1;
          feed(st, t, bot.id, 'buy', `${bot.name} купи ${qtyF(qty)} ${best.s} по ${pxF(fill)} (${money(qty * fill)}).`);
        }
      }
    }
    st.lastBar = t;
  }
  st.ticker = st.universe.map(s => { const px = st.prices[s]; const pc = st.daily?.[s]?.pdc || IND[s]?.ctx?.pdc; return px ? { s, px, chg: pc ? round2((px / pc - 1) * 100) : null } : null; }).filter(Boolean);
  for (const b of st.bots) { b.hist.push([nowMs, round2(equity(b, st.prices))]); if (b.hist.length > 420) b.hist = b.hist.filter((_, i) => i % 2 === 0); }
  if (nowMs >= end) {
    for (const b of st.bots) for (const p of [...b.positions]) closePos(st, b, p, st.prices[p.sym] ?? p.entry, end, 'eod');
    st.status = 'closed';
    if (st.dayDone !== st.day) {
      st.dayDone = st.day;
      const top = [...st.bots].sort((a, b) => (equity(b, st.prices) - b.dayStart) - (equity(a, st.prices) - a.dayStart))[0];
      if (top) { const d = equity(top, st.prices) - top.dayStart; feed(st, end, top.id, 'info', `Денят свърши. Трейдър на деня: ${top.name} (${d >= 0 ? '+' : ''}${money(d)}).`); }
    }
  }
  await saveState(st);
  return st;
}

/* ---------------- публичен изглед ---------------- */
function view(st, nowMs = Date.now()) {
  if (!st) return { empty: true };
  const prices = st.prices || {};
  const bots = st.bots.map(b => {
    const eq = equity(b, prices);
    return {
      id: b.id, name: b.name, color: b.color, style: b.style, desc: b.desc, gen: b.gen, hiredAt: b.hiredAt,
      equity: round2(eq), today: round2(eq - b.dayStart), todayPct: round2((eq / b.dayStart - 1) * 100), total: round2(eq - START_CASH),
      strikes: b.strikes, wins: b.wins, losses: b.losses, cash: round2(b.cash), hist: b.hist,
      dd: round2(Math.max(0, ((Math.max(b.peakEq || START_CASH, eq) - eq) / Math.max(b.peakEq || START_CASH, eq)) * 100)),
      risk: Math.min(1, Math.max(b.strikes / STRIKES_TO_FIRE, ((Math.max(b.peakEq || START_CASH, eq) - eq) / Math.max(b.peakEq || START_CASH, eq)) * 100 / DD_FIRE, eq < START_CASH ? (b.wins + b.losses) / LOSER_TRADES : 0)),
      positions: b.positions.map(p => ({ sym: p.sym, qty: p.qty, entry: p.entry, now: prices[p.sym] ?? p.entry, pnl: round2((prices[p.sym] ?? p.entry) * p.qty - p.entry * p.qty), t: p.t })),
      trades: b.trades.slice(0, 25),
    };
  }).sort((a, b) => b.today - a.today || b.total - a.total);
  return { status: st.status, day: st.day, simMs: st.simMs, lastTick: st.lastTick, lastBar: st.lastBar, src: st.src, strikesToFire: STRIKES_TO_FIRE, ddFire: DD_FIRE, loserTrades: LOSER_TRADES, startCash: START_CASH, ticker: st.ticker || [],
    stats: Object.entries(st.stats || {}).map(([k, x]) => ({ k, ...x, winRate: x.trades ? Math.round(x.wins / x.trades * 100) : null, avgPct: x.trades ? round2(x.pctSum / x.trades) : null, avgMin: x.trades ? Math.round(x.minutes / x.trades) : null })).sort((a, b) => b.pnl - a.pnl),
    session: st.session, universe: st.universe, bots, feed: st.feed.slice(0, 60), fired: st.fired.slice(0, 40), firedToday: st.firedToday || 0, dayTrades: st.dayTrades || 0, serverNow: nowMs };
}

async function tickWithLock(nowMs = Date.now(), minGapMs = 50000) {
  const st0 = await loadState();
  if (st0 && st0.lastTick && nowMs - st0.lastTick < minGapMs) return { st: st0, ran: false };
  const got = await kv(['SET', 'arena:lock', String(nowMs), 'NX', 'EX', 55]);
  if (got !== 'OK') return { st: st0, ran: false };
  try { return { st: await tick(nowMs), ran: true }; }
  finally { await kv(['DEL', 'arena:lock']); }
}

module.exports = { tick, tickWithLock, loadState, view, kv, _test: { dedupe, newGenome, describe, indic, sig, etParts, TRIGGERS } };
