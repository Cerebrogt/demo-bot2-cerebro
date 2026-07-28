// ============================================================================
// CHAT-FOTOS.JS — Fotos de las clientas en el panel (Netlify Blobs)
// Las fotos que las clientas envían por WhatsApp/Messenger se guardan de forma
// permanente en Netlify Blobs (store "fotos-clientas") desde los webhooks.
//
// GET ?id=CHAT&platform=whatsapp|facebook  → lista de fotos [{k, ts}]
// GET ?key=BLOB_KEY                        → la imagen (binario)
// Auth: header x-admin-password (igual que el resto del panel)
// ============================================================================

const { Redis } = require('@upstash/redis');
const { getStore } = require('@netlify/blobs');

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
    'Access-Control-Allow-Methods': 'GET, OPTIONS'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers, body: 'Method not allowed' };

  const provided = event.headers['x-admin-password'] || event.headers['X-Admin-Password'];
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return { statusCode: 500, headers, body: JSON.stringify({ error: 'ADMIN_PASSWORD env var not set' }) };
  if (!provided || provided !== expected) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };

  const q = event.queryStringParameters || {};

  // --- Servir una imagen por su media id de WhatsApp (desde Meta, ~30 días) ---
  if (q.mid) {
    const mid = String(q.mid);
    if (!/^\d{5,25}$/.test(mid)) return { statusCode: 400, headers, body: 'Invalid mid' };
    try {
      const token = process.env.WHATSAPP_ACCESS_TOKEN;
      if (!token) return { statusCode: 500, headers, body: 'No WhatsApp token' };
      const GRAPH = 'https://graph.facebook.com/v20.0';
      const metaR = await fetch(`${GRAPH}/${mid}`, { headers: { 'Authorization': `Bearer ${token}` } });
      if (!metaR.ok) return { statusCode: 404, headers, body: 'Media expired or not found' };
      const meta = await metaR.json();
      if (!meta.url) return { statusCode: 404, headers, body: 'No media url' };
      const imgR = await fetch(meta.url, { headers: { 'Authorization': `Bearer ${token}` } });
      if (!imgR.ok) return { statusCode: 404, headers, body: 'Media download failed' };
      const buf = Buffer.from(await imgR.arrayBuffer());
      return {
        statusCode: 200,
        headers: { ...headers, 'Content-Type': meta.mime_type || 'image/jpeg', 'Cache-Control': 'private, max-age=86400' },
        body: buf.toString('base64'),
        isBase64Encoded: true
      };
    } catch (e) {
      console.error('[chat-fotos] mid error:', e.message);
      return { statusCode: 500, headers, body: 'Media fetch failed' };
    }
  }

  // --- Servir una imagen por su key ---
  if (q.key) {
    const key = String(q.key);
    if (key.includes('..') || !/^(wa|fb)\/[\w:.\-]+\/[\w.\-]+$/.test(key)) return { statusCode: 400, headers, body: 'Invalid key' };
    try {
      const store = getStore(process.env.NETLIFY_BLOBS_TOKEN
        ? { name: 'fotos-clientas', siteID: process.env.NETLIFY_SITE_ID || '79f5f797-c958-4259-b92b-10369ec3202d', token: process.env.NETLIFY_BLOBS_TOKEN }
        : 'fotos-clientas');
      const result = await Promise.race([
        store.getWithMetadata(key, { type: 'arrayBuffer' }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('blob read timeout')), 4000))
      ]);
      if (!result || !result.data) return { statusCode: 404, headers, body: 'Not found' };
      return {
        statusCode: 200,
        headers: {
          ...headers,
          'Content-Type': (result.metadata && result.metadata.mime) || 'image/jpeg',
          'Cache-Control': 'private, max-age=86400'
        },
        body: Buffer.from(result.data).toString('base64'),
        isBase64Encoded: true
      };
    } catch (e) {
      console.error('[chat-fotos] blob get error:', e.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Blob read failed' }) };
    }
  }

  // --- Listar fotos de un chat ---
  const userId = q.id;
  const platform = (q.platform || 'whatsapp').toLowerCase();
  if (!userId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing id or key param' }) };

  let cleanId;
  if (platform === 'whatsapp') cleanId = userId.replace(/[^\d]/g, '');
  else cleanId = 'fb:' + userId.replace(/^fb:/, '').replace(/[^\w:]/g, '');
  if (!cleanId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid id' }) };

  const redis = getRedis();
  if (!redis) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Redis unavailable' }) };

  try {
    const raw = await redis.lrange(`fotoschat:${cleanId}`, 0, -1) || [];
    const fotos = raw.map(x => { try { return typeof x === 'string' ? JSON.parse(x) : x; } catch { return null; } }).filter(Boolean);
    return { statusCode: 200, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ fotos }) };
  } catch (e) {
    console.error('[chat-fotos] list error:', e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'List failed' }) };
  }
};
