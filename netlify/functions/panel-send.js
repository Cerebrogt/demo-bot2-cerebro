// ============================================================================
// PANEL-SEND.JS — Intervención humana desde el panel
// La asesora escribe/envía media a la clienta DESDE EL NÚMERO DEL BOT, y el bot
// se pausa automáticamente (30 min renovables) para no responder en paralelo.
//
// POST con header x-admin-password. Acciones:
//  { action:'text',    id, text }                          → mensaje de texto
//  { action:'media',   id, dataB64, mime, caption }        → imagen/video adjunto (≤4MB)
//  { action:'gallery', id, url, kind, caption, filename }  → medio del sitio por URL
//  { action:'bot',     id, estado:'pausa'|'activo' }       → pausar/reactivar el bot
//  { action:'estado',  id }                                → consultar pausa
// Solo WhatsApp por ahora (Messenger cuando se conecten las páginas).
// ============================================================================

const { Redis } = require('@upstash/redis');

const GRAPH_URL = 'https://graph.facebook.com/v20.0';
const PAUSA_SEG = 30 * 60;   // 30 min desde el último mensaje humano

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try { return new Redis({ url, token }); } catch { return null; }
}

async function waSend(to, payload) {
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!phoneId || !token) throw new Error('WhatsApp credentials missing');
  const r = await fetch(`${GRAPH_URL}/${phoneId}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, ...payload })
  });
  if (!r.ok) { const t = await r.text(); throw new Error(`WA ${r.status}: ${t.slice(0, 180)}`); }
  return r.json();
}

async function waUpload(b64, mime) {
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const buf = Buffer.from(b64, 'base64');
  const fd = new FormData();
  fd.append('messaging_product', 'whatsapp');
  const ext = (mime || '').includes('video') ? 'mp4' : 'jpg';
  fd.append('file', new Blob([buf], { type: mime || 'image/jpeg' }), `asesora.${ext}`);
  const r = await fetch(`${GRAPH_URL}/${phoneId}/media`, {
    method: 'POST', headers: { 'Authorization': `Bearer ${token}` }, body: fd
  });
  if (!r.ok) { const t = await r.text(); throw new Error(`upload ${r.status}: ${t.slice(0, 150)}`); }
  const j = await r.json();
  return j.id;
}

async function appendHistory(redis, chatId, content) {
  if (!redis) return;
  try {
    let h = await redis.get(`conv:${chatId}`);
    if (typeof h === 'string') { try { h = JSON.parse(h); } catch { h = []; } }
    if (!Array.isArray(h)) h = [];
    h.push({ role: 'assistant', content, ts: Date.now() });
    await redis.set(`conv:${chatId}`, JSON.stringify(h.slice(-40)), { ex: 60 * 60 * 24 * 30 });
    // histórico completo para el export (el bot no lo lee)
    try {
      let full = await redis.get(`convfull:${chatId}`);
      if (typeof full === 'string') { try { full = JSON.parse(full); } catch { full = []; } }
      if (!Array.isArray(full)) full = [];
      const firma = (m) => `${m.ts || 0}|${m.role}|${String(m.content || '').slice(0, 60)}`;
      const vistos = new Set(full.map(firma));
      for (const m of h) { if (!vistos.has(firma(m))) { full.push(m); vistos.add(firma(m)); } }
      full.sort((a, b) => (a.ts || 0) - (b.ts || 0));
      await redis.set(`convfull:${chatId}`, JSON.stringify(full.slice(-600)), { ex: 60 * 60 * 24 * 30 });
    } catch {}
  } catch (e) { console.error('[panel-send] history error:', e.message); }
}

async function pausarBot(redis, chatId) {
  if (!redis) return;
  try { await redis.set(`humano:${chatId}`, '1', { ex: PAUSA_SEG }); }
  catch (e) { console.error('[panel-send] pausa error:', e.message); }
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

  const platform = (body.platform || 'whatsapp').toLowerCase();
  if (platform !== 'whatsapp') return { statusCode: 400, headers, body: JSON.stringify({ error: 'Por ahora la intervención es solo para WhatsApp (Messenger cuando se conecten las páginas)' }) };

  const chatId = String(body.id || '').replace(/[^\d]/g, '');
  if (!chatId || chatId.length < 8) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid id' }) };

  const redis = getRedis();

  try {
    // --- Pausar / reactivar bot ---
    if (body.action === 'bot') {
      if (!redis) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Redis unavailable' }) };
      if (body.estado === 'activo') { await redis.del(`humano:${chatId}`); return { statusCode: 200, headers, body: JSON.stringify({ ok: true, pausado: false }) }; }
      await pausarBot(redis, chatId);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, pausado: true }) };
    }

    // --- Consultar estado ---
    if (body.action === 'estado') {
      const p = redis ? await redis.get(`humano:${chatId}`) : null;
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, pausado: !!p }) };
    }

    // --- Texto ---
    if (body.action === 'text') {
      const text = String(body.text || '').trim();
      if (!text) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Texto vacío' }) };
      if (text.length > 3500) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Texto demasiado largo' }) };
      await waSend(chatId, { type: 'text', text: { preview_url: true, body: text } });
      await appendHistory(redis, chatId, `(👩 Asesora) ${text}`);
      await pausarBot(redis, chatId);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    // --- Media adjunta (imagen o video corto) ---
    if (body.action === 'media') {
      const mime = String(body.mime || '');
      const esVideo = mime.startsWith('video/');
      const esImagen = mime.startsWith('image/');
      if (!esVideo && !esImagen) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Solo imágenes o video mp4' }) };
      const b64 = String(body.dataB64 || '');
      const bytes = Math.floor(b64.length * 3 / 4);
      if (!b64 || bytes < 100) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Archivo vacío' }) };
      if (bytes > 4 * 1024 * 1024) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Máximo 4 MB por esta vía — para videos grandes usa la galería del sitio' }) };
      const mid = await waUpload(b64, mime);
      const caption = String(body.caption || '').slice(0, 500) || undefined;
      if (esVideo) await waSend(chatId, { type: 'video', video: { id: mid, caption } });
      else await waSend(chatId, { type: 'image', image: { id: mid, caption } });
      await appendHistory(redis, chatId, `(👩 Asesora envió ${esVideo ? 'un video' : 'una imagen'}${caption ? ': ' + caption : ''})`);
      await pausarBot(redis, chatId);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    // --- Galería del sitio (por URL: imagen, video o documento) ---
    if (body.action === 'gallery') {
      const url = String(body.url || '');
      const siteBase = (process.env.URL || '').replace(/\/$/, '');
      if (!siteBase || !url.startsWith(siteBase + '/') || !/^[\w\-.:/]+$/.test(url) || url.includes('..')) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Solo medios alojados en el sitio' }) };
      }
      const kind = String(body.kind || 'image');
      const caption = String(body.caption || '').slice(0, 500) || undefined;
      if (kind === 'video') await waSend(chatId, { type: 'video', video: { link: url, caption } });
      else if (kind === 'document') await waSend(chatId, { type: 'document', document: { link: url, filename: String(body.filename || 'Catalogo.pdf'), caption } });
      else await waSend(chatId, { type: 'image', image: { link: url, caption } });
      await appendHistory(redis, chatId, `(👩 Asesora envió ${kind === 'video' ? 'un video' : kind === 'document' ? 'un catálogo' : 'una imagen'} del sitio) [${kind === 'image' ? 'IMGS' : 'PDF'}:${url}]`);
      await pausarBot(redis, chatId);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };
  } catch (e) {
    console.error('[panel-send] error:', e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
