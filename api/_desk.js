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
const RISK_PER_TRADE = 0.01;       // при стоп губим най-много 1% от сметката (по подразбиране; всеки екип има свое)
const FIRE_EUR = Number(process.env.FIRE_EUR || 500); // ако екипът загуби толкова евро от началото си → уволнен, идва нов екип с други правила
// СТРАТЕГИИ: всеки екип има своя — как Scout търси, как Chart влиза, кога Скептикът спира
const STRATS = {
  momentum: { name: 'Инерция', txt: 'гони силните движения: купува, когато нещо тръгне рязко нагоре (или залага на спад, когато пада рязко) и се присъединява към посоката' },
  reversal: { name: 'Обрат', txt: 'търси прекалени движения и залага на връщане: купува след рязък спад, когато цената започне да се обръща (или залага на спад след прекалено бърз скок)' },
  trend: { name: 'Тренд', txt: 'следва спокойните, устойчиви движения: влиза, когато цената се върне до средната си линия в посоката на тренда' },
  breakout: { name: 'Пробив', txt: 'чака цената да стои в тесен диапазон и влиза, когато излезе от него със сила' },
  news: { name: 'Новини', txt: 'търгува само неща с ясна новина в посоката на движението — без новина няма сделка' },
  scalp: { name: 'Бързи сделки', txt: 'бързи сделки за малки печалби: малка цел, кратко държане, бързо пази печалбата' },
};
const FOCUS = { all: 'всички пазари', macro: 'само крипто, валути, индекси, злато и суровини (без отделни акции)', stocks: 'акции, индекси и суровини (в часовете на борсата)', crypto: 'само крипто и злато (24/7)', fx: 'валути, индекси и злато' };
const SHORTABLE = new Set(['fx', 'idx', 'gold', 'cmdty', 'crypto']); // long и short (като CFD): всичко освен отделните акции — там само покупка при скок нагоре
// правилата на екипа; екип №1 е с правилата по подразбиране, следващите — с различни
const GEN0 = { strat: 'momentum', focus: 'all', shorts: true, scoutK: 1, skipAt: 5, waitAt: 3, rr: 2, minConv: 1.5, maxHold: 90, risk: 0.01, vwapExit: true, beAt: 1 };
const pick = a => a[Math.floor(Math.random() * a.length)];
function newGenParams(prev) {
  const strat = pick(Object.keys(STRATS).filter(k => !prev || k !== prev.strat)); // винаги друга стратегия
  const g = { strat, focus: pick(['all', 'all', 'macro', 'stocks', 'crypto', 'fx']), shorts: true, scoutK: pick([0.7, 0.85, 1, 1.2, 1.5]), skipAt: pick([4, 5, 6]), waitAt: pick([2, 3, 4]),
    rr: pick([1.5, 2, 2.5, 3]), minConv: pick([1, 1.5, 2, 2.5]), maxHold: pick([45, 60, 90, 120, 180]), risk: pick([0.005, 0.0075, 0.01]), vwapExit: Math.random() < 0.6, beAt: pick([0.75, 1, 1.5]) };
  if (strat === 'scalp') Object.assign(g, { rr: pick([1, 1.2, 1.5]), maxHold: pick([15, 20, 30]), beAt: 0.6 });
  if (strat === 'trend') Object.assign(g, { rr: pick([2.5, 3]), maxHold: pick([120, 180, 240]), vwapExit: false });
  if (strat === 'reversal') g.vwapExit = false;
  if (g.waitAt > g.skipAt) g.waitAt = g.skipAt;
  return g;
}
function genTxt(g0) {
  const g = { ...GEN0, ...g0 };
  return [`Стратегия „${STRATS[g.strat].name}“: ${STRATS[g.strat].txt}`, `Пазари: ${FOCUS[g.focus]}; при всичко освен акциите влиза и в покупка, и в залагане на спад (long и short), при акциите — само покупка`,
    `Scout: ${g.scoutK < 1 ? 'по-смел (подава и по-малки движения)' : g.scoutK > 1 ? 'по-придирчив (само големи движения)' : 'нормален'}`,
    `Skeptic: вето при ${g.skipAt} точки възражения, „чакай“ при ${g.waitAt}`, `Chart: цел ${String(g.rr).replace('.', ',')}× риска`,
    `Chief: влиза при увереност от ${String(g.minConv).replace('.', ',')}/5, риск ${String(g.risk * 100).replace('.', ',')}% на сделка, държи до ${g.maxHold} мин, стоп на входа при +${String(g.beAt).replace('.', ',')}R${g.vwapExit ? ', излиза, ако цената мине от другата страна на средната' : ''}`];
}
const GP = st => ({ ...GEN0, ...((st.gen && st.gen.p) || {}), ...(process.env.DESK_STRAT ? { strat: process.env.DESK_STRAT } : {}) }); // DESK_STRAT — само за тестове
const NEW_PER_TICK = 3;            // нови идеи за обсъждане на минута
const WAIT_MIN = 30;               // колко минути чака една идея, преди да се откаже
const MAX_HOLD = 90;               // по подразбиране: най-много 90 минути в сделка
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
// стойност на позиция: покупка = брой × цена; залагане на спад (CFD) = заложените пари + печалбата от спада
const posVal = (p, px) => (p.dir || 1) > 0 ? p.qty * px : p.qty * (2 * p.entry - px);
function equity(st) { return st.cash + st.positions.reduce((a, p) => a + posVal(p, p.last || p.entry), 0); }
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
const sellFee = (sym, qty, px) => clsOf(sym) === 'crypto' ? qty * px * CRYPTO_FEE : ['stock', 'cmdty'].includes(clsOf(sym)) ? H.sellFees(qty, px) : 0; // такси SEC/FINRA само за акции и фондове
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
function sameDay(st, i, nowMs) { // идеята е от „днес“: същия борсов ден за акциите, последните 12 часа за денонощните пазари
  const c = i.cls || clsOf(i.sym);
  return ROUND_CLOCK.has(c) ? nowMs - i.t < 12 * 3600e3 : H.etParts(i.t).date === H.etParts(nowMs).date;
}
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
  // една идея на ден за всяко нещо: продадено, пропуснато или отказано днес не се търгува пак (крипто/валути/злато — 12 часа)
  const recent = new Set(st.ideas.filter(i => ['wait', 'open', 'pending'].includes(i.status) || nowMs - i.t < COOLDOWN * 60000 || sameDay(st, i, nowMs)).map(i => i.sym));
  const g = GP(st), sk = g.scoutK;
  const held = new Set(st.positions.map(p => p.sym));
  const inFocus = c => g.focus === 'all' || (g.focus === 'macro' && c !== 'stock') || (g.focus === 'stocks' && ['stock', 'cmdty', 'idx'].includes(c)) || (g.focus === 'crypto' && ['crypto', 'gold'].includes(c)) || (g.focus === 'fx' && ['fx', 'idx', 'gold'].includes(c));
  const out = [];
  for (const m of Object.values(M)) {
    if (!(m.px > 0) || m.chg5 == null && m.cls !== 'stock' || !mk.canEnter(m.cls) || !inFocus(m.cls) || recent.has(m.s) || held.has(m.s)) continue;
    if (m.cls === 'stock' && (m.px < H.PRICE_MIN || m.px > H.PRICE_MAX || H.isHalted(st, m.s, nowMs))) continue;
    const K = m.k * sk;
    // тесен диапазон преди последните 5 минути (за „Пробив“)
    let rng = null; if (m.pts && m.pts.length > 25) { const w = m.pts.slice(-36, -5).map(p => p[1]); const hi = Math.max(...w), lo = Math.min(...w); rng = { hi, lo, pct: (hi / lo - 1) * 100 }; }
    for (const dir of (g.shorts && SHORTABLE.has(m.cls) ? [1, -1] : [1])) {
      const chg = dir * m.chg, c5 = m.chg5 == null ? null : dir * m.chg5, c15 = m.chg15 == null ? null : dir * m.chg15;
      let hit = false, why = '';
      if (c5 == null) { hit = dir > 0 && m.cls === 'stock' && chg >= 20 * sk && ['momentum', 'news'].includes(g.strat); why = 'голям скок днес'; }
      else if (g.strat === 'reversal') { hit = c15 <= -4 * K && c5 > 0.15 * K; why = dir > 0 ? 'рязък спад, който започва да се обръща' : 'рязък скок, който започва да се обръща'; }
      else if (g.strat === 'trend') { hit = chg >= 5 * K && c15 >= 0.8 * K && c5 >= 0 && c5 < 2 * K; why = dir > 0 ? 'спокоен, устойчив ръст' : 'спокоен, устойчив спад'; }
      else if (g.strat === 'breakout') { hit = !!rng && rng.pct <= 2.5 * K && c5 >= 1.2 * K && (dir > 0 ? m.px > rng.hi : m.px < rng.lo); why = dir > 0 ? 'излезе нагоре от тесен диапазон' : 'излезе надолу от тесен диапазон'; }
      else { const kk = g.strat === 'news' ? K * 0.8 : g.strat === 'scalp' ? K * 0.7 : K; hit = (chg >= 10 * kk && c5 >= 1.5 * kk) || c5 >= 3 * kk || (chg >= 20 * kk && c5 > 0.3 * kk); why = dir > 0 ? 'силно движение нагоре' : 'силно движение надолу'; }
      if (hit) out.push({ ...m, pts: undefined, dir, why, power: (Math.abs(m.chg5 || 0) * 2 + Math.abs(m.chg) / 10) / m.k + Math.min(3, m.vol / 2e7) });
    }
  }
  const cands = out.sort((a, b) => b.power - a.power).filter((c, k, a) => a.findIndex(x => x.s === c.s) === k);
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
// dir = 1 покупка, −1 залагане на спад. При спад графиката се „обръща“ (цена → 1/цена): падането става качване
// и същите правила работят огледално; накрая входът, стопът и целта се връщат обратно.
const flipBars = arr => arr.map(b => ({ t: b.t, o: 1 / b.o, h: 1 / b.l, l: 1 / b.h, c: 1 / b.c, v: b.v }));
function chartPlan(sym, arr0, ctx0, nowMs, regStart, g = GEN0, dir = 1) {
  const cls = clsOf(sym), rr = g.rr || 2, strat = g.strat || 'momentum';
  const arr = dir > 0 ? arr0 : flipBars(arr0);
  const ctx = dir > 0 ? ctx0 : { pdc: ctx0.pdc ? 1 / ctx0.pdc : undefined };
  const done = arr.filter(b => b.t <= nowMs - 60000); if (done.length < 6) return null;
  const I = H.indic(done, ctx); const i = done.length - 1;
  const hasVol = I.cumV[i] > 0; // при крипто и валутите често няма обем по минути → вместо VWAP 20-минутна средна
  const VW = hasVol ? I.vwap : I.ema(20);
  const px = I.c[i], vwap = VW[i], atr = Math.max(I.atr[i], px * 0.0003), e9 = I.ema(9)[i], e20 = I.ema(20)[i], rsi = I.rsi(14)[i];
  const hodPrev = i ? I.hod[i - 1] : I.h[i]; const ext = (px - vwap) / atr;
  const lo5 = Math.min(...I.l.slice(Math.max(0, i - 4), i + 1)), lo3 = Math.min(...I.l.slice(Math.max(0, i - 2), i + 1));
  const volOk = !hasVol || I.v[i] > (I.avgV[i - 1] || 0) * 1.2;
  let setup = null, ready = false, entry = px, stop, target = null, weak = false;
  if (strat === 'reversal') {
    const minExt = Math.min(...done.slice(Math.max(0, i - 10), i + 1).map((b, k) => (I.l[Math.max(0, i - 10) + k] - VW[Math.max(0, i - 10) + k]) / atr));
    if (minExt <= -2.5 && I.c[i] > I.h[i - 1] && I.c[i] > I.o[i]) { setup = 'Обрат след прекалено движение'; ready = true; stop = lo5 - 0.3 * atr; target = Math.max(vwap, px + (px - stop)); }
    else if (minExt <= -2.5) { setup = 'Чакам обрат'; entry = I.h[i] * 1.0002; stop = lo5 - 0.3 * atr; target = Math.max(vwap, entry + (entry - stop)); }
    else { setup = 'Движението не е прекалено'; weak = true; entry = px; stop = lo5 - 0.5 * atr; }
  } else if (strat === 'trend') {
    const up = e9 > e20 && e20 > I.ema(20)[Math.max(0, i - 5)] && px > vwap;
    if (up && I.l[i] <= e20 * 1.003 && I.c[i] > I.o[i] && I.c[i] > e20) { setup = 'Връщане до средната в тренд'; ready = true; stop = Math.min(lo3, e20) - 0.5 * atr; }
    else if (up) { setup = 'Тренд — чакам връщане до средната'; entry = e20; stop = e20 - 1.5 * atr; }
    else { setup = 'Няма ясен тренд'; weak = true; entry = px; stop = lo5 - 0.5 * atr; }
  } else if (strat === 'breakout') {
    const w = done.slice(Math.max(0, i - 30), i); const rh = Math.max(...w.map(b => b.h)), rl = Math.min(...w.map(b => b.l));
    if (w.length >= 15 && I.c[i] > rh && volOk) { setup = 'Пробив на диапазона'; ready = true; stop = Math.min((rh + rl) / 2, px - atr); }
    else if (w.length >= 15) { setup = 'Чакам пробив на диапазона'; entry = rh * 1.0003; stop = Math.min((rh + rl) / 2, entry - atr); }
    else { setup = 'Още няма диапазон'; weak = true; stop = lo5 - 0.5 * atr; }
  } else { // инерция, новини, бързи сделки
    if (I.c[i] > hodPrev && px > vwap && volOk) { setup = 'Пробив на най-високото'; ready = true; stop = Math.max(lo5, vwap) - 0.2 * atr; }
    else if (px > vwap && I.l[i] <= e9 * 1.004 && I.c[i] > I.o[i] && I.c[i] > e9) { setup = 'Отскок от краткосрочната средна'; ready = true; stop = lo3 - 0.5 * atr; }
    else if (px > vwap && Math.abs(I.l[i] - vwap) / px < 0.006 && I.c[i] > I.o[i]) { setup = 'Отскок от средната цена'; ready = true; stop = Math.min(lo3, vwap) - 0.5 * atr; }
    else if (px > vwap && ext > 3) { setup = 'Твърде разтеглена'; entry = e9; stop = Math.max(vwap, e9 - 1.5 * atr); }
    else if (px > vwap) { setup = 'Над средната, чакам ясен вход'; entry = Math.max(hodPrev * 1.0005, px); stop = Math.max(lo5, vwap) - 0.2 * atr; }
    else { setup = 'От грешната страна на средната'; weak = true; entry = vwap; stop = lo5 - 0.5 * atr; }
  }
  const minR = MIN_RISK[cls];
  stop = Math.min(stop, entry * (1 - minR)); if (stop < entry * 0.92) stop = entry * 0.92; // рискът е между минимума за пазара и 8%
  const risk = entry - stop; if (!target || target <= entry) target = entry + rr * risk;
  const room = I.hod[i] > entry ? (I.hod[i] - entry) / risk : null;
  const back = x => dir > 0 ? r6(x) : r6(1 / x); // обратно към истинските цени
  return { cls, dir, strat, setup, ready, weak, px: back(px), entry: back(entry), stop: back(stop), target: back(target), rr: r2((target - entry) / risk), riskPct: r2(risk / entry * 100), vwap: back(vwap), vwapName: hasVol ? 'VWAP' : '20-мин. средна',
    ext: r2(ext), rsi: Math.round(rsi), hod: back(I.hod[i]), room: room != null ? r2(room) : null,
    liq: cls === 'stock' ? LIQ_SHARE * Math.max(I.avgV[i] || 0, 1) : Infinity, dollarVol: hasVol ? (I.avgV[i] || 0) / (dir > 0 ? 1 : 1) * (dir > 0 ? px : 1 / px) : null, chgDay: ctx.pdc ? r2((px / ctx.pdc - 1) * 100) : null, t: done[i].t, pre: cls === 'stock' && done[i].t < regStart };
}
function chartTxt(c) {
  const P = n => c && c.cls === 'fx' ? n.toFixed(n < 10 ? 5 : 3) : pxF(n);
  if (!c) return 'Още няма достатъчно минути на графиката.';
  const sh = c.dir < 0, act = sh ? 'залагам на спад' : 'купувам';
  if (c.ready) return `${c.setup}${sh ? ' (надолу)' : ''}. ${sh ? 'Залагам на спад' : 'Вход'} около ${P(c.entry)}, стоп ${P(c.stop)} (${sh ? '+' : '−'}${String(c.riskPct).replace('.', ',')}%), цел ${P(c.target)} — печалбата е ${String(c.rr).replace('.', ',')} пъти риска.`;
  if (c.weak) return `${c.setup}. Не е момент — ${act} само при ясен сигнал.`;
  if (c.setup === 'Твърде разтеглена') return `Цената е избягала далеч от средната си (${String(c.ext).replace('.', ',')}× обичайното движение). Чакам да се върне към ${P(c.entry)}.`;
  return `${c.setup}. ${sh ? 'Ще заложа на спад' : 'Ще купя'} около ${P(c.entry)}.`;
}

