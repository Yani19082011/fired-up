// Fired Up — ДЕСКЪТ. Шест агента търгуват заедно с една сметка ($10 000 фалшиви пари, истински цени).
// Търгуват каквото намерят: акции ($1–20), крипто (24/7), индекси (US Tech 100…), злато (24/7), суровини (сребро, петрол… чрез фондовете им) и валути (EUR/USD…, 24/5) — без ливъридж, само с цени на живо.
//   Scout     — следи пазарите за големи движения (всяка минута)
//   News      — открива ЗАЩО се движи (новините в Yahoo Finance; Finnhub по желание)
//   Sentiment — какво говорят хората (StockTwits; ако не отговори — тонът на новините)
//   Chart     — избира вход, стоп и цел от минутната графика
//   Skeptic   — работата му е да спори срещу всяка сделка; казва КУПИ, ЧАКАЙ или ПРОПУСНИ
//   Chief     — събира всичко и решава; купува и продава сам. Ти само гледаш.
// Правилата решават. Ако има безплатен AI ключ (GROQ_API_KEY или GEMINI_API_KEY във Vercel), AI пише аргументите
// на български и може само да направи решението по-предпазливо (никога по-смело).
const zlib = require('zlib');
const E = require('./_engine');
const { kv } = E; const H = E.H;
let PUSH = null; try { PUSH = require('./_push'); } catch (e) { PUSH = null; }
const CB = require('./_cb');

const START = Number(process.env.DESK_CASH || 10000);
const KEY = process.env.DESK_KEY || 'desk:v1';
const MAX_POS = 4;                 // най-много 4 сделки едновременно
const DAY_LOSS = 0.03;             // при −3% за деня декът спира да купува
const RISK_PER_TRADE = 0.01;       // при стоп губим най-много 1% от сметката
const NEW_PER_TICK = 3;            // нови идеи за обсъждане на минута
const WAIT_MIN = 30;               // колко минути чака една идея, преди да се откаже
const MAX_HOLD = 90;               // най-много 90 минути в сделка
const COOLDOWN = 45;               // същото нещо не се предлага пак до 45 минути
const LIQ_SHARE = 0.1;             // при акциите: не купуваме повече от 10% от средния минутен обем
const CRYPTO_FEE = 0.0025;         // крипто борса: 0,25% такса при покупка и при продажба (като Kraken / Coinbase Advanced)
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36', Accept: 'application/json' };
const GROQ = process.env.GROQ_API_KEY || '', GEMINI = process.env.GEMINI_API_KEY || '', FINNHUB = process.env.FINNHUB_KEY || '';
const r2 = n => Math.round(n * 100) / 100, r4 = n => Math.round(n * 10000) / 10000, r6 = n => Math.round(n * 1e6) / 1e6;
const pxF = n => '$' + (n >= 1000 ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : n < 1 ? n.toFixed(4) : n.toFixed(2));
const pxS = (sym, n) => FX[sym] ? n.toFixed(n < 10 ? 5 : 3) : pxF(n); // валутите — без $
const money = n => (n < 0 ? '−$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sgnM = n => (n >= 0 ? '+' : '−') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pctF = n => (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(1).replace('.', ',') + '%';
const qtyF = q => q >= 100 ? Math.round(q).toLocaleString('en-US') : String(r6(q)).replace('.', ',');
const ago = (now, t) => { const m = Math.max(0, Math.round((now - t) / 60000)); return m < 60 ? `преди ${m} мин` : m < 48 * 60 ? `преди ${Math.round(m / 60)} ч` : `преди ${Math.round(m / 1440)} дни`; };

/* ---------------- пазарите ---------------- */
// крипто: 24/7; k = колко „голямо“ е движението спрямо акциите (Bitcoin мърда по-малко от малка акция)
const CRYPTO = {
  'BTC-USD': ['Bitcoin', 0.2, /bitcoin|\bBTC\b/i], 'ETH-USD': ['Ethereum', 0.25, /ethereum|\bETH\b|ether\b/i], 'SOL-USD': ['Solana', 0.35, /solana|\bSOL\b/i],
  'XRP-USD': ['XRP', 0.35, /\bXRP\b|ripple/i], 'DOGE-USD': ['Dogecoin', 0.4, /doge/i], 'ADA-USD': ['Cardano', 0.4, /cardano|\bADA\b/i], 'AVAX-USD': ['Avalanche', 0.4, /avalanche|\bAVAX\b/i],
  'LINK-USD': ['Chainlink', 0.4, /chainlink|\bLINK\b/i], 'LTC-USD': ['Litecoin', 0.35, /litecoin|\bLTC\b/i], 'DOT-USD': ['Polkadot', 0.4, /polkadot|\bDOT\b/i], 'BNB-USD': ['BNB', 0.3, /\bBNB\b|binance/i],
  'BCH-USD': ['Bitcoin Cash', 0.35, /bitcoin cash|\bBCH\b/i], 'XLM-USD': ['Stellar', 0.4, /stellar|\bXLM\b/i], 'TRX-USD': ['TRON', 0.35, /\btron\b|\bTRX\b/i], 'HBAR-USD': ['Hedera', 0.45, /hedera|\bHBAR\b/i],
};
// суровини чрез борсовите им фондове (ETF) — така ги купува обикновен човек; търгуват се в часовете на борсата
const CMDTY = {
  GLD: ['Злато', 0.15, /\bgold\b/i], SLV: ['Сребро', 0.2, /\bsilver\b/i], USO: ['Петрол', 0.2, /\boil\b|crude|brent|WTI|OPEC/i], UNG: ['Природен газ', 0.3, /natural gas|\bLNG\b/i],
  CPER: ['Мед', 0.2, /\bcopper\b/i], PPLT: ['Платина', 0.2, /platinum/i], URA: ['Уран', 0.25, /uranium|nuclear/i], DBA: ['Земеделие', 0.15, /wheat|corn|soybean|coffee|cocoa|sugar|grain|crop/i],
  WEAT: ['Пшеница', 0.2, /\bwheat\b/i], CORN: ['Царевица', 0.2, /\bcorn\b/i],
};
const NEWSQ = { GLD: 'gold price', SLV: 'silver price', USO: 'oil price', UNG: 'natural gas price', CPER: 'copper price', PPLT: 'platinum price', URA: 'uranium', DBA: 'grain prices', WEAT: 'wheat prices', CORN: 'corn prices' };
// резервен списък: активни акции, които обикновено са между $1 и $20 (цената се проверява всяка минута — извън $1–20 не се купуват)
const BACKUP = ['PLUG', 'SNDL', 'BBAI', 'SOUN', 'GSAT', 'OPEN', 'CLOV', 'NIO', 'RIG', 'ACHR', 'TLRY', 'HIVE', 'BITF', 'CIFR', 'QS', 'DNA', 'FCEL', 'IQ', 'GRAB', 'SIRI',
  'F', 'NOK', 'LCID', 'RIVN', 'AAL', 'JBLU', 'WULF', 'MARA', 'RIOT', 'CLSK', 'HUT', 'IREN', 'RGTI', 'QBTS', 'QUBT', 'KULR', 'LUNR', 'SPCE', 'JOBY', 'BLNK', 'CHPT', 'EVGO',
  'SNAP', 'PTON', 'AMC', 'BB', 'VALE', 'ITUB', 'BBD', 'ABEV', 'KGC', 'BTG', 'NGD', 'AG', 'HL', 'CDE', 'EGO', 'IAG', 'UEC', 'UUUU', 'DNN', 'NXE', 'TELL', 'KOS', 'TDOC', 'WBD',
  'LYFT', 'AUR', 'OUST', 'MVIS', 'NVTS', 'WOLF', 'SABR', 'BTBT', 'GPRO', 'ATAI', 'OCGN', 'NVAX', 'SAVA', 'CAN', 'MNMD', 'LAC', 'PLTK', 'AMCR', 'CCL', 'NCLH'];
// индекси и злато като CFD (Trading 212 / eToro), без ливъридж. Само източници НА ЖИВО:
// фючърсите в Yahoo (NQ=F, GC=F…) са със закъснение 10 мин → индексите са по истинския индекс (в часовете на борсата),
// а златото — по PAXG (токен, обезпечен с физическо злато) от Coinbase, 24/7. [име, кратко, k, ключови думи, търсене на новини, вид]
const FUT = {
  '^NDX': ['US Tech 100', 'US100', 0.12, /nasdaq|tech stocks|\bNDX\b/i, 'Nasdaq 100', 'idx'], '^GSPC': ['US 500', 'US500', 0.1, /S&P 500|\bS&P\b|wall street|stock market/i, 'S&P 500', 'idx'],
  '^DJI': ['Wall St 30', 'US30', 0.1, /\bdow\b|dow jones/i, 'Dow Jones', 'idx'], 'PAXG-USD': ['Злато', 'GOLD', 0.12, /\bgold\b/i, 'gold price', 'gold'],
};
// валути (форекс) — 24/5; [име, k, ключови думи, търсене]
const FX = {
  'EURUSD=X': ['EUR/USD', 0.05, /\beuro\b|EUR\/USD|\bECB\b/i, 'EUR/USD'], 'GBPUSD=X': ['GBP/USD', 0.06, /pound|sterling|GBP|Bank of England/i, 'GBP/USD'],
  'USDJPY=X': ['USD/JPY', 0.06, /\byen\b|JPY|Bank of Japan|\bBOJ\b/i, 'USD/JPY'], 'AUDUSD=X': ['AUD/USD', 0.07, /aussie|australian dollar|\bAUD\b|\bRBA\b/i, 'AUD/USD'],
  'USDCAD=X': ['USD/CAD', 0.05, /loonie|canadian dollar|\bCAD\b|Bank of Canada/i, 'USD/CAD'], 'USDCHF=X': ['USD/CHF', 0.05, /swiss franc|\bCHF\b|\bSNB\b/i, 'USD/CHF'],
  'NZDUSD=X': ['NZD/USD', 0.07, /kiwi|new zealand dollar|\bNZD\b|RBNZ/i, 'NZD/USD'], 'EURJPY=X': ['EUR/JPY', 0.07, /\beuro\b|\byen\b|EUR\/JPY/i, 'EUR/JPY'],
  'GBPJPY=X': ['GBP/JPY', 0.08, /pound|\byen\b|GBP\/JPY/i, 'GBP/JPY'],
};
const clsOf = s => CRYPTO[s] ? 'crypto' : FUT[s] ? FUT[s][5] : FX[s] ? 'fx' : CMDTY[s] ? 'cmdty' : 'stock';
const ROUND_CLOCK = new Set(['crypto', 'gold', 'fx']); // не чакат борсовия ден на акциите
const kOf = s => CRYPTO[s] ? CRYPTO[s][1] : FUT[s] ? FUT[s][2] : FX[s] ? FX[s][1] : CMDTY[s] ? CMDTY[s][1] : 1;
const kwOf = s => CRYPTO[s] ? CRYPTO[s][2] : FUT[s] ? FUT[s][3] : FX[s] ? FX[s][2] : CMDTY[s] ? CMDTY[s][2] : null;
const etDow = ms => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(new Date(ms)));
function fxOpen(ms) { const d = etDow(ms), m = H.etParts(ms).min; if (d === 6) return false; if (d === 0) return m >= 17 * 60 + 5; if (d === 5) return m < 16 * 60 + 55; return true; } // форекс: нед. 17:00 – пет. 17:00 НЙ
const CLS_BG = { stock: 'Акция', crypto: 'Крипто', cmdty: 'Суровина', idx: 'Индекс', gold: 'Суровина', fut: 'Суровина', fx: 'Валута' };
const disp = s => CRYPTO[s] ? s.replace('-USD', '') : FUT[s] ? FUT[s][1] : FX[s] ? FX[s][0] : s;
const nameOf = s => CRYPTO[s] ? CRYPTO[s][0] : FUT[s] ? FUT[s][0] : FX[s] ? FX[s][0] : CMDTY[s] ? `${CMDTY[s][0]} (${s})` : s;
const MIN_RISK = { stock: 0.015, crypto: 0.01, cmdty: 0.004, idx: 0.003, gold: 0.004, fut: 0.004, fx: 0.0015 }; // при крипто стопът е поне 1% → целта поне +2%, иначе таксите (0,5% общо) изяждат печалбата

