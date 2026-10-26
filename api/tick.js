// Една стъпка на деска. Вика се всяка минута от cron-job.org (и от приложението, ако е отворено).
const D = require('./_desk');
module.exports = async (req, res) => {
  res.setHeader('cache-control', 'no-store');
  try {
    const { st, ran } = await D.tickWithLock(Date.now());
    res.status(200).json({ ok: true, ran, status: st?.status, equity: st ? Math.round((st.cash + st.positions.reduce((a, p) => a + p.qty * (p.last || p.entry), 0)) * 100) / 100 : undefined, ideas: st?.ideas?.length });
  } catch (e) {
    console.error('tick error', e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
