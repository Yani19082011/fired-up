// Минутна графика на една акция (за екрана на трейдъра). Без from/to — днешният ден; с from/to (ms) — минал период
// (Yahoo пази минутни данни около 30 дни назад). При отказ на Yahoo за днешния ден — Alpaca IEX.
const E = require('./_engine');
module.exports = async (req, res) => {
  const s = String(req.query.s || '').toUpperCase().replace(/[^A-Z.\-]/g, '').slice(0, 10);
  if (!s) return res.status(400).json({ error: 'no_symbol' });
  const from = Number(req.query.from) || 0, to = Number(req.query.to) || 0;
  try {
    let bars, session = null, prevClose = null, past = false;
    if (from && to && to > from) {
      past = Date.now() - to > 3600e3;
      const p1 = Math.floor(from / 1000) - 3600, p2 = Math.ceil(to / 1000) + 3600;
      const d = await E.yget(`/v8/finance/chart/${encodeURIComponent(s)}?interval=1m&period1=${p1}&period2=${p2}&includePrePost=true`);
      const r = d?.chart?.result?.[0]; if (!r) throw new Error('yahoo empty');
      bars = E.ybars(r);
    } else {
      if (/-USD$/.test(s)) { // крипто: денят никога не свършва → последните 8 часа (Coinbase на живо; ако го няма там — Yahoo)
        try { bars = await require('./_cb').cbBars(s, Date.now() - 8 * 3600e3); } catch (e) { bars = null; }
        if (!bars) {
        const d = await E.yget(`/v8/finance/chart/${encodeURIComponent(s)}?interval=1m&period1=${Math.floor((Date.now() - 8 * 3600e3) / 1000)}&period2=${Math.ceil(Date.now() / 1000) + 60}`);
        const r = d?.chart?.result?.[0]; if (!r) throw new Error('yahoo empty'); bars = E.ybars(r);
        }
      } else
      try { const r = await E.yIntraday(s); bars = r.bars; session = r.session; prevClose = r.prevClose ?? null; }
      catch (e) { const r = await E.alpacaIntraday([s], Date.now() - 18 * 3600e3); bars = (r && r[s]) || []; }
      if (session) bars = bars.filter(b => b.t >= session.start && b.t < session.end);
    }
    res.setHeader('cache-control', past ? 'public, s-maxage=86400' : 'public, s-maxage=10, stale-while-revalidate=10');
    res.status(200).json({ s, session, prevClose, bars: bars.map(b => [b.t, b.o, b.h, b.l, b.c, b.v]) });
  } catch (e) {
    res.setHeader('cache-control', 'no-store');
    res.status(502).json({ error: 'no_data', message: String(e.message || e).slice(0, 160) });
  }
};