/* ---------------- памет ---------------- */
async function loadState() { const s = await kv(['GET', KEY]); if (!s) return null; return JSON.parse(s.startsWith('z:') ? zlib.gunzipSync(Buffer.from(s.slice(2), 'base64')).toString() : s); }
async function saveState(st) { await kv(['SET', KEY, 'z:' + zlib.gzipSync(JSON.stringify(st), { level: 6 }).toString('base64')]); }

/* ---------------- помощни ---------------- */
function fresh() {
  return { cash: START, positions: [], trades: [], ideas: [], feed: [], eqHist: [], day: null, session: null, radar: [], radarAt: 0,
    news: {}, sent: {}, daily: {}, health: {}, stats: { scout: 0, buy: 0, wait: 0, skip: 0, vetoHard: 0, saved: 0, missed: 0, shadowN: 0, newsFound: 0, newsNone: 0, aiCalls: 0 },
    dayStart: START, created: Date.now(), outbox: [] };
}
function say(st, t, a, x, idea) { st.feed.unshift({ t, a, x, i: idea || undefined }); if (st.feed.length > 300) st.feed.length = 300; }
function note(st, cat, title, body, idea) { (st.outbox = st.outbox || []).push({ cat, title, body, url: idea ? `/?idea=${idea}` : '/' }); }
function ok(st, k, good, err) { st.health[k] = { ok: !!good, at: Date.now(), err: good ? undefined : String(err || '').slice(0, 80) }; }
function equity(st) { return st.cash + st.positions.reduce((a, p) => a + p.qty * (p.last || p.entry), 0); }
function halfSpread(sym, px, pre) {
  const c = clsOf(sym);
  if (c === 'crypto') return ['BTC-USD', 'ETH-USD'].includes(sym) ? 0.0002 : 0.0008;
  if (c === 'cmdty') return Math.max(0.0003, 0.005 / px);
  if (c === 'fx') return 0.00005;  // около половин пипс
  if (c === 'idx') return 0.0001;
  if (c === 'gold') return 0.00015;
  return Math.max(pre ? 0.005 : 0.002, (pre ? 0.01 : 0.005) / px);
}
const buyFee = (sym, gross) => clsOf(sym) === 'crypto' ? gross * CRYPTO_FEE : 0;
const sellFee = (sym, qty, px) => clsOf(sym) === 'crypto' ? qty * px * CRYPTO_FEE : H.sellFees(qty, px);
async function getJSON(url, opt = {}, ms = 9000) {
  const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, { ...opt, signal: ac.signal }); if (!r.ok) throw new Error('http ' + r.status); return await r.json(); }
  finally { clearTimeout(tm); }
}
// кое е отворено сега
function markets(st, nowMs) {
  const s = st.session; const reg = s ? (s.regStart || s.start) : 0;
  const stock = !!s && nowMs >= s.start && nowMs < s.end && st.dayDone !== st.day;
  const cmdty = !!s && nowMs >= reg && nowMs < s.end && st.dayDone !== st.day;
  const fx = fxOpen(nowMs), fxSoon = fx && fxOpen(nowMs + 30 * 60000);
  return { stock, cmdty, crypto: true, fx, reg,
    canEnter: c => c === 'crypto' || c === 'gold' ? true : c === 'fx' ? fxSoon : c === 'cmdty' || c === 'idx' ? cmdty && nowMs >= reg + 10 * 60000 && nowMs < s.end - 30 * 60000 : stock && nowMs >= s.start + 5 * 60000 && nowMs < s.end - 30 * 60000 };
}

/* ---------------- SCOUT: големите движения ---------------- */
async function scout(st, nowMs, mk) {
  if (mk.stock && (!st.radar.length || nowMs - st.radarAt > (st.health.spark && !st.health.spark.ok ? 3 : 10) * 60000)) {
    let r = []; try { r = await H.pickRadar(); } catch (e) { r = []; }
    const dg = H.pickRadar.diag || {};
    if (r.length >= 5) { st.radar = r; ok(st, 'scout', true); }
    else { // скенерът на Yahoo не даде акции → резервен списък от активни акции ($1–20), цените им идват от груповата заявка
      st.radar = BACKUP.map((s2, k) => ({ s: s2, n: 1, px: 0, chg: 0, vol: 0, vr: k + 1 }));
      ok(st, 'scout', true); st.health.scout.err = undefined; st.health.scout.note = `скенерът на Yahoo ${dg.ok ? `върна ${dg.raw} акции, ${r.length} подходящи` : 'не отговори' + (dg.err ? ` (${String(dg.err).slice(0, 40)})` : '')} — ползвам резервен списък от ${BACKUP.length}`;
    }
    st.radarAt = nowMs;
  }
  const M = {};
  if (mk.stock) for (const m of st.radar) M[m.s] = { s: m.s, cls: 'stock', k: 1, px: m.px, chg: m.chg || 0, vol: m.vol || 0, chg5: null, chg15: null, pts: null };
  for (const [s, v] of Object.entries(CRYPTO)) M[s] = { s, cls: 'crypto', k: v[1], px: 0, chg: 0, vol: 0, chg5: null, pts: null };
  M['PAXG-USD'] = { s: 'PAXG-USD', cls: 'gold', k: kOf('PAXG-USD'), px: 0, chg: 0, vol: 0, chg5: null, pts: null };
  if (mk.cmdty) for (const s of [...Object.keys(CMDTY).filter(x => x !== 'GLD'), '^NDX', '^GSPC', '^DJI']) M[s] = { s, cls: clsOf(s), k: kOf(s), px: 0, chg: 0, vol: 0, chg5: null, pts: null }; // златото е от PAXG
  if (mk.fx) for (const s of Object.keys(FX)) M[s] = { s, cls: 'fx', k: kOf(s), px: 0, chg: 0, vol: 0, chg5: null, pts: null };
  let live = {}; try { live = await H.ySpark(Object.keys(M)); } catch (e) { live = {}; }
  let n = 0;
  for (const [s, d] of Object.entries(live)) {
    const m = M[s]; if (!m) continue;
    const from = ROUND_CLOCK.has(m.cls) ? nowMs - 12 * 3600e3 : (st.session ? st.session.start : 0) - 60000;
    const pts = []; for (let k = 0; k < d.t.length; k++) if (d.c[k] != null && d.t[k] >= from && d.t[k] <= nowMs - 60000) pts.push([d.t[k], d.c[k]]);
    if (!pts.length) continue; n++;
    const last = pts[pts.length - 1][1], b5 = pts[Math.max(0, pts.length - 6)][1], b15 = pts[Math.max(0, pts.length - 16)][1];
    const pdc = d.pdc || (m.px && m.chg != null ? m.px / (1 + m.chg / 100) : null);
    m.px = last; m.chg5 = (last / b5 - 1) * 100; m.chg15 = (last / b15 - 1) * 100; if (pdc) { m.chg = (last / pdc - 1) * 100; m.pdc = pdc; } m.pts = pts;
  }
  ok(st, 'spark', n >= 3, n ? '' : 'груповата заявка не отговори — ползвам скенерите');
  st.scan = { radar: mk.stock ? st.radar.length : 0, crypto: Object.keys(CRYPTO).length, other: Object.values(M).filter(m => ['cmdty', 'idx', 'gold'].includes(m.cls)).length, fx: mk.fx ? Object.keys(FX).length : 0, live: n, t: nowMs };
  st.live = M; // за „сенките“ на пропуснатите идеи и за лентата
  const recent = new Set(st.ideas.filter(i => nowMs - i.t < COOLDOWN * 60000 || ['wait', 'open', 'pending'].includes(i.status)).map(i => i.sym));
  const held = new Set(st.positions.map(p => p.sym));
  const cands = Object.values(M).filter(m => m.px > 0 && mk.canEnter(m.cls) && !recent.has(m.s) && !held.has(m.s) && (m.cls !== 'stock' || (m.px >= H.PRICE_MIN && m.px <= H.PRICE_MAX && !H.isHalted(st, m.s, nowMs))) &&
    (m.chg5 != null ? ((m.chg >= 10 * m.k && m.chg5 >= 1.5 * m.k) || m.chg5 >= 3 * m.k || (m.chg >= 20 * m.k && m.chg5 > 0.3 * m.k)) : (m.cls === 'stock' && m.chg >= 20)))
    .map(m => ({ ...m, power: ((m.chg5 || 0) * 2 + m.chg / 10) / m.k + Math.min(3, m.vol / 2e7) })).sort((a, b) => b.power - a.power);
  return cands.slice(0, NEW_PER_TICK);
}

