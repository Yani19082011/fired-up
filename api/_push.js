// Fired Up — известия на телефона (Web Push). Ключовете (VAPID) се създават сами веднъж и се пазят в Upstash.
const crypto = require('crypto');
let webpush = null;
try { webpush = require('web-push'); } catch (e) { console.error('web-push не е инсталиран', e.message); }

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
async function kv(cmd) {
  const r = await fetch(KV_URL, { method: 'POST', headers: { Authorization: `Bearer ${KV_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(cmd) });
  const d = await r.json().catch(() => ({})); if (d.error) throw new Error('kv: ' + d.error); return d.result ?? null;
}
const SUBS = 'arena:subs';
const CATS = ['buy', 'sell', 'fired', 'summary'];
const DEFAULT_PREFS = { buy: true, sell: true, fired: true, summary: true, favOnly: false, favs: [] };

async function keys() {
  let k = await kv(['GET', 'arena:vapid']);
  if (!k && webpush) { await kv(['SET', 'arena:vapid', JSON.stringify(webpush.generateVAPIDKeys()), 'NX']); k = await kv(['GET', 'arena:vapid']); }
  return k ? JSON.parse(k) : null;
}
const idOf = endpoint => crypto.createHash('sha1').update(String(endpoint)).digest('hex').slice(0, 24);

async function allSubs() {
  const a = await kv(['HGETALL', SUBS]) || []; const out = [];
  for (let i = 0; i < a.length; i += 2) { try { out.push({ id: a[i], ...JSON.parse(a[i + 1]) }); } catch (e) {} }
  return out;
}
async function saveSub(sub, prefs) {
  const id = idOf(sub.endpoint); const old = await kv(['HGET', SUBS, id]);
  const p = { ...DEFAULT_PREFS, ...(old ? JSON.parse(old).prefs : {}), ...(prefs || {}) };
  await kv(['HSET', SUBS, id, JSON.stringify({ sub, prefs: p, at: Date.now() })]);
  return { id, prefs: p };
}
async function removeSub(endpoint) { await kv(['HDEL', SUBS, idOf(endpoint)]); }

async function sendTo(s, payload, v) {
  try { await webpush.sendNotification(s.sub, JSON.stringify(payload), { TTL: 6 * 3600, urgency: 'high', vapidDetails: { subject: 'mailto:fired-up@example.com', publicKey: v.publicKey, privateKey: v.privateKey } }); return true; }
  catch (e) { if (e.statusCode === 404 || e.statusCode === 410) { await kv(['HDEL', SUBS, s.id]).catch(() => {}); return 'gone'; } console.error('push', e.statusCode, String(e.body || e.message).slice(0, 120)); return false; }
}
// msgs: [{ cat, title, body, bot, url }]
async function flush(msgs) {
  if (!webpush || !msgs || !msgs.length || !KV_URL) return;
  const v = await keys(); if (!v) return;
  const subs = await allSubs(); if (!subs.length) return;
  await Promise.allSettled(subs.map(async s => {
    const p = s.prefs || DEFAULT_PREFS;
    let mine = msgs.filter(m => p[m.cat] !== false && (!p.favOnly || m.cat === 'summary' || !m.bot || (p.favs || []).includes(m.bot)));
    const extra = mine.length - 12; if (extra > 0) mine = mine.slice(0, 12); // не повече от 12 наведнъж
    for (const m of mine) { if (await sendTo(s, { title: m.title, body: m.body, url: m.url || (m.bot ? `/?bot=${m.bot}` : '/'), tag: m.tag || undefined }, v) === 'gone') return; }
    if (extra > 0) await sendTo(s, { title: `И още ${extra} събития`, body: 'Отвори приложението, за да видиш всичко в „На живо“.', url: '/' }, v);
  }));
}
module.exports = { keys, saveSub, removeSub, allSubs, sendTo, flush, CATS, DEFAULT_PREFS, idOf, kv, available: () => !!webpush };
