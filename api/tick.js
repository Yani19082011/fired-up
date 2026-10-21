// Една стъпка на състезанието. Вика се всяка минута от cron-job.org (и от приложението, ако е отворено).
const E = require('./_engine');
module.exports = async (req, res) => {
  res.setHeader('cache-control', 'no-store');
  try {
    const { st, ran } = await E.tickWithLock(Date.now());
    res.status(200).json({ ok: true, ran, status: st?.status, lastBar: st?.lastBar, bots: st?.bots?.length });
  } catch (e) {
    console.error('tick error', e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