/* ---------------- NEWS: защо се движи ---------------- */
const CATS_STOCK = [
  { k: 'offering', re: /\b(public offering|registered direct|private placement|priced .{0,40}offering|at-the-market|atm (program|offering)|shelf registration|warrant inducement|dilut)/i, tone: -2, hard: true, bg: 'продава нови акции (разводняване)' },
  { k: 'distress', re: /\b(bankrupt|chapter 11|delist|going concern|deficiency notice|non-compliance|nasdaq notice)/i, tone: -2, hard: true, bg: 'финансови проблеми (фалит/отписване)' },
  { k: 'fail', re: /\b(did not meet|failed to meet|fails? (phase|trial)|complete response letter|\bCRL\b|trial (halt|stopp))/i, tone: -2, hard: true, bg: 'провал на изпитване/отказ от FDA' },
  { k: 'rsplit', re: /\breverse (stock )?split/i, tone: -1, bg: 'обратно сливане на акции (reverse split)' },
  { k: 'fda', re: /\b(FDA (approv|clear|grant|accept)|breakthrough therapy|fast track|orphan drug|positive (topline|top-line|interim|phase)|met (its )?primary endpoint|approval)/i, tone: 2, bg: 'одобрение / добри резултати от изпитване' },
  { k: 'mna', re: /\b(to acquire|acquisition|merger|to be acquired|buyout|takeover|definitive agreement)/i, tone: 2, bg: 'сливане или придобиване' },
  { k: 'contract', re: /\b(contract|partnership|collaborat|purchase order|award|selected by|agreement with|strategic (deal|alliance)|supply deal)/i, tone: 2, bg: 'нов договор / партньорство' },
  { k: 'earnings', re: /\b(earnings|quarterly results|Q[1-4] (results|revenue)|revenue (rose|grew|up|increase)|record revenue|guidance)/i, tone: 1, bg: 'финансови резултати' },
  { k: 'analyst', re: /\b(upgrade|price target|initiat\w* coverage|outperform|buy rating)/i, tone: 1, bg: 'анализатор вдигна оценката' },
  { k: 'theme', re: /\b(bitcoin|crypto|blockchain|artificial intelligence|\bAI\b|quantum|nuclear|drone|robot|space)/i, tone: 1, bg: 'модна тема (AI, крипто, квант…)' },
  { k: 'squeeze', re: /\b(short squeeze|meme stock|wallstreetbets|reddit|retail traders)/i, tone: 0, bg: 'мийм / шорт скуийз' },
  { k: 'down', re: /\b(downgrade|misses|lowers guidance|cuts guidance|plunge|lawsuit|investigation|SEC charges)/i, tone: -1, bg: 'лоша новина' },
];
const CATS_MACRO = [
  { k: 'hack', re: /\b(hack|exploit|stolen|breach|drained)/i, tone: -2, hard: true, bg: 'хак / открадната крипто' },
  { k: 'reg', re: /\b(crackdown|ban(s|ned)?\b|SEC sues|lawsuit|regulator)/i, tone: -1, bg: 'регулации / съд' },
  { k: 'etf', re: /\b(ETF (inflow|approv)|spot ETF|inflows|institutional|strategic reserve|treasury (buy|purchase)|adds .{0,20} to balance sheet)/i, tone: 2, bg: 'приток на институционални пари (ETF, компании, държави)' },
  { k: 'supply', re: /\b(OPEC|output cut|production cut|supply (cut|disruption|deficit)|inventor(y|ies) (fell|drop|draw)|stockpile|drought|shortage)/i, tone: 2, bg: 'по-малко предлагане / недостиг' },
  { k: 'macro', re: /\b(Fed|rate cut|interest rate|inflation|CPI|jobs report|payrolls|dollar (falls|weakens|slides))/i, tone: 1, bg: 'макро новини (лихви, инфлация, долар)' },
  { k: 'geo', re: /\b(war|sanction|tariff|attack|conflict|middle east|ukraine|iran|strait)/i, tone: 1, bg: 'геополитика (война, санкции, мита)' },
  { k: 'rally', re: /\b(rall(y|ies)|surge|soar|record high|all-time high|jumps|climbs)/i, tone: 1, bg: 'общ ръст на пазара' },
  { k: 'down', re: /\b(plunge|slump|sell-?off|tumble|crash|falls)/i, tone: -1, bg: 'по-скоро лоши новини' },
];
function classify(items, nowMs, cls) {
  const recent = items.filter(n => nowMs - n.t < 36 * 3600e3);
  for (const c of (cls === 'stock' ? CATS_STOCK : CATS_MACRO)) { const n = recent.find(x => c.re.test(x.title)); if (n) return { ...c, re: undefined, item: n }; }
  return recent.length ? { k: 'other', tone: 0, bg: 'има новини, но без ясна причина', item: recent[0] } : { k: 'none', tone: cls === 'stock' ? -1 : 0, bg: 'няма новина', item: null };
}
async function news(st, sym, nowMs) {
  const c = st.news[sym]; if (c && nowMs - c.at < 10 * 60000) return c;
  const cls = clsOf(sym); const kw = kwOf(sym);
  let items = [];
  try {
    const q = cls === 'stock' ? sym : cls === 'crypto' ? CRYPTO[sym][0] : FUT[sym] ? FUT[sym][4] : FX[sym] ? FX[sym][3] : sym;
    const d = await E.yget(`/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=0&newsCount=15&enableFuzzyQuery=false`);
    items = (d.news || []).filter(n => cls === 'stock' ? ((n.relatedTickers || []).includes(sym) || new RegExp(`\\b${sym}\\b`).test(n.title || '')) : (kw.test(n.title || '') || (n.relatedTickers || []).includes(sym)))
      .map(n => ({ title: n.title, pub: n.publisher, t: (n.providerPublishTime || 0) * 1000, link: n.link }));
    if (cls === 'cmdty' && items.length < 2) { // и общите новини за суровината (напр. „gold price“)
      const d2 = await E.yget(`/v1/finance/search?q=${encodeURIComponent(NEWSQ[sym] || CMDTY[sym][0])}&quotesCount=0&newsCount=10`);
      for (const n of d2.news || []) if (kw.test(n.title || '') && !items.some(x => x.title === n.title)) items.push({ title: n.title, pub: n.publisher, t: (n.providerPublishTime || 0) * 1000, link: n.link });
    }
    ok(st, 'news', true);
  } catch (e) { ok(st, 'news', false, e.message); }
  if (FINNHUB && cls === 'stock') {
    try {
      const day = s => new Date(s).toISOString().slice(0, 10);
      const d = await getJSON(`https://finnhub.io/api/v1/company-news?symbol=${sym}&from=${day(nowMs - 3 * 86400e3)}&to=${day(nowMs)}&token=${FINNHUB}`);
      for (const n of (Array.isArray(d) ? d : []).slice(0, 15)) if (!items.some(x => x.title === n.headline)) items.push({ title: n.headline, pub: n.source, t: n.datetime * 1000, link: n.url });
    } catch (e) { /* по желание */ }
  }
  items.sort((a, b) => b.t - a.t);
  const out = { at: nowMs, items: items.slice(0, 5), cat: classify(items, nowMs, cls) };
  st.news[sym] = out; return out;
}