/* ---------------- SKEPTIC: спори срещу всяка сделка ---------------- */
function skeptic(st, idea, nowMs, et, regStart) {
  const o = []; const add = (txt, w, hard) => o.push({ txt, w, hard: !!hard });
  const c = idea.chart, nw = idea.news, s = idea.sent, cls = idea.cls, dir = idea.dir || 1, sh = dir < 0, g = GP(st);
  const tone = nw ? nw.cat.tone * dir : 0; // новината „за“ или „против“ нашата посока
  if (nw && nw.cat.hard && !sh) add(`Новината е лоша: ${nw.cat.bg}. След такава новина цената често се срива.`, 5, true);
  if (sh && nw && nw.cat.tone >= 2) add(`Новините са добри (${nw.cat.bg}) — опасно е да залагаме на спад.`, 3);
  if (g.strat === 'news' && (!nw || tone < 1)) add('Стратегията ни е „само с новина в нашата посока“ — тук такава няма.', 5, true);
  if (cls === 'stock' && (H.isHalted(st, idea.sym, nowMs) || (st.halts && st.halts[idea.sym] && nowMs - st.halts[idea.sym].at < 15 * 60000))) add('Борсата току-що я спря заради резки движения — твърде нестабилна е.', 5, true);
  if (st.dayLocked) add(`Декът вече е на −${DAY_LOSS * 100}% за деня. Стига за днес.`, 5, true);
  const crazy = { stock: 150, crypto: 40, cmdty: 10, idx: 5, gold: 6, fut: 8, fx: 2 }[cls];
  if (c && c.chgDay != null && c.chgDay >= crazy && g.strat !== 'reversal') add(`Вече е ${sh ? 'поевтиняла' : 'поскъпнала'} с ${Math.round(c.chgDay)}% днес. Повечето такива движения свършват с рязко обръщане — ще сме последните.`, 5, true);
  if (nw && nw.cat.k === 'none') add(cls === 'stock' ? 'Няма никаква новина. Движение без причина често е помпане — някой купува, за да продаде на нас.' : 'Не намирам новина, която да обяснява движението.', cls === 'stock' ? 2 : 1);
  if (nw && nw.cat.k === 'rsplit') add('Обратно сливане на акции — обикновено е знак за слаба компания.', 2);
  if (nw && nw.cat.k === 'down' && !sh) add('Новините са по-скоро лоши.', 2);
  if (nw && sh && nw.cat.tone === 1) add('Новините са по-скоро добри — против нашата посока.', 1);
  if (nw && nw.cat.k === 'reg') add('Има регулаторен натиск — може да обърне цената.', 1);
  if (c && c.ext > 3 && g.strat !== 'reversal') add(`Гоним влака: цената е ${String(c.ext).replace('.', ',')} пъти обичайното движение ${sh ? 'под' : 'над'} средната. Ако влезем сега, влизаме късно.`, 2);
  if (c && c.rsi >= 82 && g.strat !== 'reversal') add(`Движението е прекалено бързо (RSI ${c.rsi}). След такова идва почивка или връщане.`, 1);
  if (c && !c.weak && c.room != null && c.room < 1 && g.strat !== 'reversal') add(`Целта ни е ${sh ? 'под днешното дъно' : 'над днешния връх'} — там ще срещнем съпротива.`, 1);
  if (c && c.weak) add(`Графиката не потвърждава: ${c.setup.toLowerCase()}.`, 2);
  if (cls === 'stock' && c && c.dollarVol != null && c.dollarVol < 25000) add(`Търгува се малко (около ${money(c.dollarVol)} на минута). Може да не успеем да излезем на добра цена.`, 2);
  if (cls === 'stock' && c && c.px < 2) add('Под $2 спредът е голям — губим още на влизане и излизане.', 1);
  if (cls === 'crypto' && !['BTC-USD', 'ETH-USD'].includes(idea.sym)) add('Алткойн: таксата на крипто борсата (0,25% на вход и изход) и по-резките движения ядат от печалбата.', 1);
  if (!sh && s && !s.guess && s.bullPct != null && s.bullPct >= 90 && s.hot) add(`Всички вече са вътре (${s.bullPct}% „купувай“). Кой ще купува след нас?`, 1);
  if (!sh && s && !s.guess && s.bullPct != null && s.bullPct < 40 && s.n >= 10) add(`Хората са песимисти (само ${s.bullPct}% „купувай“).`, 1);
  if (sh && s && !s.guess && s.bullPct != null && s.bullPct >= 75 && s.n >= 10) add(`Хората са оптимисти (${s.bullPct}% „купувай“) — опасно е да залагаме на спад.`, 1);
  if (['stock', 'cmdty', 'idx'].includes(cls) && et.min >= 15 * 60) add('Късно е — до затварянето на борсата остава малко време за движение.', 1);
  if (cls === 'fx' && !fxOpen(nowMs + 90 * 60000)) add('Валутният пазар скоро затваря за уикенда — сделката може да не успее да се развие.', 1);
  if (['stock', 'cmdty', 'idx'].includes(cls) && nowMs >= regStart && nowMs < regStart + 10 * 60000) add('Първите 10 минути след отварянето са хаос — цените скачат напосоки.', 1);
  if (c && c.pre) add('Премаркет: малко търговия и широк спред.', 1);
  if (cls === 'crypto' && [0, 6].includes(new Date(nowMs).getUTCDay())) add('Уикенд е — по-малко търговия, движенията лесно се обръщат.', 1);
  const today = st.trades.filter(t => nowMs - t.out < 12 * 3600e3);
  if (today.length >= 2 && today.slice(0, 2).every(t => t.pnl < 0)) add('Имаме 2 поредни загуби. Да не гоним — по-добре по-малко сделки.', 1);
  const score = o.reduce((a, x) => a + x.w, 0), hard = o.some(x => x.hard);
  const verdict = hard || score >= g.skipAt ? 'SKIP' : (!c || !c.ready || score >= g.waitAt) ? 'WAIT' : 'BUY';
  const txt = !o.length ? `Търсих причина да не ${sh ? 'залагаме на спад' : 'купуваме'} и не намерих сериозна. Може.` :
    (verdict === 'SKIP' ? 'ПРОПУСКАМЕ. ' : verdict === 'WAIT' ? 'ЧАКАМЕ. ' : 'Добре, но да знаем: ') + o.slice().sort((a, b) => b.w - a.w).slice(0, 3).map(x => x.txt).join(' ');
  return { objections: o, score, hard, verdict, txt };
}

