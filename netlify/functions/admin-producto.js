// Llantas Total — API admin: producto activo del bot
// GET  → devuelve el producto guardado en Redis (producto:activo)
// POST action=save        → guarda/actualiza el producto (JSON)
// POST action=upload      → sube una imagen (base64) a Netlify Blobs y la agrega a producto.fotos
// POST action=delete-foto → quita una foto del producto
// POST action=reset       → borra el producto activo (el bot vuelve al producto por defecto del código)
// Auth: header x-admin-password === ADMIN_PASSWORD
const { Redis } = require('@upstash/redis');
const { getStore } = require('@netlify/blobs');

const PRODUCT_KEY = 'producto:activo';

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
    if (event.httpMethod === 'GET') {
      const producto = parseVal(await redis.get(PRODUCT_KEY));
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ producto }) };
    }

    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

    let body;
    try { body = JSON.parse(event.body); } catch { return { statusCode: 400, body: 'Invalid JSON' }; }
    const action = body.action;

    if (action === 'save') {
      const existing = parseVal(await redis.get(PRODUCT_KEY)) || {};
      const producto = { ...existing, ...body.producto, fotos: body.producto?.fotos || existing.fotos || [], updatedAt: Date.now() };
      await redis.set(PRODUCT_KEY, JSON.stringify(producto));
      return { statusCode: 200, body: JSON.stringify({ ok: true, producto }) };
    }

    if (action === 'upload') {
      const { filename, dataBase64, contentType } = body;
      if (!filename || !dataBase64) return { statusCode: 400, body: JSON.stringify({ error: 'filename y dataBase64 requeridos' }) };
      const safe = filename.toLowerCase().replace(/[^a-z0-9.]+/g, '-').slice(-60);
      const key = `${Date.now()}-${safe}`;
      const store = getStore('producto-fotos');
      const buffer = Buffer.from(dataBase64, 'base64');
      if (buffer.length > 4.5 * 1024 * 1024) return { statusCode: 400, body: JSON.stringify({ error: 'Imagen muy grande (máx ~4.5MB)' }) };
      await store.set(key, buffer, { metadata: { contentType: contentType || 'image/jpeg' } });

      const url = `/.netlify/functions/producto-img?key=${encodeURIComponent(key)}`;
      const existing = parseVal(await redis.get(PRODUCT_KEY)) || { fotos: [] };
      existing.fotos = existing.fotos || [];
      existing.fotos.push(url);
      existing.updatedAt = Date.now();
      await redis.set(PRODUCT_KEY, JSON.stringify(existing));
      return { statusCode: 200, body: JSON.stringify({ ok: true, url, producto: existing }) };
    }

    if (action === 'delete-foto') {
      const existing = parseVal(await redis.get(PRODUCT_KEY));
      if (existing && Array.isArray(existing.fotos)) {
        existing.fotos = existing.fotos.filter(f => f !== body.url);
        existing.updatedAt = Date.now();
        await redis.set(PRODUCT_KEY, JSON.stringify(existing));
      }
      return { statusCode: 200, body: JSON.stringify({ ok: true, producto: existing }) };
    }

    if (action === 'reset') {
      await redis.del(PRODUCT_KEY);
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'acción desconocida' }) };
  } catch (e) {
    console.error('[admin-producto] error:', e);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