/* ---------------- SENTIMENT: какво говорят хората ---------------- */
async function sentiment(st, sym, nowMs, nw) {
  const c = st.sent[sym]; if (c && nowMs - c.at < 10 * 60000) return c;
  let out = null;
  if (['idx', 'gold', 'fx'].includes(clsOf(sym))) { // StockTwits няма индекси и валути → тонът на новините
    const tone = nw && nw.cat ? nw.cat.tone : 0; out = { at: nowMs, src: 'новините', n: nw ? nw.items.length : 0, bullPct: tone > 0 ? 70 : tone < 0 ? 30 : 50, hour: 0, hot: false, guess: true, noTw: true };
    st.sent[sym] = out; return out;
  }
  try {
    const tw = CRYPTO[sym] ? sym.replace('-USD', '.X') : sym;
    const d = await getJSON(`https://api.stocktwits.com/api/2/streams/symbol/${encodeURIComponent(tw)}.json`, { headers: UA }, 7000);
    const msgs = d.messages || []; let bull = 0, bear = 0, hour = 0;
    for (const m of msgs) { const s = m.entities && m.entities.sentiment && m.entities.sentiment.basic; if (s === 'Bullish') bull++; else if (s === 'Bearish') bear++; if (nowMs - Date.parse(m.created_at) < 3600e3) hour++; }
    const tagged = bull + bear;
    out = { at: nowMs, src: 'StockTwits', n: msgs.length, bull, bear, hour, bullPct: tagged ? Math.round(bull / tagged * 100) : null, hot: hour >= (CRYPTO[sym] ? 25 : 15) };
    ok(st, 'sentiment', true);
  } catch (e) {
    ok(st, 'sentiment', false, e.message);
    const tone = nw && nw.cat ? nw.cat.tone : 0;
    out = { at: nowMs, src: 'новините', n: nw ? nw.items.length : 0, bullPct: tone > 0 ? 70 : tone < 0 ? 30 : 50, hour: 0, hot: false, guess: true };
  }
  st.sent[sym] = out; return out;
}
function sentTxt(s) {
  if (s.noTw) return `За индекси, злато и валути StockTwits няма данни — по тона на новините настроението е ${s.bullPct >= 60 ? 'положително' : s.bullPct <= 40 ? 'отрицателно' : 'неутрално'}.`;
  if (s.guess) return `StockTwits не отговори — по тона на новините настроението е ${s.bullPct >= 60 ? 'положително' : s.bullPct <= 40 ? 'отрицателно' : 'неутрално'}.`;
  if (!s.n) return 'Никой не говори за това в StockTwits — тихо е.';
  const mood = s.bullPct == null ? 'без ясна посока' : s.bullPct >= 75 ? `много оптимистично (${s.bullPct}% „купувай“)` : s.bullPct >= 55 ? `оптимистично (${s.bullPct}% „купувай“)` : s.bullPct >= 45 ? `разделено (${s.bullPct}% „купувай“)` : `песимистично (само ${s.bullPct}% „купувай“)`;
  return `В StockTwits: ${s.n} поста, ${s.hour} от последния час${s.hot ? ' — горещо' : ''}. Настроение: ${mood}.`;
}

/* ---------------- CHART: вход, стоп, цел ---------------- */
async function bars(st, sym, sess, nowMs) {
  const cls = clsOf(sym); let arr, ctx = {};
  if (ROUND_CLOCK.has(cls)) { // крипто, фючърси и валути: последните 8 часа (крипто направо от Coinbase, ако може)
    const L = st.live && st.live[sym];
    if (cls === 'crypto' || cls === 'gold') try { arr = await CB.cbBars(sym, nowMs - 8 * 3600e3, nowMs); ctx.pdc = L && L.pdc; ok(st, 'coinbase', true); return { arr, ctx, cls, src: 'Coinbase' }; }
    catch (e) { if (!CB.NOT.has(sym)) ok(st, 'coinbase', false, e.message); }
    const d = await E.yget(`/v8/finance/chart/${encodeURIComponent(sym)}?interval=1m&period1=${Math.floor((nowMs - 8 * 3600e3) / 1000)}&period2=${Math.ceil(nowMs / 1000) + 60}`);
    const res = d && d.chart && d.chart.result && d.chart.result[0]; if (!res) throw new Error('yahoo empty ' + sym);
    arr = E.ybars(res); ctx.pdc = (L && L.pdc) || (res.meta && (res.meta.previousClose ?? res.meta.chartPreviousClose));
  } else {
    const r = await E.yIntraday(sym);
    if (!st.daily[sym]) { try { st.daily[sym] = H.dailyCtx(await H.yDaily(sym), sess.start); } catch (e) { st.daily[sym] = {}; } }
    arr = r.bars.filter(b => b.t >= sess.start && b.t < sess.end);
    ctx = { ...(st.daily[sym] || {}) }; if (!ctx.pdc && r.prevClose) ctx.pdc = r.prevClose;
  }
  return { arr, ctx, cls, src: 'Yahoo' };
}
function chartPlan(sym, arr, ctx, nowMs, regStart) {
  const cls = clsOf(sym);
  const done = arr.filter(b => b.t <= nowMs - 60000); if (done.length < 6) return null;
  const I = H.indic(done, ctx); const i = done.length - 1;
  const hasVol = I.cumV[i] > 0; // при крипто Yahoo често няма обем по минути → вместо VWAP ползваме 20-минутна средна
  const VW = hasVol ? I.vwap : I.ema(20);
  const px = I.c[i], vwap = VW[i], atr = Math.max(I.atr[i], px * 0.0008), e9 = I.ema(9)[i], rsi = I.rsi(14)[i];
  const hodPrev = i ? I.hod[i - 1] : I.h[i]; const ext = (px - vwap) / atr;
  const lo5 = Math.min(...I.l.slice(Math.max(0, i - 4), i + 1)), lo3 = Math.min(...I.l.slice(Math.max(0, i - 2), i + 1));
  const volOk = !hasVol || I.v[i] > (I.avgV[i - 1] || 0) * 1.2;
  let setup = null, ready = false, entry = px, stop;
  if (I.c[i] > hodPrev && px > vwap && volOk) { setup = 'Пробив на най-високото'; ready = true; stop = Math.max(lo5, vwap) - 0.2 * atr; }
  else if (px > vwap && I.l[i] <= e9 * 1.004 && I.c[i] > I.o[i] && I.c[i] > e9) { setup = 'Отскок от краткосрочната средна'; ready = true; stop = lo3 - 0.5 * atr; }
  else if (px > vwap && Math.abs(I.l[i] - vwap) / px < 0.006 && I.c[i] > I.o[i]) { setup = 'Отскок от средната цена'; ready = true; stop = Math.min(lo3, vwap) - 0.5 * atr; }
  else if (px > vwap && ext > 3) { setup = 'Твърде разтеглена'; ready = false; entry = e9; stop = Math.max(vwap, e9 - 1.5 * atr); }
  else if (px > vwap) { setup = 'Над средната, чакам ясен вход'; ready = false; entry = Math.max(hodPrev * 1.0005, px); stop = Math.max(lo5, vwap) - 0.2 * atr; }
  else { setup = 'Под средната цена — слаба'; ready = false; entry = vwap; stop = lo5 - 0.5 * atr; }
  const minR = MIN_RISK[cls];
  stop = Math.min(stop, entry * (1 - minR)); if (stop < entry * 0.92) stop = entry * 0.92; // рискът е между минимума за пазара и 8%
  const risk = entry - stop, target = entry + 2 * risk;
  const room = I.hod[i] > entry ? (I.hod[i] - entry) / risk : null;
  return { cls, setup, ready, px: r6(px), entry: r6(entry), stop: r6(stop), target: r6(target), rr: 2, riskPct: r2(risk / entry * 100), vwap: r6(vwap), vwapName: hasVol ? 'VWAP' : '20-мин. средна', ext: r2(ext), rsi: Math.round(rsi), hod: r6(I.hod[i]), room: room != null ? r2(room) : null,
    liq: cls === 'stock' ? LIQ_SHARE * Math.max(I.avgV[i] || 0, 1) : Infinity, dollarVol: hasVol ? (I.avgV[i] || 0) * px : null, chgDay: ctx.pdc ? r2((px / ctx.pdc - 1) * 100) : null, t: done[i].t, pre: cls === 'stock' && done[i].t < regStart };
}
function chartTxt(c) {
  const P = n => c && c.cls === 'fx' ? n.toFixed(n < 10 ? 5 : 3) : pxF(n);
  if (!c) return 'Още няма достатъчно минути на графиката.';
  if (c.ready) return `${c.setup}. Вход около ${P(c.entry)}, стоп ${P(c.stop)} (−${String(c.riskPct).replace('.', ',')}%), цел ${P(c.target)} — печалбата е 2 пъти риска.`;
  if (c.setup === 'Твърде разтеглена') return `Цената е избягала далеч над средната си (${String(c.ext).replace('.', ',')}× обичайното движение). Чакам да се върне към ${P(c.entry)}.`;
  if (c.setup.startsWith('Под')) return `Цената е под средната си (${c.vwapName} ${P(c.vwap)}) — продавачите са по-силни. Не е за купуване сега.`;
  return `Над средната цена е, но няма ясен момент за вход. Ще купя при ново най-високо над ${P(c.entry)}.`;
}

