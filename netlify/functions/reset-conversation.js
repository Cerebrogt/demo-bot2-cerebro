// Victoria Fashion — Reiniciar una conversación (borra memoria y flags del cliente)
// Uso desde el panel: POST con header x-admin-password y body { id, platform }
// Borra: historial, flags de pedido/hot/rescate, contadores y buffers de fotos.

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
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }
  const { id, platform } = body;
  if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing id' }) };

  // chatId como lo usa el motor: whatsapp = teléfono; facebook = fb:PAGE:PSID
  const cleanId = platform === 'whatsapp' ? String(id).replace(/[^\d]/g, '') : String(id).replace(/[^\w:]/g, '');
  const chatId = platform === 'facebook' ? `fb:${cleanId}` : cleanId;

  const redis = getRedis();
  if (!redis) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Redis not configured' }) };

  try {
    const keys = [
      `conv:${chatId}`,
      `convfull:${chatId}`,
      `interes:${chatId}`,
      `fotos_pend:${chatId}`,
      `asked_datos:${chatId}`,
      `followup:${chatId}`,
      `humano:${chatId}`,
      `pedido_done:${chatId}`, `pedido_dedup:${chatId}`,
      `hot:${chatId}`, `rescue:${chatId}`, `campaign:${chatId}`,
      `asked_name:${chatId}`, `variant:${chatId}`,
      `imgbuf:${chatId}`, `imglock:${chatId}`,
      // llaves legacy de la versión anterior (sin prefijo fb:)
      `lead:${chatId}`
    ];
    let deleted = 0;
    for (const k of keys) {
      try { deleted += await redis.del(k); } catch {}
    }
    console.log(`[reset] ${chatId}: ${deleted} llaves borradas`);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, chatId, deleted }) };
  } catch (e) {
    console.error('[reset] error:', e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