/* ---------------- AI (по желание, безплатен ключ) ---------------- */
async function ai(st, idea, rule) {
  if (!GROQ && !GEMINI) return null;
  st.aiDay = st.aiDay || { d: st.day, n: 0 }; if (st.aiDay.d !== st.day) st.aiDay = { d: st.day, n: 0 };
  if (st.aiDay.n >= 300) return null; st.aiDay.n++; st.stats.aiCalls++;
  const facts = {
    asset: `${nameOf(idea.sym)} (${CLS_BG[idea.cls]})`, direction: (idea.dir || 1) > 0 ? 'LONG (покупка)' : 'SHORT (залагане на спад)', strategy: STRATS[GP(st).strat].name, price: idea.chart && idea.chart.px, change_today_pct: idea.scout.chg, change_5min_pct: idea.scout.chg5,
    news: (idea.news.items || []).slice(0, 4).map(n => `${n.title} (${n.pub})`), news_category: idea.news.cat.bg,
    sentiment: sentTxt(idea.sent), chart: chartTxt(idea.chart), skeptic_objections: rule.objections.map(x => x.txt), rule_verdict: rule.verdict,
  };
  const prompt = `Ти си екип от трейдъри на деск за дневна търговия (акции, крипто, валути, индекси, суровини; long и short; фалшиви пари, истински цени). Факти в JSON:\n${JSON.stringify(facts)}\n` +
    `Върни САМО JSON с ключове: "why" (1–2 изречения на прост български: защо цената се движи според новините; ако няма новина, кажи го), ` +
    `"skeptic" (2–3 изречения на български: най-силните аргументи СРЕЩУ сделката в тази посока, остро и конкретно), "chief" (1–2 изречения на български: окончателното решение и защо), ` +
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
  const sc = idea.scout, nw = idea.news, s = idea.sent, c = idea.chart, k = kOf(idea.sym), dir = idea.dir || 1, rev = GP(st).strat === 'reversal' ? -1 : 1;
  const bp = s.bullPct == null ? null : dir > 0 ? s.bullPct : 100 - s.bullPct;
  let conv = Math.min(3, Math.abs((sc.chg5 || 0) / 2 + rev * sc.chg / 25) / k) + nw.cat.tone * dir + (bp == null ? 0 : bp >= 60 ? 1 : bp < 40 ? -1 : 0) + (c && c.room != null && c.room >= 2 ? 1 : 0) - sk.score * 0.5;
  conv = r2(Math.max(0, Math.min(5, conv)));
  let v = sk.verdict, why;
  const act = dir > 0 ? 'Купуваме' : 'Залагаме на спад';
  if (v === 'SKIP') why = 'Скептикът наложи вето — не влизаме.';
  else if (v === 'WAIT') why = c && c.ready ? 'Има възражения, които могат да се оправят — гледаме още.' : 'Няма ясен вход още — гледаме графиката.';
  else if (conv < GP(st).minConv) { v = 'SKIP'; why = `Идеята е слаба (увереност ${String(conv).replace('.', ',')} от 5) — не си струва риска.`; }
  else if (st.positions.length >= MAX_POS) { v = 'WAIT'; why = `Вече имаме ${MAX_POS} сделки — чакаме да се освободи място.`; }
  else why = `Всички сигнали са „за“. ${act} с увереност ${String(conv).replace('.', ',')} от 5.`;
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
  idea.chart = data ? chartPlan(idea.sym, data.arr, data.ctx, nowMs, regStart, GP(st), idea.dir || 1) : null;
  if (idea.chart && idea.chart.chgDay != null) idea.scout.chg = r2((idea.dir || 1) > 0 ? idea.chart.chgDay : (1 / (1 + idea.chart.chgDay / 100) - 1) * 100);
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
    const d = D[idea.sym]; const o = idea.order; const dir = idea.dir || 1, D2 = disp(idea.sym);
    const nb = d && d.arr.find(b => b.t > o.t && b.t <= nowMs - 60000);
    if (!nb) { if (nowMs - o.t > 4 * 60000) { idea.status = 'expired'; say(st, nowMs, 'chief', `Поръчката за ${D2} не се изпълни за 3 минути — отказваме се.`, idea.id); } continue; }
    const pre = clsOf(idea.sym) === 'stock' && nb.t < regStart, fill = nb.o * (1 + dir * halfSpread(idea.sym, nb.o, pre));
    if (dir > 0 ? fill > o.limit : fill < o.limit) { idea.status = 'expired'; say(st, nb.t, 'chief', `${D2} отвори на ${pxS(idea.sym, nb.o)}, ${dir > 0 ? 'над' : 'под'} лимита ни ${pxS(idea.sym, o.limit)}. Не гоним — отказваме се.`, idea.id); note(st, 'skip', `⛔ ${D2}: не влязохме`, `Цената избяга от лимита ${pxS(idea.sym, o.limit)}.`, idea.id); continue; }
    const eq = equity(st), cls = clsOf(idea.sym), feeK = cls === 'crypto' ? 1 + CRYPTO_FEE : 1;
    let qty = Math.min(eq * o.sizePct, st.cash) / (fill * feeK);
    qty = Math.min(qty, GP(st).risk * eq / Math.max(Math.abs(fill - o.stop), fill * 0.002), o.liq || Infinity);
    qty = cls === 'stock' ? Math.floor(qty) : cls === 'crypto' ? Math.floor(qty * 1e6) / 1e6 : Math.floor(qty * 1e4) / 1e4;
    if (!(qty > 0) || qty * fill < 10) { idea.status = 'expired'; say(st, nb.t, 'chief', `${D2}: твърде малко се търгува, за да влезем с реална сума.`, idea.id); continue; }
    const fee = buyFee(idea.sym, qty * fill); st.cash -= qty * fill + fee; // при залагане на спад: заложените пари (без ливъридж)
    const risk = Math.max(Math.abs(fill - o.stop), fill * MIN_RISK[cls]), rr = GP(st).rr;
    const tgt = o.target && (o.target - fill) * dir > risk * 0.8 ? o.target : fill + dir * rr * risk;
    const p = { id: 'p' + nb.t.toString(36) + D2.replace(/\W/g, ''), idea: idea.id, sym: idea.sym, cls, dir, qty, entry: r6(fill), t: nb.t, stop: r6(fill - dir * risk), stop0: r6(fill - dir * risk), target: r6(tgt), risk: r6(risk), feeIn: r2(fee), last: fill, peak: fill, lastT: nb.t };
    st.positions.push(p); idea.status = 'open'; idea.pos = p.id;
    const verb = dir > 0 ? 'Купихме' : 'Заложихме на спад:';
    say(st, nb.t, 'chief', `${verb} ${qtyF(qty)} ${D2} по ${pxS(idea.sym, fill)} (${money(qty * fill)}${fee ? `, такса ${money(fee)}` : ''}). Стоп ${pxS(p.sym, p.stop)}, цел ${pxS(p.sym, p.target)}.`, idea.id);
    note(st, 'buy', dir > 0 ? `🟢 КУПИХМЕ ${D2}` : `🔻 ЗАЛОЖИХМЕ НА СПАД: ${D2}`, `${qtyF(qty)} по ${pxS(idea.sym, fill)} · ${money(qty * fill)} · стоп ${pxS(p.sym, p.stop)} · цел ${pxS(p.sym, p.target)}`, idea.id);
  }

  // 4) управление на позициите (всяка минута, по минутните свещи)
  for (const p of [...st.positions]) {
    const d = D[p.sym]; if (!d) continue;
    const dir = p.dir || 1, g = GP(st);
    const halted = p.cls === 'stock' && H.isHalted(st, p.sym, nowMs);
    for (const b of d.arr.filter(x => x.t > p.lastT && x.t <= nowMs - 60000)) {
      p.lastT = b.t; p.last = b.c;
      if (p.cls === 'stock' && H.isHalted(st, p.sym, b.t)) continue; // спряна — не може да се продаде
      const pre = p.cls === 'stock' && b.t < regStart, sp = halfSpread(p.sym, b.o, pre);
      const out = x => x * (1 - dir * sp); // излизане: при покупка продаваме на „бид“, при спад купуваме обратно на „аск“
      if (p.exitNext) { closePos(st, p, out(b.o), b.t, p.exitNext); break; }
      if (['stock', 'cmdty', 'idx'].includes(p.cls) && S && b.t >= S.end - 5 * 60000) { closePos(st, p, out(b.c), b.t, 'eod'); break; }
      if (p.cls === 'fx' && !fxOpen(b.t + 6 * 60000)) { closePos(st, p, out(b.c), b.t, 'eod'); break; } // преди уикенда
      const adverse = dir > 0 ? b.l : b.h, favor = dir > 0 ? b.h : b.l;
      if (!pre && (adverse - p.stop) * dir <= 0) { closePos(st, p, out(dir > 0 ? Math.min(p.stop, b.o) : Math.max(p.stop, b.o)), b.t, (p.stop - p.entry) * dir >= 0 ? 'be' : 'stop'); break; }
      if ((favor - p.target) * dir >= 0) { closePos(st, p, dir > 0 ? Math.max(p.target, b.o) : Math.min(p.target, b.o), b.t, 'target'); break; }
      if (pre && (b.c - p.stop) * dir <= 0) { p.exitNext = 'stop'; continue; }
      p.peak = dir > 0 ? Math.max(p.peak, b.h) : Math.min(p.peak, b.l);
      if ((p.peak - p.entry) * dir >= g.beAt * p.risk && (p.stop - p.entry) * dir < 0) { p.stop = r6(p.entry); say(st, b.t, 'chief', `${disp(p.sym)} е на печалба — местя стопа на входа. Вече не можем да загубим (освен таксите).`, p.idea); }
      if ((b.t - p.t) / 60000 >= g.maxHold) { p.exitNext = 'time'; continue; }
      if (g.vwapExit && b.t - p.t > 10 * 60000) {
        const sub = d.arr.filter(x => x.t <= b.t); const I = H.indic(sub, d.ctx); const k = I.c.length - 1; const vw = I.cumV[k] > 0 ? I.vwap[k] : I.ema(20)[k];
        if ((I.c[k] - vw) * dir < 0 && (I.c[k] - p.entry) * dir < 0.5 * p.risk) { p.exitNext = 'vwap'; say(st, b.t, 'chart', `${disp(p.sym)} мина от другата страна на средната си цена — силата изчезна. Излизаме на следващата минута.`, p.idea); }
      }
    }
    if (st.positions.includes(p)) {
      const lb = d.arr[d.arr.length - 1]; if (lb && lb.t > p.lastT) p.last = lb.c; // цената сега (и от текущата минута) — за сметката и екрана
      const nw = st.news[p.sym]; if (nw && nw.at > p.t && !p.exitNext && ((dir > 0 && nw.cat.hard) || (dir < 0 && nw.cat.tone >= 2))) { p.exitNext = 'news'; say(st, nowMs, 'news', `Нова новина против нас за ${nameOf(p.sym)}: ${nw.cat.bg}. Излизаме!`, p.idea); }
      if (halted && !p.haltSaid) { p.haltSaid = 1; say(st, nowMs, 'chief', `⏸ ${p.sym} е спряна от борсата — не можем да продадем, докато не я пуснат.`, p.idea); note(st, 'sell', `⏸ ${p.sym} е спряна`, 'Не можем да продадем, докато борсата не я пусне.', p.idea); }
    }
  }
  // уволнение на целия екип при загуба от FIRE_EUR евро (по курса EUR/USD на живо)
  if (!st.gen) st.gen = { n: 1, at: st.created || nowMs, start: START, p: { ...GEN0 } };
  { const L = st.live && st.live['EURUSD=X']; if (L && L.px > 0.5 && L.px < 2) st.eurusd = L.px; }
  const fireUsd = FIRE_EUR * (st.eurusd || 1.1), eqG = equity(st);
  if (eqG <= st.gen.start - fireUsd) {
    const g = st.gen; const T = st.trades.filter(t => t.out >= g.at);
    (st.gens = st.gens || []).unshift({ n: g.n, at: g.at, to: nowMs, pnl: r2(eqG - g.start), trades: T.length, won: T.filter(t => t.pnl > 0).length, p: g.p });
    st.gens = st.gens.slice(0, 30);
    const p2 = newGenParams(g.p);
    st.gen = { n: g.n + 1, at: nowMs, start: r2(eqG), p: p2 };
    for (const i of st.ideas) if (['wait', 'pending'].includes(i.status)) i.status = 'expired';
    say(st, nowMs, 'chief', `🔥 Екип №${g.n} е УВОЛНЕН: загуби ${money(g.start - eqG)} (над €${FIRE_EUR}). Идва екип №${st.gen.n} с нови правила. ${genTxt(p2).join('. ')}.`);
    note(st, 'summary', `🔥 Екип №${g.n} е уволнен`, `Загуба ${sgnM(eqG - g.start)} (над €${FIRE_EUR}). Идва екип №${st.gen.n} с нови правила. Отворените сделки поема новият екип.`);
  }
  // дневен лимит
  const eqNow = equity(st);
  if (!st.dayLocked && eqNow <= st.dayStart * (1 - DAY_LOSS)) { st.dayLocked = true; say(st, nowMs, 'chief', `Днес сме на ${pctF((eqNow / st.dayStart - 1) * 100)}. Спираме да купуваме до утре — правилото е −${DAY_LOSS * 100}% на ден.`); note(st, 'summary', '🛑 Декът спира за днес', `Загуба ${pctF((eqNow / st.dayStart - 1) * 100)} — без нови сделки до утре.`); }

  // 5) нови идеи от Scout
  for (const c of cands) {
    const cls = c.cls;
    const idea = { id: 'i' + nowMs.toString(36) + disp(c.s).replace(/\W/g, ''), sym: c.s, cls, dir: c.dir || 1, strat: GP(st).strat, t: nowMs, status: 'new', scout: { px: r6(c.px), chg: r2(c.chg), chg5: c.chg5 != null ? r2(c.chg5) : null, chg15: c.chg15 != null ? r2(c.chg15) : null, vol: c.vol }, log: [] };
    idea.scout.txt = `${nameOf(c.s)} (${CLS_BG[cls].toLowerCase()}) се движи: ${pctF(c.chg)} ${['stock', 'cmdty', 'idx'].includes(cls) ? 'днес' : 'от вчерашното затваряне'}` + (c.chg5 != null ? `, ${pctF(c.chg5)} за последните 5 минути` : '') + (cls === 'stock' && c.vol ? `, обем ${(c.vol / 1e6).toFixed(1).replace('.', ',')} млн. акции` : '') + `. Виждам ${c.why}${(c.dir || 1) < 0 ? ' — предлагам да заложим на спад' : ''}.`;
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
    if (st.trades.some(t => t.sym === idea.sym && t.idea !== idea.id && sameDay(st, { sym: t.sym, cls: t.cls, t: t.out }, nowMs))) { idea.status = 'expired'; idea.chief.why = 'Вече търгувахме това днес — не купуваме отново.'; say(st, nowMs, 'chief', `${disp(idea.sym)}: вече я търгувахме днес. Няма смисъл да купуваме пак — отказваме се.`, idea.id); continue; }
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
  const dir = idea.dir || 1;
  if (v === 'BUY' && idea.chart && idea.chart.ready) {
    idea.status = 'pending'; st.stats.buy++;
    const lim = (idea.chart.pre ? 0.02 : { stock: 0.01, crypto: 0.003, cmdty: 0.002, idx: 0.0015, gold: 0.002, fx: 0.0005 }[idea.cls] || 0.003);
    idea.order = { t: idea.chart.t, limit: r6(idea.chart.px * (1 + dir * lim)), stop: idea.chart.stop, target: idea.chart.target, sizePct: ch.sizePct, liq: idea.chart.liq === Infinity ? null : idea.chart.liq };
    say(st, nowMs, 'chief', `${dir > 0 ? 'КУПУВАМЕ' : 'ЗАЛАГАМЕ НА СПАД:'} ${D}. ${txt} Лимит ${pxS(idea.sym, idea.order.limit)}, ${Math.round(ch.sizePct * 100)}% от сметката.`, idea.id);
  } else if (v === 'WAIT') {
    idea.status = 'wait'; if (first) st.stats.wait++;
    say(st, nowMs, 'chief', `ЧАКАМЕ с ${D}${dir < 0 ? ' (за спад)' : ''}. ${txt}`, idea.id);
    note(st, 'wait', `⏳ ЧАКАМЕ ${D}${dir < 0 ? ' ↓' : ''}`, `${idea.skeptic.objections[0] || ch.why}`.slice(0, 160), idea.id);
  } else {
    idea.status = 'skip'; st.stats.skip++; if (idea.skeptic.hard) st.stats.vetoHard++;
    say(st, nowMs, 'chief', `ПРОПУСКАМЕ ${D}. ${txt}`, idea.id);
    note(st, 'skip', `⛔ ПРОПУСКАМЕ ${D}${dir < 0 ? ' ↓' : ''}`, `${idea.skeptic.objections[0] || ch.why}`.slice(0, 160), idea.id);
    shadowStart(idea, nowMs);
  }
}
const WHY = { target: 'целта е достигната', stop: 'стопът се задейства', be: 'цената се върна до входа (стопът беше на входа)', time: 'времето за държане изтече', vwap: 'цената мина от другата страна на средната', news: 'излезе новина против нас', eod: 'пазарът затваря (краят на деня или пауза)' };
function closePos(st, p, px, t, why) {
  const dir = p.dir || 1, fee = sellFee(p.sym, p.qty, px), val = posVal(p, px); st.cash += val - fee;
  const pnl = val - fee - p.qty * p.entry - (p.feeIn || 0), pct = dir * (px / p.entry - 1) * 100;
  st.positions = st.positions.filter(x => x !== p);
  const tr = { id: p.id, idea: p.idea, sym: p.sym, d: disp(p.sym), cls: p.cls, dir, qty: p.qty, entry: p.entry, exit: r6(px), in: p.t, out: t, pnl: r2(pnl), pct: r2(pct), r: r2(dir * (px - p.entry) / p.risk), why, stop0: p.stop0, target: p.target, fees: r2(fee + (p.feeIn || 0)) };
  st.trades.unshift(tr); if (st.trades.length > 400) st.trades.length = 400;
  const idea = st.ideas.find(i => i.id === p.idea); if (idea) { idea.status = 'closed'; idea.result = { pnl: tr.pnl, pct: tr.pct, why }; }
  const verb = dir > 0 ? 'Продадохме' : 'Затворихме залога на спад за';
  say(st, t, 'chief', `${verb} ${disp(p.sym)} по ${pxS(p.sym, px)} — ${WHY[why]}. Резултат: ${pctF(pct)} (${sgnM(pnl)} след таксите).`, p.idea);
  note(st, 'sell', `${pnl >= 0 ? '🟢' : '🔴'} ${dir > 0 ? 'ПРОДАДОХМЕ' : 'ЗАТВОРИХМЕ СПАДА'} ${disp(p.sym)} ${pctF(pct)}`, `${sgnM(pnl)} · ${WHY[why]} · сметка ${money(equity(st))}`, p.idea);
}
function shadowStart(idea, nowMs) {
  const c = idea.chart; if (!c) return;
  const d = idea.dir || 1; idea.shadow = { t: nowMs, dir: d, entry: c.px, stop: (c.px - c.stop) * d > 0 ? c.stop : c.px * (1 - d * 0.03), target: (c.target - c.px) * d > 0 ? c.target : c.px * (1 + d * 0.06), out: null };
}
function shadows(st, nowMs) {
  for (const idea of st.ideas) {
    const sh = idea.shadow; if (!sh || sh.out) continue;
    const m = st.live && st.live[idea.sym]; const pts = m && m.pts ? m.pts.filter(p => p[0] > sh.t) : [];
    const d = sh.dir || 1; let out = null; for (const [, c] of pts) { if ((c - sh.stop) * d <= 0) { out = 'stop'; break; } if ((c - sh.target) * d >= 0) { out = 'target'; break; } }
    if (!out && nowMs - sh.t > 60 * 60000) out = 'none';
    if (out) {
      sh.out = out; sh.pct = r2(d * ((out === 'stop' ? sh.stop : out === 'target' ? sh.target : (pts.length ? pts[pts.length - 1][1] : sh.entry)) / sh.entry - 1) * 100);
      st.stats.shadowN++; if (out === 'stop') st.stats.saved++; if (out === 'target') st.stats.missed++;
      if (out !== 'none') say(st, nowMs, 'skeptic', out === 'stop' ? `Казах ли ви? ${disp(idea.sym)}, която пропуснахме, щеше да удари стопа (${pctF(sh.pct)}). Спестихме загуба.` : `Признавам: ${disp(idea.sym)}, която пропуснахме, стигна целта (${pctF(sh.pct)}). Тук сбърках.`, idea.id);
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
  return { id: i.id, sym: i.sym, d: disp(i.sym), cls: i.cls || clsOf(i.sym), dir: i.dir || 1, name: nameOf(i.sym), t: i.t, status: i.status, v: i.chief && i.chief.verdict, conv: i.chief && i.chief.conv, chg: i.scout.chg, chg5: i.scout.chg5,
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
  const positions = st.positions.map(p => ({ ...p, dir: p.dir || 1, d: disp(p.sym), name: nameOf(p.sym), pnl: r2(posVal(p, p.last) - p.qty * p.entry - (p.feeIn || 0)), pct: r2((p.dir || 1) * (p.last / p.entry - 1) * 100), halted: (p.cls === 'stock' && H.isHalted(st, p.sym, nowMs)) || undefined }));
  const byCls = {}; for (const t of st.trades) { const c = t.cls || clsOf(t.sym); const b = byCls[c] = byCls[c] || { n: 0, won: 0, pnl: 0 }; b.n++; if (t.pnl > 0) b.won++; b.pnl = r2(b.pnl + t.pnl); }
  return {
    v: 'desk', startCash: START, cash: r2(st.cash), equity: r2(eq), total: r2(eq - START), totalPct: r2((eq / START - 1) * 100), today: r2(eq - (st.dayStart || START)), todayPct: r2((eq / (st.dayStart || START) - 1) * 100),
    status: st.status, dataT: st.dataT || null, src: st.src || null, session: st.session, day: st.day, lastTick: st.lastTick, dayLocked: !!st.dayLocked, scan: st.scan || null, ticker: st.live ? tickerOf(st.live) : (st.lastTicker || []),
    positions, trades: st.trades.slice(0, 150).map(t => ({ ...t, dir: t.dir || 1, d: t.d || disp(t.sym), cls: t.cls || clsOf(t.sym) })), ideas: st.ideas.slice(0, 80).map(brief), feed: st.feed.slice(0, 150), eqHist: st.eqHist,
    stats: { ...st.stats, closed, won, winRate: closed ? Math.round(won / closed * 100) : null, todayTrades: today.length, todayWon: today.filter(t => t.pnl > 0).length, ideasToday: ideasToday.length, byCls,
      bestPct: closed ? Math.max(...st.trades.map(t => t.pct)) : null, worstPct: closed ? Math.min(...st.trades.map(t => t.pct)) : null, avgPct: closed ? r2(st.trades.reduce((a, t) => a + t.pct, 0) / closed) : null },
    health: st.health || {}, ai: GROQ ? 'Groq' : GEMINI ? 'Gemini' : null, finnhub: !!FINNHUB, agents: AGENTS,
    markets: { crypto: Object.keys(CRYPTO).map(disp), idx: ['^NDX', '^GSPC', '^DJI'].map(nameOf), cmdty: ['Злато (24/7)', ...Object.keys(CMDTY).filter(x => x !== 'GLD').map(nameOf)], fx: Object.keys(FX).map(nameOf), fxOpen: fxOpen(nowMs) },
    rules: { maxPos: MAX_POS, dayLoss: DAY_LOSS * 100, risk: GP(st).risk * 100, waitMin: WAIT_MIN, maxHold: GP(st).maxHold, cryptoFee: CRYPTO_FEE * 100 },
    gen: (() => { const g = st.gen || { n: 1, at: st.created, start: START, p: GEN0 }; const fu = FIRE_EUR * (st.eurusd || 1.1); return { n: g.n, at: g.at, start: g.start, pnl: r2(eq - g.start), fireEur: FIRE_EUR, fireUsd: r2(fu), left: r2(eq - (g.start - fu)), txt: genTxt({ ...GEN0, ...g.p }), strat: STRATS[{ ...GEN0, ...g.p }.strat].name }; })(),
    gens: st.gens || [],
  };
}
module.exports = { tick, tickWithLock, loadState, view, ideaFull, _t: { chartPlan, skeptic, classify, chief, fresh, clsOf } };
