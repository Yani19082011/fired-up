// Известия: публичен ключ, абониране, настройки и пробно известие.
const P = require('./_push');
module.exports = async (req, res) => {
  res.setHeader('cache-control', 'no-store');
  try {
    if (!P.available()) return res.status(500).json({ error: 'no_webpush' });
    if (req.method === 'GET') { const k = await P.keys(); return res.status(200).json({ key: k && k.publicKey }); }
    let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    b = b || {};
    const sub = b.sub && b.sub.endpoint && /^https:\/\//.test(b.sub.endpoint) ? b.sub : null;
    if (!sub) return res.status(400).json({ error: 'no_sub' });
    if (b.action === 'unsubscribe') { await P.removeSub(sub.endpoint); return res.status(200).json({ ok: true }); }
    const prefs = {};
    if (b.prefs) { for (const k of [...P.CATS, 'favOnly']) if (k in b.prefs) prefs[k] = !!b.prefs[k]; if (Array.isArray(b.prefs.favs)) prefs.favs = b.prefs.favs.map(String).slice(0, 200); }
    const r = await P.saveSub(sub, prefs);
    if (b.action === 'test') { const v = await P.keys(); await P.sendTo({ id: r.id, sub, prefs: r.prefs }, { title: '🔥 Fired Up', body: 'Известията работят! Тук ще идват решенията на деска: купи, чакай, пропусни и продажби.', url: '/' }, v); }
    return res.status(200).json({ ok: true, prefs: r.prefs });
  } catch (e) { res.status(500).json({ error: 'error', message: String(e.message || e).slice(0, 200) }); }
};
