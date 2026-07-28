// Victoria Fashion — API del panel: lista de pedidos + métricas
// Auth: header "x-admin-password" = ADMIN_PASSWORD
// GET /.netlify/functions/pedidos-list

const { Redis } = require('@upstash/redis');

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try { return new Redis({ url, token }); } catch { return null; }
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-password',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const provided = event.headers['x-admin-password'] || event.headers['X-Admin-Password'];
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return { statusCode: 500, headers, body: JSON.stringify({ error: 'ADMIN_PASSWORD not set' }) };
  if (!provided || provided !== expected) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };

  const redis = getRedis();
  if (!redis) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Redis not configured' }) };

  try {
    const [pedidoKeys, convKeys, hotKeys] = await Promise.all([
      redis.keys('pedido:1*'),        // pedido:{ts}:{chatId} — ts arranca con 1
      redis.keys('conv:*'),
      redis.keys('hot:*')
    ]);

    let pedidos = [];
    if (pedidoKeys && pedidoKeys.length) {
      const values = [];
      for (let i = 0; i < pedidoKeys.length; i += 200) {
        const vals = await redis.mget(...pedidoKeys.slice(i, i + 200));
        values.push(...vals);
      }
      pedidos = pedidoKeys.map((key, i) => {
        let p = values[i];
        if (typeof p === 'string') { try { p = JSON.parse(p); } catch { p = null; } }
        if (!p) return null;
        // Nombre de tienda legible
        p.lineaNombre = p.tiendaNombre || 'The Marketplace GT';
        p.key = key;
        return p;
      }).filter(Boolean);
      // Estado de despacho (pestado:pedido:...)
      try {
        const estKeys = pedidos.map(p => `pestado:${p.key}`);
        const estVals = [];
        for (let i = 0; i < estKeys.length; i += 200) {
          const vals = await redis.mget(...estKeys.slice(i, i + 200));
          estVals.push(...vals);
        }
        pedidos.forEach((p, i) => { p.estado = estVals[i] || 'pendiente'; });
      } catch (e) { console.error('[pedidos-list] estados error:', e.message); }
      pedidos.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        stats: {
          conversaciones: (convKeys || []).length,
          pedidos: pedidos.length,
          calientes: (hotKeys || []).length
        },
        pedidos
      })
    };
  } catch (e) {
    console.error('pedidos-list error:', e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
