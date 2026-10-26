// Данните за приложението (декът). Ако никой не е „бутнал“ деска скоро, прави една стъпка.
const D = require('./_desk');
module.exports = async (req, res) => {
  res.setHeader('cache-control', 'no-store');
  try {
    let st = await D.loadState();
    if (!st || !st.lastTick || Date.now() - st.lastTick > 30000) {
      try { const r = await D.tickWithLock(Date.now(), 25000); st = r.st || st || await D.loadState(); }
      catch (e) { console.error('inline tick', e.message); if (!st) throw e; }
    }
    if (!st) return res.status(503).json({ error: 'starting' });
    const id = String(req.query.idea || '');
    if (id) { const i = D.ideaFull(st, id); return res.status(i ? 200 : 404).json(i ? { idea: i } : { error: 'no_idea' }); }
    res.status(200).json(D.view(st));
  } catch (e) {
    const m = String(e.message || e);
    res.status(500).json({ error: m.includes('no_kv') ? 'no_kv' : 'error', message: m.slice(0, 200) });
  }
};
