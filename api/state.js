// Данните за приложението. Ако никой не е „бутнал“ състезанието скоро, прави една стъпка.
const E = require('./_engine');
module.exports = async (req, res) => {
  res.setHeader('cache-control', 'no-store');
  try {
    let st = await E.loadState();
    if (!st || !st.lastTick || Date.now() - st.lastTick > 30000) {
      try { const r = await E.tickWithLock(Date.now(), 25000); st = r.st || st; }
      catch (e) { console.error('inline tick', e.message); if (!st) throw e; }
    }
    const id = String(req.query.bot || '');
    if (id) { const H = await E.loadHist().catch(() => ({})); const v = E.view(st, Date.now(), { full: id, hist: H[id] }); const b = v.bots.find(x => x.id === id); return res.status(b ? 200 : 404).json(b ? { bot: b } : { error: 'no_bot' }); }
    res.status(200).json(E.view(st));
  } catch (e) {
    const m = String(e.message || e);
    res.status(500).json({ error: m.includes('no_kv') ? 'no_kv' : (m.includes('no_fallback') || m.includes('yahoo')) ? 'no_alpaca' : m.includes('alpaca 40') ? 'bad_alpaca' : 'error', message: m.slice(0, 200) });
  }
};
