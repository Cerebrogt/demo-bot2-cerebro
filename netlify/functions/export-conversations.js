// Bot Demo — Export todas las conversaciones de Redis a JSON
//
// Esta función exporta TODAS las conversaciones (WhatsApp, Facebook, Instagram)
// guardadas en Upstash Redis a un archivo JSON descargable.
//
// Uso: visitar la URL con header x-admin-password (o usar curl):
//   curl -H "x-admin-password: TU_PASSWORD" https://TU-SITIO.netlify.app/.netlify/functions/export-conversations > conversaciones.json
//
// Auth: requiere header "x-admin-password" que coincida con ADMIN_PASSWORD
//
// NOTA: Función temporal para análisis. Después se puede borrar.

const { Redis } = require('@upstash/redis');

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

function parseKey(key) {
  const withoutConv = key.replace(/^conv:/, '');
  if (withoutConv.startsWith('fb:')) {
    return { platform: 'facebook', id: withoutConv.replace(/^fb:/, '') };
  }
  if (withoutConv.startsWith('ig:')) {
    return { platform: 'instagram', id: withoutConv.replace(/^ig:/, '') };
  }
  return { platform: 'whatsapp', id: withoutConv };
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-password',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // Auth
  const provided = event.headers['x-admin-password'] || event.headers['X-Admin-Password'] ||
                   event.queryStringParameters?.password;
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'ADMIN_PASSWORD env var not set' }) };
  }
  if (!provided || provided !== expected) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized — pasá ?password=XXX o header x-admin-password' }) };
  }

  const redis = getRedis();
  if (!redis) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Redis not configured' }) };
  }

  try {
    // 1) Obtener todas las keys de conversaciones
    const keys = await redis.keys('conv:*');
    if (!keys || keys.length === 0) {
      return {
        statusCode: 200,
        headers: { ...headers, 'Content-Disposition': 'attachment; filename="conversaciones.json"' },
        body: JSON.stringify({ total: 0, exportedAt: new Date().toISOString(), conversations: [] }, null, 2)
      };
    }

    // 2) Leer todas las conversaciones (batch) — y su histórico COMPLETO si existe
    const values = await redis.mget(...keys);
    const fullKeys = keys.map(k => 'convfull:' + k.replace(/^conv:/, ''));
    let fullValues = [];
    try { fullValues = await redis.mget(...fullKeys); } catch { fullValues = []; }

    // 3) Obtener flags de lead capturados (para marcar cuáles convirtieron)
    const leadKeys = await redis.keys('lead:*');
    const leadIds = new Set();
    if (leadKeys && leadKeys.length > 0) {
      leadKeys.forEach(k => {
        const phone = k.replace(/^lead:/, '');
        leadIds.add(phone);
      });
    }

    // 4) Obtener flags de follow-ups enviados
    const followupKeys = await redis.keys('followup:*');
    const followupIds = new Set();
    if (followupKeys && followupKeys.length > 0) {
      followupKeys.forEach(k => {
        const phone = k.replace(/^followup:/, '');
        followupIds.add(phone);
      });
    }

    // 5) Estructurar conversaciones
    const conversations = keys.map((key, i) => {
      const { platform, id } = parseKey(key);
      let history = values[i];
      if (typeof history === 'string') {
        try { history = JSON.parse(history); } catch { history = null; }
      }
      // preferir el histórico completo (sin recorte de 40) cuando exista y sea más largo
      let full = fullValues[i];
      if (typeof full === 'string') { try { full = JSON.parse(full); } catch { full = null; } }
      if (Array.isArray(full) && Array.isArray(history) && full.length > history.length) history = full;
      else if (Array.isArray(full) && !Array.isArray(history)) history = full;
      if (!Array.isArray(history)) return null;

      // Identificar si convirtió (capturó lead) y si recibió follow-up
      const captured = platform === 'whatsapp' && leadIds.has(id);
      const receivedFollowup = platform === 'whatsapp' && followupIds.has(id);

      // Calcular métricas básicas
      const userMessages = history.filter(m => m.role === 'user').length;
      const botMessages = history.filter(m => m.role === 'assistant').length;
      const firstTs = history[0]?.ts || null;
      const lastTs = history[history.length - 1]?.ts || null;
      const lastRole = history[history.length - 1]?.role || null;

      return {
        platform,
        id,
        captured, // true si convirtió en lead
        receivedFollowup,
        messageCount: history.length,
        userMessages,
        botMessages,
        firstMessageAt: firstTs ? new Date(firstTs).toISOString() : null,
        lastMessageAt: lastTs ? new Date(lastTs).toISOString() : null,
        lastRole,
        messages: history.map(m => ({
          role: m.role,
          content: m.content,
          ts: m.ts ? new Date(m.ts).toISOString() : null,
          isFollowup: m.followup === true || undefined
        }))
      };
    }).filter(c => c !== null);

    // 6) Stats agregadas
    const stats = {
      total: conversations.length,
      byPlatform: {
        whatsapp: conversations.filter(c => c.platform === 'whatsapp').length,
        facebook: conversations.filter(c => c.platform === 'facebook').length,
        instagram: conversations.filter(c => c.platform === 'instagram').length
      },
      convertedToLead: conversations.filter(c => c.captured).length,
      receivedFollowup: conversations.filter(c => c.receivedFollowup).length,
      avgMessagesPerConversation: Math.round(
        conversations.reduce((sum, c) => sum + c.messageCount, 0) / conversations.length
      ),
      withTimestamp: conversations.filter(c => c.lastMessageAt).length,
      withoutTimestamp: conversations.filter(c => !c.lastMessageAt).length
    };

    return {
      statusCode: 200,
      headers: {
        ...headers,
        'Content-Disposition': 'attachment; filename="conversaciones-bot.json"'
      },
      body: JSON.stringify({
        exportedAt: new Date().toISOString(),
        stats,
        conversations
      }, null, 2)
    };
  } catch (e) {
    console.error('Export error:', e);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: e.message })
    };
  }
};