/* ---------------- SKEPTIC: спори срещу всяка сделка ---------------- */
function skeptic(st, idea, nowMs, et, regStart) {
  const o = []; const add = (txt, w, hard) => o.push({ txt, w, hard: !!hard });
  const c = idea.chart, nw = idea.news, s = idea.sent, cls = idea.cls;
  if (nw && nw.cat.hard) add(`Новината е лоша: ${nw.cat.bg}. След такава новина цената често се срива.`, 5, true);
  if (cls === 'stock' && (H.isHalted(st, idea.sym, nowMs) || (st.halts && st.halts[idea.sym] && nowMs - st.halts[idea.sym].at < 15 * 60000))) add('Борсата току-що я спря заради резки движения — твърде нестабилна е.', 5, true);
  if (st.dayLocked) add(`Декът вече е на −${DAY_LOSS * 100}% за деня. Стига за днес.`, 5, true);
  const crazy = { stock: 150, crypto: 40, cmdty: 10, idx: 5, gold: 6, fut: 8, fx: 2 }[cls];
  if (c && c.chgDay != null && c.chgDay >= crazy) add(`Вече е поскъпнала с ${Math.round(c.chgDay)}% днес. Повечето такива движения свършват с рязко падане — ще сме последните купувачи.`, 5, true);
  if (nw && nw.cat.k === 'none') add(cls === 'stock' ? 'Няма никаква новина. Движение без причина често е помпане — някой купува, за да продаде на нас.' : 'Не намирам новина, която да обяснява движението.', cls === 'stock' ? 2 : 1);
  if (nw && nw.cat.k === 'rsplit') add('Обратно сливане на акции — обикновено е знак за слаба компания.', 2);
  if (nw && nw.cat.k === 'down') add('Новините около нея са по-скоро лоши.', 2);
  if (nw && nw.cat.k === 'reg') add('Има регулаторен натиск — може да обърне цената.', 1);
  if (c && c.ext > 3) add(`Гоним влака: цената е ${String(c.ext).replace('.', ',')} пъти обичайното движение над средната. Ако купим сега, купуваме скъпо.`, 2);
  if (c && c.rsi >= 82) add(`Прегряла е (RSI ${c.rsi}). След такова изкачване идва почивка или спад.`, 1);
  if (c && !c.setup.startsWith('Под') && c.room != null && c.room < 1) add('Целта ни е над днешния връх — там продавачите ще ни чакат.', 1);
  if (c && c.setup.startsWith('Под')) add('Цената е под средната си. Купувачите вече се отказват.', 2);
  if (cls === 'stock' && c && c.dollarVol != null && c.dollarVol < 25000) add(`Търгува се малко (около ${money(c.dollarVol)} на минута). Може да не успеем да излезем на добра цена.`, 2);
  if (cls === 'stock' && c && c.px < 2) add('Под $2 спредът е голям — губим още на влизане и излизане.', 1);
  if (cls === 'crypto' && !['BTC-USD', 'ETH-USD'].includes(idea.sym)) add('Алткойн: таксата на крипто борсата (0,25% на вход и изход) и по-резките движения ядат от печалбата.', 1);
  if (s && !s.guess && s.bullPct != null && s.bullPct >= 90 && s.hot) add(`Всички вече са вътре (${s.bullPct}% „купувай“). Кой ще купува след нас?`, 1);
  if (s && !s.guess && s.bullPct != null && s.bullPct < 40 && s.n >= 10) add(`Хората са песимисти (само ${s.bullPct}% „купувай“).`, 1);
  if (['stock', 'cmdty', 'idx'].includes(cls) && et.min >= 15 * 60) add('Късно е — до затварянето на борсата остава малко време за движение.', 1);
  if (cls === 'fx' && !fxOpen(nowMs + 90 * 60000)) add('Валутният пазар скоро затваря за уикенда — сделката може да не успее да се развие.', 1);
  if (['stock', 'cmdty', 'idx'].includes(cls) && nowMs >= regStart && nowMs < regStart + 10 * 60000) add('Първите 10 минути след отварянето са хаос — цените скачат напосоки.', 1);
  if (c && c.pre) add('Премаркет: малко търговия и широк спред.', 1);
  if (cls === 'crypto' && [0, 6].includes(new Date(nowMs).getUTCDay())) add('Уикенд е — по-малко търговия, движенията лесно се обръщат.', 1);
  const today = st.trades.filter(t => nowMs - t.out < 12 * 3600e3);
  if (today.length >= 2 && today.slice(0, 2).every(t => t.pnl < 0)) add('Имаме 2 поредни загуби. Да не гоним — по-добре по-малко сделки.', 1);
  const score = o.reduce((a, x) => a + x.w, 0), hard = o.some(x => x.hard);
  const verdict = hard || score >= 5 ? 'SKIP' : (!c || !c.ready || score >= 3) ? 'WAIT' : 'BUY';
  const txt = !o.length ? 'Търсих причина да не купуваме и не намерих сериозна. Може.' :
    (verdict === 'SKIP' ? 'ПРОПУСКАМЕ. ' : verdict === 'WAIT' ? 'ЧАКАМЕ. ' : 'Добре, но да знаем: ') + o.slice().sort((a, b) => b.w - a.w).slice(0, 3).map(x => x.txt).join(' ');
  return { objections: o, score, hard, verdict, txt };
}

/* ---------------- AI (по желание, безплатен ключ) ---------------- */
async function ai(st, idea, rule) {
  if (!GROQ && !GEMINI) return null;
  st.aiDay = st.aiDay || { d: st.day, n: 0 }; if (st.aiDay.d !== st.day) st.aiDay = { d: st.day, n: 0 };
  if (st.aiDay.n >= 300) return null; st.aiDay.n++; st.stats.aiCalls++;
  const facts = {
    asset: `${nameOf(idea.sym)} (${CLS_BG[idea.cls]})`, price: idea.chart && idea.chart.px, change_today_pct: idea.scout.chg, change_5min_pct: idea.scout.chg5,
    news: (idea.news.items || []).slice(0, 4).map(n => `${n.title} (${n.pub})`), news_category: idea.news.cat.bg,
    sentiment: sentTxt(idea.sent), chart: chartTxt(idea.chart), skeptic_objections: rule.objections.map(x => x.txt), rule_verdict: rule.verdict,
  };
  const prompt = `Ти си екип от трейдъри на деск за дневна търговия (акции, крипто, суровини; фалшиви пари, истински цени). Факти в JSON:\n${JSON.stringify(facts)}\n` +
    `Върни САМО JSON с ключове: "why" (1–2 изречения на прост български: защо цената се движи според новините; ако няма новина, кажи го), ` +
    `"skeptic" (2–3 изречения на български: най-силните аргументи СРЕЩУ сделката, остро и конкретно), "chief" (1–2 изречения на български: окончателното решение и защо), ` +
    `"verdict" ("BUY", "WAIT" или "SKIP"). Бъди предпазлив: при съмнение WAIT или SKIP. Не измисляй факти.`;
  try {
    let text = '';
    if (GROQ) {
      const d = await getJSON('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${GROQ}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], temperature: 0.4, max_tokens: 600, response_format: { type: 'json_object' } }) }, 15000);
      text = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content || '';
    } else {
      const d = await getJSON(`https://generativelanguage.googleapis.com/v1beta/models/${process.env.GEMINI_MODEL || 'gemini-2.5-flash'}:generateContent?key=${GEMINI}`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.4, responseMimeType: 'application/json' } }) }, 15000);
      text = (d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts || []).map(p => p.text || '').join('');
    }
    const j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    ok(st, 'ai', true);
    const v = ['BUY', 'WAIT', 'SKIP'].includes(String(j.verdict).toUpperCase()) ? String(j.verdict).toUpperCase() : null;
    const cut = x => typeof x === 'string' ? x.slice(0, 420) : null;
    return { why: cut(j.why), skeptic: cut(j.skeptic), chief: cut(j.chief), verdict: v, by: GROQ ? 'Groq' : 'Gemini' };
  } catch (e) { ok(st, 'ai', false, e.message); return null; }
}
const RANK = { BUY: 0, WAIT: 1, SKIP: 2 };

/* ---------------- CHIEF: решава ---------------- */
function chief(st, idea, sk) {
  const sc = idea.scout, nw = idea.news, s = idea.sent, c = idea.chart, k = kOf(idea.sym);
  let conv = Math.min(3, ((sc.chg5 || 0) / 2 + sc.chg / 25) / k) + nw.cat.tone + (s.bullPct == null ? 0 : s.bullPct >= 60 ? 1 : s.bullPct < 40 ? -1 : 0) + (c && c.room != null && c.room >= 2 ? 1 : 0) - sk.score * 0.5;
  conv = r2(Math.max(0, Math.min(5, conv)));
  let v = sk.verdict, why;
  if (v === 'SKIP') why = 'Скептикът наложи вето — не купуваме.';
  else if (v === 'WAIT') why = c && c.ready ? 'Има възражения, които могат да се оправят — гледаме още.' : 'Няма ясен вход още — гледаме графиката.';
  else if (conv < 1.5) { v = 'SKIP'; why = `Идеята е слаба (увереност ${String(conv).replace('.', ',')} от 5) — не си струва риска.`; }
  else if (st.positions.length >= MAX_POS) { v = 'WAIT'; why = `Вече имаме ${MAX_POS} сделки — чакаме да се освободи място.`; }
  else why = `Всички сигнали са „за“. Купуваме с увереност ${String(conv).replace('.', ',')} от 5.`;
  const sizePct = conv >= 4 ? 0.25 : conv >= 2.5 ? 0.15 : 0.1;
  return { verdict: v, conv, sizePct, why };
}

/* ---------------- обсъждане на идея ---------------- */
async function debate(st, idea, nowMs, et, regStart, data) {
  const first = !idea.chief;
  if (first || nowMs - (idea.newsAt || 0) > 10 * 60000) {
    idea.news = await news(st, idea.sym, nowMs); idea.newsAt = nowMs;
    idea.sent = await sentiment(st, idea.sym, nowMs, idea.news);
    if (first) { if (idea.news.cat.k === 'none') st.stats.newsNone++; else st.stats.newsFound++; }
  }
  idea.chart = data ? chartPlan(idea.sym, data.arr, data.ctx, nowMs, regStart) : null;
  if (idea.chart && idea.chart.chgDay != null) idea.scout.chg = idea.chart.chgDay;
  const sk = skeptic(st, idea, nowMs, et, regStart);
  let ch = chief(st, idea, sk);
  const prev = idea.chief && idea.chief.verdict;
  if (first || prev !== ch.verdict) { const A = await ai(st, idea, sk); if (A) { idea.ai = A; if (A.verdict && RANK[A.verdict] > RANK[ch.verdict]) ch = { ...ch, verdict: A.verdict, why: `AI помощникът е по-предпазлив: ${A.verdict === 'SKIP' ? 'пропускаме' : 'чакаме'}.` }; } }
  idea.skeptic = { verdict: sk.verdict, score: sk.score, hard: sk.hard, objections: sk.objections.map(x => x.txt), txt: sk.txt };
  idea.chief = ch;
  return { prev, changed: prev !== ch.verdict };
}
function newsTxt(idea, nowMs) {
  const nw = idea.news; if (!nw) return '';
  if (nw.cat.k === 'none') return `Не намирам новина за ${nameOf(idea.sym)} от последните 36 часа. Движи се без видима причина.`;
  const n = nw.cat.item; return `Причина: ${nw.cat.bg}. „${n.title}“ (${n.pub || 'новини'}, ${ago(nowMs, n.t)}).`;
}

