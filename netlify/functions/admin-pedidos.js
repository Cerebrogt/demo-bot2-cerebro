// Llantas Total — API admin: lista de pedidos y clientes calientes
// GET con header x-admin-password === ADMIN_PASSWORD
const { Redis } = require('@upstash/redis');

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try { return new Redis({ url, token }); } catch { return null; }
}

function parseVal(v) {
  if (!v) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return null; }
}

exports.handler = async (event) => {
  const pass = event.headers['x-admin-password'] || event.headers['X-Admin-Password'];
  if (!process.env.ADMIN_PASSWORD || pass !== process.env.ADMIN_PASSWORD) {
    return { statusCode: 401, body: JSON.stringify({ error: 'unauthorized' }) };
  }
  const redis = getRedis();
  if (!redis) return { statusCode: 500, body: JSON.stringify({ error: 'redis not configured' }) };

  try {
    const allKeys = await redis.keys('*');
    const pedidoKeys = allKeys.filter(k => k.startsWith('pedido:') && !k.startsWith('pedido_dedup:'));
    const hotKeys = allKeys.filter(k => k.startsWith('hot:'));
    const convKeys = allKeys.filter(k => k.startsWith('conv:'));

    const pedidos = [];
    for (const k of pedidoKeys) {
      const data = parseVal(await redis.get(k));
      if (data) pedidos.push({ telefono: k.slice('pedido:'.length), ...data });
    }
    pedidos.sort((a, b) => (b.capturedAt || 0) - (a.capturedAt || 0));

    const hots = [];
    for (const k of hotKeys) {
      const data = parseVal(await redis.get(k));
      if (data) hots.push({ telefono: k.slice('hot:'.length), ...data });
    }
    hots.sort((a, b) => (b.notifiedAt || 0) - (a.notifiedAt || 0));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pedidos,
        calientes: hots,
        stats: { conversaciones: convKeys.length, pedidos: pedidos.length, calientes: hots.length }
      })
    };
  } catch (e) {
    console.error('[admin-pedidos] error:', e);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
