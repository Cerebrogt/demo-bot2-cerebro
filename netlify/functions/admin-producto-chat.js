// CUCO Store — Asistente de configuración de producto (para el panel admin)
// El administrador conversa; el asistente hace UNA pregunta a la vez hasta completar
// la ficha del producto y al confirmarse la guarda en Redis (producto:activo).
// POST {messages:[{role,content},...]} · Auth: header x-admin-password
const { Redis } = require('@upstash/redis');

const PRODUCT_KEY = 'producto:activo';

const SYSTEM = `Sos el asistente de configuración de CUCO Store (Guatemala). Ayudás al administrador a definir el producto que venderá el bot de WhatsApp. Hablás en español guatemalteco, amable y directo.

Tu trabajo: completar la ficha del producto haciendo UNA pregunta a la vez. Los campos son:

1. nombre — nombre del producto (ej. "Mesa portátil ajustable")
2. precio — precio en quetzales, solo el número (ej. 199)
3. envio — costo de envío en quetzales, solo el número (ej. 30)
4. pago — forma de pago (ej. "contra entrega")
5. variantes — colores/tallas/modelos disponibles, como lista (ej. ["rosado","beige","blanco","negro"]). Si no tiene, lista vacía.
6. descripcion — material, medidas y características (texto corto)
7. usos — para qué sirve / usos ideales (texto corto, opcional)
8. faq — respuestas a preguntas frecuentes que el bot puede afirmar (texto corto, opcional)

Reglas:
- Si el administrador pega toda la info de una vez, extraé lo que puedas y preguntá SOLO lo que falte.
- No inventes datos. Si un campo opcional no aplica, dejalo vacío.
- Cuando tengas los campos 1-6, mostrá un RESUMEN claro de la ficha y preguntá: "¿Lo guardo así?"
- SOLO cuando el administrador confirme (sí/dale/guardalo), tu respuesta debe incluir al FINAL el bloque:
[PRODUCTO_JSON]{"nombre":"...","precio":199,"envio":30,"pago":"...","variantes":["..."],"descripcion":"...","usos":"...","faq":"..."}[/PRODUCTO_JSON]
- El JSON debe ser válido, en una sola línea. No incluyas el bloque antes de la confirmación.
- Después de guardar, recordale: "Listo, guardado ✅ Ahora subí las fotos del producto con el botón 'Subir imagen' — el bot las manda cuando el cliente pida fotos."
- Las fotos NO se manejan en este chat (se suben con el botón del panel). Si pregunta por fotos, indicale el botón.`;

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
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  let body;
  try { body = JSON.parse(event.body); } catch { return { statusCode: 400, body: 'Invalid JSON' }; }
  const messages = Array.isArray(body.messages) ? body.messages.slice(-30) : [];
  if (messages.length === 0) return { statusCode: 400, body: JSON.stringify({ error: 'messages requerido' }) };

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1200,
        temperature: 0.2,
        system: SYSTEM,
        messages: messages.map(m => ({ role: m.role, content: m.content }))
      })
    });
    if (!response.ok) {
      const t = await response.text();
      throw new Error('Claude API error: ' + response.status + ' ' + t.slice(0, 200));
    }
    const data = await response.json();
    const raw = (data?.content?.[0]?.text) || '';

    // ¿Confirmó y hay JSON para guardar?
    let saved = false;
    let producto = null;
    const m = raw.match(/\[PRODUCTO_JSON\](.*?)\[\/PRODUCTO_JSON\]/s);
    if (m) {
      try {
        const parsed = JSON.parse(m[1].trim());
        const redis = getRedis();
        if (redis) {
          const existing = parseVal(await redis.get(PRODUCT_KEY)) || {};
          producto = { ...parsed, fotos: existing.fotos || [], updatedAt: Date.now() };
          await redis.set(PRODUCT_KEY, JSON.stringify(producto));
          saved = true;
        }
      } catch (e) {
        console.error('[admin-producto-chat] JSON inválido del modelo:', e.message);
      }
    }

    const reply = raw.replace(/\[PRODUCTO_JSON\].*?\[\/PRODUCTO_JSON\]\s*/s, '').trim();
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reply, saved, producto })
    };
  } catch (e) {
    console.error('[admin-producto-chat] error:', e);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