/* ---------------- една стъпка ---------------- */
async function tick(nowMs = Date.now()) {
  let st = await loadState(); if (!st) { st = fresh(); say(st, nowMs, 'chief', `Декът отваря! Сметка ${money(START)}. Търгуваме каквото намерим — акции, крипто и суровини. Scout търси, News проверява, Sentiment слуша, Chart смята, Skeptic спори, аз решавам.`); }
  st.lastTick = nowMs; st.outbox = st.outbox || [];
  const et = H.etParts(nowMs);
  if (st.day !== et.date || !st.sessionChecked || (!st.session && nowMs - st.sessionChecked > 30 * 60000)) {
    let session = null; try { session = (await E.yIntraday('SPY')).session; } catch (e) { console.error('session', e.message); }
    const wk = new Date(nowMs).getUTCDay();
    if (!session && wk !== 0 && wk !== 6) for (const off of [4, 5]) { const s = Date.parse(`${et.date}T09:30:00Z`) + off * 3600e3; if (H.etParts(s).min === 570) { session = { start: s - 330 * 60000, regStart: s, end: s + 390 * 60000, guess: true }; break; } }
    if (st.day !== et.date) {
      if (st.day) { const eq = equity(st); say(st, nowMs, 'chief', `Нов ден. Сметка ${money(eq)} (${pctF((eq / START - 1) * 100)} от старта).`); }
      st.day = et.date; st.radar = []; st.radarAt = 0; st.news = {}; st.sent = {}; st.daily = {}; st.dayDone = null; st.dayLocked = false; st.dayStart = r2(equity(st));
      for (const i of st.ideas) if (['wait', 'pending'].includes(i.status)) i.status = 'expired';
      st.ideas = st.ideas.slice(0, 150);
    }
    st.session = session && H.etParts(session.start).date === et.date ? session : null; st.sessionChecked = nowMs;
  }
  const S = st.session; const mk = markets(st, nowMs); const regStart = mk.reg;
  st.status = mk.stock ? (nowMs < regStart ? 'premarket' : 'open') : 'crypto';
  if (mk.stock) await H.loadHalts(st, nowMs);

  // 1) SCOUT
  const cands = await scout(st, nowMs, mk);
  // 2) графики за всичко, което ни трябва: позиции, поръчки, чакащи и новите идеи
  const waiting = st.ideas.filter(i => i.status === 'wait');
  const need = [...new Set([...st.positions.map(p => p.sym), ...st.ideas.filter(i => i.status === 'pending').map(i => i.sym), ...waiting.map(i => i.sym), ...cands.map(c => c.s)])]
    .filter(s => ROUND_CLOCK.has(clsOf(s)) || S); // акциите и фондовете — само когато има борсов ден
  const got = await Promise.allSettled(need.map(s => bars(st, s, S, nowMs)));
  const D = {}; got.forEach((r, k) => { if (r.status === 'fulfilled') D[need[k]] = r.value; });
  ok(st, 'chart', !need.length || Object.keys(D).length >= need.length / 2, 'Yahoo не даде графики');
  { // колко пресни са цените: последната свещ (ако е текущата минута — цената е от момента на заявката)
    let fresh = 0; for (const d of Object.values(D)) { const lb = d.arr[d.arr.length - 1]; if (lb) fresh = Math.max(fresh, lb.t > nowMs - 60000 ? nowMs : lb.t + 60000); }
    if (fresh) st.dataT = Math.min(fresh, nowMs);
    st.src = { crypto: Object.values(D).some(d => d.src === 'Coinbase') ? 'Coinbase' : 'Yahoo', stock: 'Yahoo' };
  }

  // 3) поръчките от миналата минута се изпълняват (на отварянето на следващата минута)
  for (const idea of st.ideas.filter(i => i.status === 'pending')) {
    const d = D[idea.sym]; const o = idea.order;
    const nb = d && d.arr.find(b => b.t > o.t && b.t <= nowMs - 60000);
    if (!nb) { if (nowMs - o.t > 4 * 60000) { idea.status = 'expired'; say(st, nowMs, 'chief', `Поръчката за ${disp(idea.sym)} не се изпълни за 3 минути — отказваме се.`, idea.id); } continue; }
    const pre = clsOf(idea.sym) === 'stock' && nb.t < regStart, fill = nb.o * (1 + halfSpread(idea.sym, nb.o, pre));
    if (fill > o.limit) { idea.status = 'expired'; say(st, nb.t, 'chief', `${disp(idea.sym)} отвори на ${pxS(idea.sym, nb.o)}, над лимита ни ${pxS(idea.sym, o.limit)}. Не гоним — отказваме се.`, idea.id); note(st, 'skip', `⛔ ${disp(idea.sym)}: не купихме`, `Цената избяга над лимита ${pxS(idea.sym, o.limit)}.`, idea.id); continue; }
    const eq = equity(st), cls = clsOf(idea.sym), feeK = cls === 'crypto' ? 1 + CRYPTO_FEE : 1;
    let qty = Math.min(eq * o.sizePct, st.cash) / (fill * feeK);
    qty = Math.min(qty, RISK_PER_TRADE * eq / Math.max(fill - o.stop, fill * 0.004), o.liq || Infinity);
    qty = cls === 'crypto' ? Math.floor(qty * 1e6) / 1e6 : ['idx', 'gold', 'fx'].includes(cls) ? Math.floor(qty * 1e4) / 1e4 : Math.floor(qty);
    if (!(qty > 0) || qty * fill < 10) { idea.status = 'expired'; say(st, nb.t, 'chief', `${disp(idea.sym)}: твърде малко се търгува, за да влезем с реална сума.`, idea.id); continue; }
    const fee = buyFee(idea.sym, qty * fill); st.cash -= qty * fill + fee;
    const risk = Math.max(fill - o.stop, fill * MIN_RISK[cls]);
    const p = { id: 'p' + nb.t.toString(36) + disp(idea.sym), idea: idea.id, sym: idea.sym, cls, qty, entry: r6(fill), t: nb.t, stop: r6(fill - risk), stop0: r6(fill - risk), target: r6(fill + 2 * risk), risk: r6(risk), feeIn: r2(fee), last: fill, peak: fill, lastT: nb.t };
    st.positions.push(p); idea.status = 'open'; idea.pos = p.id;
    say(st, nb.t, 'chief', `Купихме ${qtyF(qty)} ${disp(idea.sym)} по ${pxS(idea.sym, fill)} (${money(qty * fill)}${fee ? `, такса ${money(fee)}` : ''}). Стоп ${pxS(p.sym, p.stop)}, цел ${pxS(p.sym, p.target)}.`, idea.id);
    note(st, 'buy', `🟢 КУПИХМЕ ${disp(idea.sym)}`, `${qtyF(qty)} по ${pxS(idea.sym, fill)} · ${money(qty * fill)} · стоп ${pxS(p.sym, p.stop)} · цел ${pxS(p.sym, p.target)}`, idea.id);
  }

  // 4) управление на позициите (всяка минута, по минутните свещи)
  for (const p of [...st.positions]) {
    const d = D[p.sym]; if (!d) continue;
    const halted = p.cls === 'stock' && H.isHalted(st, p.sym, nowMs);
    for (const b of d.arr.filter(x => x.t > p.lastT && x.t <= nowMs - 60000)) {
      p.lastT = b.t; p.last = b.c;
      if (p.cls === 'stock' && H.isHalted(st, p.sym, b.t)) continue; // спряна — не може да се продаде
      const pre = p.cls === 'stock' && b.t < regStart, sp = halfSpread(p.sym, b.o, pre);
      if (p.exitNext) { closePos(st, p, b.o * (1 - sp), b.t, p.exitNext); break; }
      if (['stock', 'cmdty', 'idx'].includes(p.cls) && S && b.t >= S.end - 5 * 60000) { closePos(st, p, b.c * (1 - sp), b.t, 'eod'); break; }
      if (p.cls === 'fx' && !fxOpen(b.t + 6 * 60000)) { closePos(st, p, b.c * (1 - sp), b.t, 'eod'); break; } // преди уикенда
      if (!pre && b.l <= p.stop) { closePos(st, p, Math.min(p.stop, b.o) * (1 - sp), b.t, p.stop >= p.entry ? 'be' : 'stop'); break; }
      if (b.h >= p.target) { closePos(st, p, Math.max(p.target, b.o), b.t, 'target'); break; }
      if (pre && b.c <= p.stop) { p.exitNext = 'stop'; continue; }
      p.peak = Math.max(p.peak, b.h);
      if (p.peak >= p.entry + p.risk && p.stop < p.entry) { p.stop = r6(p.entry); say(st, b.t, 'chief', `${disp(p.sym)} е на +1R — местя стопа на входа. Вече не можем да загубим (освен таксите).`, p.idea); }
      if ((b.t - p.t) / 60000 >= MAX_HOLD) { p.exitNext = 'time'; continue; }
      const sub = d.arr.filter(x => x.t <= b.t); const I = H.indic(sub, d.ctx); const k = I.c.length - 1; const vw = I.cumV[k] > 0 ? I.vwap[k] : I.ema(20)[k];
      if (b.t - p.t > 10 * 60000 && I.c[k] < vw && I.c[k] < p.entry + 0.5 * p.risk) { p.exitNext = 'vwap'; say(st, b.t, 'chart', `${disp(p.sym)} падна под средната си цена — силата изчезна. Излизаме на следващата минута.`, p.idea); }
    }
    if (st.positions.includes(p)) {
      const lb = d.arr[d.arr.length - 1]; if (lb && lb.t > p.lastT) p.last = lb.c; // цената сега (и от текущата минута) — за сметката и екрана
      const nw = st.news[p.sym]; if (nw && nw.cat.hard && !p.exitNext && nw.at > p.t) { p.exitNext = 'news'; say(st, nowMs, 'news', `Нова лоша новина за ${nameOf(p.sym)}: ${nw.cat.bg}. Излизаме!`, p.idea); }
      if (halted && !p.haltSaid) { p.haltSaid = 1; say(st, nowMs, 'chief', `⏸ ${p.sym} е спряна от борсата — не можем да продадем, докато не я пуснат.`, p.idea); note(st, 'sell', `⏸ ${p.sym} е спряна`, 'Не можем да продадем, докато борсата не я пусне.', p.idea); }
    }
  }
  // дневен лимит
  const eqNow = equity(st);
  if (!st.dayLocked && eqNow <= st.dayStart * (1 - DAY_LOSS)) { st.dayLocked = true; say(st, nowMs, 'chief', `Днес сме на ${pctF((eqNow / st.dayStart - 1) * 100)}. Спираме да купуваме до утре — правилото е −${DAY_LOSS * 100}% на ден.`); note(st, 'summary', '🛑 Декът спира за днес', `Загуба ${pctF((eqNow / st.dayStart - 1) * 100)} — без нови сделки до утре.`); }

  // 5) нови идеи от Scout
  for (const c of cands) {
    const cls = c.cls;
    const idea = { id: 'i' + nowMs.toString(36) + disp(c.s), sym: c.s, cls, t: nowMs, status: 'new', scout: { px: r6(c.px), chg: r2(c.chg), chg5: c.chg5 != null ? r2(c.chg5) : null, chg15: c.chg15 != null ? r2(c.chg15) : null, vol: c.vol }, log: [] };
    idea.scout.txt = `${nameOf(c.s)} (${CLS_BG[cls].toLowerCase()}) се движи: ${pctF(c.chg)} ${['stock', 'cmdty', 'idx'].includes(cls) ? 'днес' : 'от вчерашното затваряне'}` + (c.chg5 != null ? `, ${pctF(c.chg5)} за последните 5 минути` : '') + (cls === 'stock' && c.vol ? `, обем ${(c.vol / 1e6).toFixed(1).replace('.', ',')} млн. акции` : '') + '.';
    st.ideas.unshift(idea); st.stats.scout++;
    say(st, nowMs, 'scout', idea.scout.txt + ' Подавам на деска.', idea.id);
    await debate(st, idea, nowMs, et, regStart, D[c.s]);
    say(st, nowMs, 'news', idea.ai && idea.ai.why ? idea.ai.why : newsTxt(idea, nowMs), idea.id);
    say(st, nowMs, 'sentiment', sentTxt(idea.sent), idea.id);
    say(st, nowMs, 'chart', chartTxt(idea.chart), idea.id);
    say(st, nowMs, 'skeptic', idea.ai && idea.ai.skeptic ? idea.ai.skeptic : idea.skeptic.txt, idea.id);
    act(st, idea, nowMs, true);
  }
  // 6) чакащите идеи — преглеждат се всяка минута
  for (const idea of waiting) {
    const cls = idea.cls || clsOf(idea.sym);
    if (nowMs - idea.t > WAIT_MIN * 60000 || !mk.canEnter(cls)) { idea.status = 'expired'; idea.chief.why = `Чакахме и не дойде добър момент.`; say(st, nowMs, 'chief', `${disp(idea.sym)}: чакахме достатъчно, моментът не дойде. Отказваме се.`, idea.id); note(st, 'skip', `⛔ ${disp(idea.sym)}: отказахме се`, `Чакахме — не дойде добър вход.`, idea.id); shadowStart(idea, nowMs); continue; }
    if (!D[idea.sym]) continue;
    const r = await debate(st, idea, nowMs, et, regStart, D[idea.sym]);
    if (r.changed) { say(st, nowMs, 'chart', chartTxt(idea.chart), idea.id); say(st, nowMs, 'skeptic', idea.ai && idea.ai.skeptic ? idea.ai.skeptic : idea.skeptic.txt, idea.id); act(st, idea, nowMs, false); }
  }
  // 7) „сенките“: какво щеше да стане с пропуснатите идеи (за да видим дали Скептикът е прав)
  shadows(st, nowMs);
  if (S && nowMs >= S.end + 60000 && st.dayDone !== st.day && !st.positions.some(p => ['stock', 'cmdty', 'idx'].includes(p.cls))) { st.dayDone = st.day; summary(st, nowMs); }
  return finish(st, nowMs);
}
function act(st, idea, nowMs, first) {
  const ch = idea.chief, v = ch.verdict, D = disp(idea.sym);
  (idea.log = idea.log || []).push({ t: nowMs, v, why: ch.why }); if (idea.log.length > 20) idea.log = idea.log.slice(-20);
  const txt = idea.ai && idea.ai.chief ? idea.ai.chief : ch.why;
  if (v === 'BUY' && idea.chart && idea.chart.ready) {
    idea.status = 'pending'; st.stats.buy++;
    idea.order = { t: idea.chart.t, limit: r6(idea.chart.px * (idea.chart.pre ? 1.02 : { stock: 1.01, crypto: 1.003, cmdty: 1.002, idx: 1.0015, gold: 1.002, fx: 1.0005 }[idea.cls] || 1.003)), stop: idea.chart.stop, sizePct: ch.sizePct, liq: idea.chart.liq === Infinity ? null : idea.chart.liq };
    say(st, nowMs, 'chief', `КУПУВАМЕ ${D}. ${txt} Лимит до ${pxS(idea.sym, idea.order.limit)}, ${Math.round(ch.sizePct * 100)}% от сметката.`, idea.id);
  } else if (v === 'WAIT') {
    idea.status = 'wait'; if (first) st.stats.wait++;
    say(st, nowMs, 'chief', `ЧАКАМЕ с ${D}. ${txt}`, idea.id);
    note(st, 'wait', `⏳ ЧАКАМЕ ${D}`, `${idea.skeptic.objections[0] || ch.why}`.slice(0, 160), idea.id);
  } else {
    idea.status = 'skip'; st.stats.skip++; if (idea.skeptic.hard) st.stats.vetoHard++;
    say(st, nowMs, 'chief', `ПРОПУСКАМЕ ${D}. ${txt}`, idea.id);
    note(st, 'skip', `⛔ ПРОПУСКАМЕ ${D}`, `${idea.skeptic.objections[0] || ch.why}`.slice(0, 160), idea.id);
    shadowStart(idea, nowMs);
  }
}
const WHY = { target: 'целта е достигната', stop: 'стопът се задейства', be: 'цената се върна до входа (стопът беше на входа)', time: `${MAX_HOLD} минути без резултат`, vwap: 'падна под средната цена', news: 'излезе лоша новина', eod: 'пазарът затваря (краят на деня или пауза)' };
function closePos(st, p, px, t, why) {
  const fee = sellFee(p.sym, p.qty, px); const gross = p.qty * px; st.cash += gross - fee;
  const pnl = gross - fee - p.qty * p.entry - (p.feeIn || 0), pct = (px / p.entry - 1) * 100;
  st.positions = st.positions.filter(x => x !== p);
  const tr = { id: p.id, idea: p.idea, sym: p.sym, d: disp(p.sym), cls: p.cls, qty: p.qty, entry: p.entry, exit: r6(px), in: p.t, out: t, pnl: r2(pnl), pct: r2(pct), r: r2((px - p.entry) / p.risk), why, stop0: p.stop0, target: p.target, fees: r2(fee + (p.feeIn || 0)) };
  st.trades.unshift(tr); if (st.trades.length > 400) st.trades.length = 400;
  const idea = st.ideas.find(i => i.id === p.idea); if (idea) { idea.status = 'closed'; idea.result = { pnl: tr.pnl, pct: tr.pct, why }; }
  say(st, t, 'chief', `Продадохме ${disp(p.sym)} по ${pxS(p.sym, px)} — ${WHY[why]}. Резултат: ${pctF(pct)} (${sgnM(pnl)} след таксите).`, p.idea);
  note(st, 'sell', `${pnl >= 0 ? '🟢' : '🔴'} ПРОДАДОХМЕ ${disp(p.sym)} ${pctF(pct)}`, `${sgnM(pnl)} · ${WHY[why]} · сметка ${money(equity(st))}`, p.idea);
}
function shadowStart(idea, nowMs) {
  const c = idea.chart; if (!c) return;
  idea.shadow = { t: nowMs, entry: c.px, stop: c.stop < c.px ? c.stop : c.px * 0.97, target: c.target > c.px ? c.target : c.px * 1.06, out: null };
}
function shadows(st, nowMs) {
  for (const idea of st.ideas) {
    const sh = idea.shadow; if (!sh || sh.out) continue;
    const m = st.live && st.live[idea.sym]; const pts = m && m.pts ? m.pts.filter(p => p[0] > sh.t) : [];
    let out = null; for (const [, c] of pts) { if (c <= sh.stop) { out = 'stop'; break; } if (c >= sh.target) { out = 'target'; break; } }
    if (!out && nowMs - sh.t > 60 * 60000) out = 'none';
    if (out) {
      sh.out = out; sh.pct = r2(((out === 'stop' ? sh.stop : out === 'target' ? sh.target : (pts.length ? pts[pts.length - 1][1] : sh.entry)) / sh.entry - 1) * 100);
      st.stats.shadowN++; if (out === 'stop') st.stats.saved++; if (out === 'target') st.stats.missed++;
      if (out !== 'none') say(st, nowMs, 'skeptic', out === 'stop' ? `Казах ли ви? ${disp(idea.sym)}, която пропуснахме, падна до стопа (${pctF(sh.pct)}). Спестихме загуба.` : `Признавам: ${disp(idea.sym)}, която пропуснахме, стигна целта (${pctF(sh.pct)}). Тук сбърках.`, idea.id);
    }
  }
}
function summary(st, nowMs) {
  const from = nowMs - 20 * 3600e3; const T = st.trades.filter(t => t.out >= from); const I = st.ideas.filter(i => i.t >= from);
  const eq = equity(st), d = eq - st.dayStart; const w = T.filter(t => t.pnl > 0).length;
  const txt = `Днес: ${sgnM(d)} (${pctF(d / st.dayStart * 100)}). ${I.length} идеи → ${T.length} сделки, ${w} на печалба. Пропуснахме ${I.filter(i => i.status === 'skip' || i.status === 'expired').length}. Сметка ${money(eq)}. Крипто продължава през нощта.`;
  say(st, nowMs, 'chief', 'Борсата затвори. ' + txt); note(st, 'summary', `📊 Борсата затвори: ${sgnM(d)} днес`, txt);
}
async function finish(st, nowMs) {
  const eq = r2(equity(st)); const L = st.eqHist[st.eqHist.length - 1];
  if (!L || nowMs - L[0] >= 50000) st.eqHist.push([nowMs, eq]); else L[1] = eq;
  if (st.eqHist.length > 3000) { const cut = nowMs - 2 * 86400e3; const out = []; let lb = null; for (const p of st.eqHist) { if (p[0] >= cut) { out.push(p); continue; } const k = Math.floor(p[0] / 900000); if (k !== lb) { out.push(p); lb = k; } } st.eqHist = out.slice(-3000); }
  const outbox = st.outbox || []; st.outbox = [];
  const live = st.live; if (live) st.lastTicker = tickerOf(live);
  delete st.live; // „живите“ данни не се пазят — тежат
  // паметта (Upstash, безплатно до 10 GB/месец): пълен дебат за последните 60 идеи и активните; по-старите сделки — накратко; останалото се изтрива
  const active = i => ['wait', 'pending', 'open'].includes(i.status) || (i.shadow && !i.shadow.out);
  let old = 0;
  st.ideas = st.ideas.filter((i, k) => {
    if (i.news && i.news.items) i.news.items = i.news.items.slice(0, k < 60 ? 4 : 0);
    if (k < 60 || active(i)) return true;
    if (i.status === 'closed' && old < 150) { old++; i.log = []; if (i.ai) i.ai = { why: i.ai.why, skeptic: i.ai.skeptic, chief: i.ai.chief, by: i.ai.by }; return true; }
    return false;
  });
  await saveState(st);
  st.live = live;
  if (outbox.length && PUSH) await PUSH.flush(outbox).catch(e => console.error('push', e.message));
  return st;
}
const tickerOf = live => Object.values(live).filter(m => m.px).sort((a, b) => Math.abs(b.chg5 || 0) / b.k - Math.abs(a.chg5 || 0) / a.k).slice(0, 18).map(m => ({ s: disp(m.s), px: r6(m.px), chg: r2(m.chg || 0), c: m.cls }));
async function tickWithLock(nowMs = Date.now(), minGap = 50000) {
  const last = Number(await kv(['GET', KEY + ':t'])) || 0;
  if (last && nowMs - last < minGap) return { st: null, ran: false };
  if (await kv(['SET', 'desk:lock', String(nowMs), 'NX', 'EX', 55]) !== 'OK') return { st: null, ran: false };
  try { const st = await tick(nowMs); await kv(['SET', KEY + ':t', String(nowMs)]); return { st, ran: true }; }
  finally { await kv(['DEL', 'desk:lock']); }
}

