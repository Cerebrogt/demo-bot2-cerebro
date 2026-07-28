// AI Inbox (Demo) — Conversation Detail Function
// Devuelve el historial completo de una conversación específica
//
// Auth: requiere header "x-admin-password"
// Query: ?id=USER_PHONE_NUMBER

const { Redis } = require('@upstash/redis');

// Prefijos: conv:fb:ID (FB), conv:ig:ID (IG), conv:NUMBER (WA legacy)

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    return new Redis({ url, token });
  } catch (e) {
    console.error('Could not init Upstash Redis:', e.message);
    return null;
  }
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-password',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const provided = event.headers['x-admin-password'] || event.headers['X-Admin-Password'];
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'ADMIN_PASSWORD env var not set' }) };
  }
  if (!provided || provided !== expected) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const userId = event.queryStringParameters?.id;
  const platform = (event.queryStringParameters?.platform || 'whatsapp').toLowerCase();
  if (!userId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing id param' }) };
  }

  // Sanitizar el ID según plataforma
  let cleanId;
  if (platform === 'whatsapp') {
    cleanId = userId.replace(/[^\d]/g, '');
  } else {
    // FB/IG: alfanumérico, y en multi-página el ID es "PAGEID:PSID" (con dos puntos)
    cleanId = userId.replace(/[^\w:]/g, '');
  }
  if (!cleanId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid id' }) };
  }

  // Construir la key según plataforma
  let redisKey;
  if (platform === 'facebook') redisKey = 'conv:fb:' + cleanId;
  else if (platform === 'instagram') redisKey = 'conv:ig:' + cleanId;
  else redisKey = 'conv:' + cleanId;

  const redis = getRedis();
  if (!redis) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Redis not configured' }) };
  }

  try {
    let history = await redis.get(redisKey);
    if (typeof history === 'string') {
      try { history = JSON.parse(history); } catch { history = null; }
    }
    // Preferir el histórico COMPLETO (convfull:) — sin el recorte de 40 mensajes
    try {
      let full = await redis.get(redisKey.replace(/^conv:/, 'convfull:'));
      if (typeof full === 'string') { try { full = JSON.parse(full); } catch { full = null; } }
      if (Array.isArray(full) && (!Array.isArray(history) || full.length > history.length)) history = full;
    } catch {}
    if (!history || !Array.isArray(history)) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Conversation not found' }) };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        id: cleanId,
        platform: platform,
        phone: platform === 'whatsapp' ? cleanId : null,
        messageCount: history.length,
        messages: history
      })
    };
  } catch (e) {
    console.error('Inbox-conversation error:', e);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: e.message })
    };
  }
};
