// Coinbase Exchange — минутни свещи за крипто направо от борсата, на живо, с истински обем. Публично, без ключ и без регистрация.
// BNB и TRX ги няма в Coinbase → за тях остава Yahoo.
const NOT = new Set(['BNB-USD', 'TRX-USD']);
const UA = { 'User-Agent': 'fired-up-desk/1.0', Accept: 'application/json' };
async function cbBars(sym, fromMs, toMs = Date.now()) {
  if (NOT.has(sym)) throw new Error('няма го в Coinbase');
  const seen = new Map(); let end = toMs + 60000;
  for (let page = 0; page < 3 && end > fromMs; page++) { // до 300 свещи на заявка
    const start = Math.max(fromMs, end - 300 * 60000);
    const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), 8000);
    let a;
    try {
      const r = await fetch(`https://api.exchange.coinbase.com/products/${encodeURIComponent(sym)}/candles?granularity=60&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`, { headers: UA, signal: ac.signal });
      if (!r.ok) throw new Error('coinbase ' + r.status);
      a = await r.json();
    } finally { clearTimeout(tm); }
    if (!Array.isArray(a)) throw new Error('coinbase: странен отговор');
    for (const c of a) seen.set(c[0] * 1000, { t: c[0] * 1000, l: +c[1], h: +c[2], o: +c[3], c: +c[4], v: +c[5] }); // [час, ниско, високо, отваряне, затваряне, обем]
    end = start;
  }
  const out = [...seen.values()].sort((a, b) => a.t - b.t);
  if (!out.length) throw new Error('coinbase: няма свещи');
  return out;
}
module.exports = { cbBars, NOT };
