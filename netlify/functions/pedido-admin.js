// ============================================================================
// PEDIDO-ADMIN.JS — Acciones administrativas del panel
// POST con header x-admin-password. Acciones:
//  { action: 'delete',       key }                → borra un pedido (pruebas/duplicados)
//  { action: 'estado',       key, estado }       → marca despachado / pendiente
//  { action: 'hot-atendido', id }                → alterna "atendido" en un lead caliente
// ============================================================================

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
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const provided = event.headers['x-admin-password'] || event.headers['X-Admin-Password'];
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return { statusCode: 500, headers, body: JSON.stringify({ error: 'ADMIN_PASSWORD not set' }) };
  if (!provided || provided !== expected) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };

  let body;
  try { body = JSON.parse(event.body); } catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const redis = getRedis();
  if (!redis) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Redis not configured' }) };

  try {
    // --- Borrar pedido (para pruebas o duplicados) ---
    if (body.action === 'delete') {
      const key = String(body.key || '');
      if (!/^pedido:\d+:[\w:+.\-]+$/.test(key)) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid key' }) };
      await redis.del(key);
      await redis.del(`pestado:${key}`);
      console.log(`[pedido-admin] borrado: ${key}`);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    // --- Estado del pedido (despachado / pendiente) ---
    if (body.action === 'estado') {
      const key = String(body.key || '');
      const estado = String(body.estado || '');
      if (!/^pedido:\d+:[\w:+.\-]+$/.test(key)) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid key' }) };
      if (!['despachado', 'pendiente'].includes(estado)) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid estado' }) };
      if (estado === 'pendiente') await redis.del(`pestado:${key}`);
      else await redis.set(`pestado:${key}`, estado, { ex: 60 * 60 * 24 * 90 });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, estado }) };
    }

    // --- Lead caliente atendido (alterna) ---
    if (body.action === 'hot-atendido') {
      const id = String(body.id || '').replace(/[^\w:+.\-]/g, '');
      if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid id' }) };
      const cur = await redis.get(`hotdone:${id}`);
      if (cur) { await redis.del(`hotdone:${id}`); return { statusCode: 200, headers, body: JSON.stringify({ ok: true, atendido: false }) }; }
      await redis.set(`hotdone:${id}`, '1', { ex: 60 * 60 * 24 * 7 });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, atendido: true }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };
  } catch (e) {
    console.error('[pedido-admin] error:', e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
