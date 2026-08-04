// MIGRACIÓN DE UN SOLO USO — copia los pedidos viejos (pedido:{tel}) al formato
// del Panel v2 (pedido:{ts}:{tel}) para que aparezcan en la pestaña Pedidos.
// Uso (una vez): https://SITIO/.netlify/functions/migrar-pedidos?clave=ADMIN_PASSWORD
// Es idempotente: correrla dos veces no duplica nada (misma llave destino).
// Después de usarla se puede borrar este archivo del proyecto.

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
  const headers = { 'Content-Type': 'application/json' };
  const clave = event.queryStringParameters?.clave ||
    event.headers['x-admin-password'] || event.headers['X-Admin-Password'];
  if (!process.env.ADMIN_PASSWORD || clave !== process.env.ADMIN_PASSWORD) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'unauthorized' }) };
  }
  const redis = getRedis();
  if (!redis) return { statusCode: 500, headers, body: JSON.stringify({ error: 'redis not configured' }) };

  try {
    const allKeys = await redis.keys('pedido:*');
    // Solo las llaves viejas pedido:{tel} — excluye pedido_dedup:* y pedido:{ts}:{tel}
    const oldKeys = allKeys.filter(k => /^pedido:\d{8,15}$/.test(k) && !k.startsWith('pedido:1'));
    let migrados = 0, saltados = 0;
    for (const k of oldKeys) {
      const data = parseVal(await redis.get(k));
      if (!data) { saltados++; continue; }
      const tel = k.slice('pedido:'.length);
      const ts = data.capturedAt || Date.now();
      await redis.set(`pedido:${ts}:${tel}`, JSON.stringify({
        productos: data.producto || data.productos || '',
        nombre: data.nombre || '',
        telefono: data.telefono || `+${tel}`,
        direccion: data.direccion || '',
        pago: 'contra entrega (+Q30 envío)',
        canal: 'whatsapp',
        linea: 'jm',
        tiendaNombre: 'CUCO Store',
        ts
      }), { ex: 60 * 60 * 24 * 90 });
      migrados++;
    }
    return {
      statusCode: 200, headers,
      body: JSON.stringify({ ok: true, migrados, saltados, revisadas: oldKeys.length })
    };
  } catch (e) {
    console.error('[migrar-pedidos] error:', e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
