// CUCO Store — API admin: conversaciones del bot
// GET                → lista resumida (teléfono, mensajes, último mensaje, flags)
// GET ?tel=502...    → historial completo de una conversación
// GET ?export=1      → descarga TODAS las conversaciones como JSON
// Auth: header x-admin-password === ADMIN_PASSWORD
const { Redis } = require('@upstash/redis');

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try { return new Redis({ url, token }); } catch { return null; }
}

function parseHistory(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return []; } }
  return [];
}

exports.handler = async (event) => {
  const pass = event.headers['x-admin-password'] || event.headers['X-Admin-Password'];
  if (!process.env.ADMIN_PASSWORD || pass !== process.env.ADMIN_PASSWORD) {
    return { statusCode: 401, body: JSON.stringify({ error: 'unauthorized' }) };
  }
  const redis = getRedis();
  if (!redis) return { statusCode: 500, body: JSON.stringify({ error: 'redis not configured' }) };

  try {
    const q = event.queryStringParameters || {};

    // === Detalle de UNA conversación ===
    if (q.tel) {
      const history = parseHistory(await redis.get(`conv:${q.tel}`));
      const [pedido, hot, followup] = await Promise.all([
        redis.get(`pedido:${q.tel}`), redis.get(`hot:${q.tel}`), redis.get(`followup:${q.tel}`)
      ]);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telefono: q.tel, mensajes: history, flags: { pedido: !!pedido, hot: !!hot, followup: !!followup } })
      };
    }

    // Cargar todas las claves de conversación
    const keys = (await redis.keys('conv:*')) || [];
    const convs = [];
    for (const key of keys) {
      const tel = key.slice('conv:'.length);
      const history = parseHistory(await redis.get(key));
      if (history.length === 0) continue;
      const last = history[history.length - 1];
      convs.push({
        telefono: tel,
        mensajes: history.length,
        delCliente: history.filter(m => m.role === 'user').length,
        ultimoRol: last.role,
        ultimoTexto: (last.content || '').slice(0, 120),
        ultimoTs: last.ts || null,
        historial: history // se filtra abajo según el modo
      });
    }
    convs.sort((a, b) => (b.ultimoTs || 0) - (a.ultimoTs || 0));

    // === Export completo (descarga) ===
    if (q.export) {
      const [pedidoKeys, hotKeys] = await Promise.all([redis.keys('pedido:*'), redis.keys('hot:*')]);
      const pedidoSet = new Set((pedidoKeys || []).filter(k => !k.startsWith('pedido_dedup:')).map(k => k.slice('pedido:'.length)));
      const hotSet = new Set((hotKeys || []).map(k => k.slice('hot:'.length)));
      const exportData = {
        exportadoEl: new Date().toISOString(),
        sitio: process.env.URL || '',
        totalConversaciones: convs.length,
        conversaciones: convs.map(c => ({
          telefono: c.telefono,
          mensajes: c.historial,
          pedidoCerrado: pedidoSet.has(c.telefono),
          clienteCaliente: hotSet.has(c.telefono)
        }))
      };
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Content-Disposition': `attachment; filename="conversaciones-cuco-store-${new Date().toISOString().slice(0, 10)}.json"`
        },
        body: JSON.stringify(exportData, null, 2)
      };
    }

    // === Lista resumida (sin historial completo) ===
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        total: convs.length,
        conversaciones: convs.map(({ historial, ...rest }) => rest)
      })
    };
  } catch (e) {
    console.error('[admin-conversaciones] error:', e);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