/* ---------------- изглед за приложението ---------------- */
const AGENTS = {
  scout: { name: 'Scout', bg: 'Разузнавач', role: 'Следи пазарите за големи движения' },
  news: { name: 'News', bg: 'Новинар', role: 'Открива защо се движи' },
  sentiment: { name: 'Sentiment', bg: 'Настроения', role: 'Какво говорят хората' },
  chart: { name: 'Chart', bg: 'Графики', role: 'Вход, стоп и цел' },
  skeptic: { name: 'Skeptic', bg: 'Скептик', role: 'Спори срещу всяка сделка' },
  chief: { name: 'Chief', bg: 'Шеф', role: 'Решава и изпълнява' },
};
function brief(i) {
  return { id: i.id, sym: i.sym, d: disp(i.sym), cls: i.cls || clsOf(i.sym), name: nameOf(i.sym), t: i.t, status: i.status, v: i.chief && i.chief.verdict, conv: i.chief && i.chief.conv, chg: i.scout.chg, chg5: i.scout.chg5,
    cat: i.news && i.news.cat ? i.news.cat.bg : null, tone: i.news && i.news.cat ? i.news.cat.tone : 0, obj: i.skeptic && i.skeptic.objections[0] || null, hard: i.skeptic && i.skeptic.hard, result: i.result || null,
    shadow: i.shadow && i.shadow.out ? { out: i.shadow.out, pct: i.shadow.pct } : null, ai: !!i.ai };
}
function ideaFull(st, id) {
  const i = st.ideas.find(x => x.id === id); if (!i) return null;
  return { ...i, d: disp(i.sym), cls: i.cls || clsOf(i.sym), name: nameOf(i.sym), newsTxt: newsTxt(i, Date.now()), sentTxt: i.sent ? sentTxt(i.sent) : '', chartTxt: chartTxt(i.chart), feed: st.feed.filter(f => f.i === id).slice(0, 60),
    trade: st.trades.find(t => t.idea === id) || null, pos: st.positions.find(p => p.idea === id) || null };
}
function view(st, nowMs = Date.now()) {
  const eq = equity(st), from = nowMs - 20 * 3600e3;
  const today = st.trades.filter(t => t.out >= from), ideasToday = st.ideas.filter(i => i.t >= from);
  const closed = st.trades.length, won = st.trades.filter(t => t.pnl > 0).length;
  const positions = st.positions.map(p => ({ ...p, d: disp(p.sym), name: nameOf(p.sym), pnl: r2(p.qty * (p.last - p.entry) - (p.feeIn || 0)), pct: r2((p.last / p.entry - 1) * 100), halted: (p.cls === 'stock' && H.isHalted(st, p.sym, nowMs)) || undefined }));
  const byCls = {}; for (const t of st.trades) { const c = t.cls || clsOf(t.sym); const b = byCls[c] = byCls[c] || { n: 0, won: 0, pnl: 0 }; b.n++; if (t.pnl > 0) b.won++; b.pnl = r2(b.pnl + t.pnl); }
  return {
    v: 'desk', startCash: START, cash: r2(st.cash), equity: r2(eq), total: r2(eq - START), totalPct: r2((eq / START - 1) * 100), today: r2(eq - (st.dayStart || START)), todayPct: r2((eq / (st.dayStart || START) - 1) * 100),
    status: st.status, dataT: st.dataT || null, src: st.src || null, session: st.session, day: st.day, lastTick: st.lastTick, dayLocked: !!st.dayLocked, scan: st.scan || null, ticker: st.live ? tickerOf(st.live) : (st.lastTicker || []),
    positions, trades: st.trades.slice(0, 150).map(t => ({ ...t, d: t.d || disp(t.sym), cls: t.cls || clsOf(t.sym) })), ideas: st.ideas.slice(0, 80).map(brief), feed: st.feed.slice(0, 150), eqHist: st.eqHist,
    stats: { ...st.stats, closed, won, winRate: closed ? Math.round(won / closed * 100) : null, todayTrades: today.length, todayWon: today.filter(t => t.pnl > 0).length, ideasToday: ideasToday.length, byCls,
      bestPct: closed ? Math.max(...st.trades.map(t => t.pct)) : null, worstPct: closed ? Math.min(...st.trades.map(t => t.pct)) : null, avgPct: closed ? r2(st.trades.reduce((a, t) => a + t.pct, 0) / closed) : null },
    health: st.health || {}, ai: GROQ ? 'Groq' : GEMINI ? 'Gemini' : null, finnhub: !!FINNHUB, agents: AGENTS,
    markets: { crypto: Object.keys(CRYPTO).map(disp), idx: ['^NDX', '^GSPC', '^DJI'].map(nameOf), cmdty: ['Злато (24/7)', ...Object.keys(CMDTY).filter(x => x !== 'GLD').map(nameOf)], fx: Object.keys(FX).map(nameOf), fxOpen: fxOpen(nowMs) },
    rules: { maxPos: MAX_POS, dayLoss: DAY_LOSS * 100, risk: RISK_PER_TRADE * 100, waitMin: WAIT_MIN, maxHold: MAX_HOLD, cryptoFee: CRYPTO_FEE * 100 },
  };
}
module.exports = { tick, tickWithLock, loadState, view, ideaFull, _t: { chartPlan, skeptic, classify, chief, fresh, clsOf } };
