// CUCO Store — Order Follow-up: recupera clientes que dejaron el pedido a medias
//
// Corre cada 15 minutos vía Netlify Scheduled Functions (ver netlify.toml).
// Solo opera 8am-8pm hora Guatemala (no molestar de noche).
//
// Lógica (adaptada del lead-rescue de Cerebro, pero acá el mensaje va AL CLIENTE):
//  1. Último mensaje fue del BOT (el cliente dejó de responder)
//  2. Silencio de entre 30 min y 4 horas (fresco + dentro de la ventana 24h)
//  3. El cliente escribió al menos 2 mensajes (interés real, no un preset abandonado)
//  4. Sin keywords negativas ("no me interesa", "ya no", etc.)
//  5. Sin pedido cerrado (flag pedido:), sin HOT notificado (flag hot:)
//  6. Sin follow-up previo (flag followup:) — SE ENVÍA UNA SOLA VEZ por cliente
//
// Si pasa los filtros: manda UN recordatorio suave, personalizado con el color
// que mencionó si lo hay, y marca followup:{phone} TTL 7 días.
//
// Lección del bot Cerebro: el follow-up genérico de agencia tuvo 0% retorno y se apagó.
// Acá es distinto (producto Q229 contra entrega = carrito abandonado), pero igual:
// UN solo intento, suave, y monitorear la tasa de respuesta. Si a las 2 semanas
// nadie responde, apagarlo (comentar el schedule en netlify.toml).

const { Redis } = require('@upstash/redis');

const REDIS_PREFIX = 'conv:';
const GRAPH_URL = 'https://graph.facebook.com/v20.0';

const HOUR_START = 8;    // 8am GT
const HOUR_END = 22.5;   // 10:30pm GT — el pico de tráfico es 7-10pm (análisis 27-jul)

const MIN_HOURS = 0.5;  // 30 minutos de silencio mínimo
const MAX_HOURS = 4;    // máximo 4h — después el interés ya se enfrió
const MIN_USER_MESSAGES = 2;  // …o 1 solo mensaje SI el producto está identificado (ver filtro 3)

const NEGATIVE_KEYWORDS = [
  'no me interesa', 'no gracias', 'ya no', 'muy cara', 'muy caro', 'está cara',
  'no tengo dinero', 'no por ahora', 'después te aviso', 'otra ocasión', 'en otro momento',
  'me equivoqué', 'fue por error', 'dejen de escribir', 'no molesten'
];

// Detección de producto (espejo EXACTO del webhook — solo se usa como respaldo
// si no existe el flag interes:{tel}, y SOLO sobre mensajes del CLIENTE, nunca
// del bot: el saludo del bot lista el catálogo completo y contaminaba la detección).
const PRODUCT_NAMES = {
  'soldadora': 'la máquina soldadora industrial',
  'lavadora': 'la lavadora mediana',
  'hidroaspiradora': 'la hidroaspiradora portátil'
};
// Info de cierre por producto (precio + pregunta concreta, no genérica)
const FOLLOWUP_INFO = {
  'soldadora':       { linea: 'Q855, pagas al recibir', cierre: '¿Te la aparto?' },
  'lavadora':        { linea: 'Q900 en liquidación, pagas al recibir', cierre: '¿Te la aparto?' },
  'hidroaspiradora': { linea: 'Q675 en oferta (antes Q1,200), pagas al recibir', cierre: '¿Te la aparto al precio de oferta?' }
};
// Precios → producto (mantener en sync con el catálogo del webhook)
const PRICE_MAP = { '855': 'soldadora', '900': 'lavadora', '675': 'hidroaspiradora', '1200': 'hidroaspiradora' };
function detectProduct(t) {
  t = (t || '').toLowerCase();
  const precio = t.match(/q\s*\.?\s*([\d,]{2,5})/);
  if (precio) {
    const v = PRICE_MAP[String(parseInt(precio[1].replace(/,/g, ''), 10))];
    if (v) return v;
  }
  if (/soldador|soldar|soldadura|\bmig\b|\btig\b|\barc\b|careta|herrer[ií]a/.test(t)) return 'soldadora';
  if (/lavadora|lava\s*y\s*exprime|lavar\s+ropa|chamarra/.test(t)) return 'lavadora';
  if (/hidro\s*aspiradora|hidroaspiradora|aspiradora|tapicer[ií]a|alfombras?|colchon(es)?|sillones?/.test(t)) return 'hidroaspiradora';
  return null;
}

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    return new Redis({ url, token });
  } catch (e) {
    console.error('[followup] Could not init Redis:', e.message);
    return null;
  }
}

function guatemalaHour() {
  const d = new Date();
  let gtHour = d.getUTCHours() - 6 + d.getUTCMinutes() / 60;
  if (gtHour < 0) gtHour += 24;
  return gtHour;
}

function buildFollowupMessage(productKey) {
  if (productKey && FOLLOWUP_INFO[productKey]) {
    const info = FOLLOWUP_INFO[productKey];
    return `Hola de nuevo 💜 Quedé pendiente con ${PRODUCT_NAMES[productKey]}: sigue disponible en ${info.linea} — cero riesgo. ${info.cierre}`;
  }
  return `Hola de nuevo 💜 ¿Sigues interesado? Pagas al recibir tu producto — cero riesgo. ¿Te lo aparto?`;
}

async function sendWhatsAppMessage(to, text) {
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!phoneId || !token) throw new Error('WhatsApp credentials missing');

  const response = await fetch(`${GRAPH_URL}/${phoneId}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: to,
      type: 'text',
      text: { preview_url: false, body: text }
    })
  });
  if (!response.ok) {
    const t = await response.text();
    console.error('[followup] WhatsApp send error:', response.status, t.slice(0, 300));
    throw new Error('WhatsApp send failed: ' + response.status);
  }
  return response.json();
}

exports.handler = async () => {
  console.log('[followup] Función invocada');

  const hour = guatemalaHour();
  if (hour < HOUR_START || hour >= HOUR_END) {
    console.log(`[followup] Fuera de horario (GT: ${hour}h). Saliendo.`);
    return { statusCode: 200, body: JSON.stringify({ skipped: true, reason: 'out_of_hours', hour }) };
  }

  const redis = getRedis();
  if (!redis) {
    console.error('[followup] Redis no configurado');
    return { statusCode: 500, body: JSON.stringify({ error: 'Redis not configured' }) };
  }

  try {
    const allKeys = await redis.keys(`${REDIS_PREFIX}*`);
    if (!allKeys || allKeys.length === 0) {
      return { statusCode: 200, body: JSON.stringify({ processed: 0 }) };
    }

    const now = Date.now();
    const results = {
      processed: 0, sent: 0,
      skippedLastNotBot: 0, skippedNoTs: 0, skippedOutOfWindow: 0,
      skippedTooFewMsgs: 0, skippedNegative: 0, skippedOrderClosed: 0,
      skippedHot: 0, skippedAlreadySent: 0, errors: 0,
      details: []
    };

    for (const key of allKeys) {
      results.processed++;
      const phone = key.replace(/^conv:/, '');

      try {
        let history = await redis.get(key);
        if (typeof history === 'string') {
          try { history = JSON.parse(history); } catch { history = null; }
        }
        if (!Array.isArray(history) || history.length === 0) continue;

        const lastMsg = history[history.length - 1];

        // 1) Último mensaje del bot (el cliente dejó de responder)
        if (lastMsg.role !== 'assistant') { results.skippedLastNotBot++; continue; }
        if (!lastMsg.ts) { results.skippedNoTs++; continue; }

        // 2) Ventana 30 min – 4 h
        const hoursAgo = (now - lastMsg.ts) / (1000 * 60 * 60);
        if (hoursAgo < MIN_HOURS || hoursAgo > MAX_HOURS) { results.skippedOutOfWindow++; continue; }

        // 3) Interés real: al menos 2 mensajes del cliente, O 1 solo mensaje si el
        //    producto de interés ya está identificado (análisis 27-jul: el 52% de las
        //    convs muere tras 1 mensaje del anuncio — antes ninguna era rescatable,
        //    y el recordatorio tiene ~77% de tasa de respuesta).
        const userMessages = history.filter(m => m.role === 'user');
        let productoIdentificado = null;
        try {
          const interesEarly = await redis.get(`interes:${phone}`);
          if (interesEarly && PRODUCT_NAMES[interesEarly]) productoIdentificado = interesEarly;
        } catch (e) { /* noop */ }
        if (!productoIdentificado) {
          productoIdentificado = detectProduct(userMessages.map(m => m.content || '').join(' '));
        }
        if (userMessages.length < MIN_USER_MESSAGES && !(userMessages.length === 1 && productoIdentificado)) {
          results.skippedTooFewMsgs++; continue;
        }

        // 4) Sin keywords negativas
        const allUserText = userMessages.map(m => (m.content || '').toLowerCase()).join(' ');
        if (NEGATIVE_KEYWORDS.some(kw => allUserText.includes(kw))) { results.skippedNegative++; continue; }

        // 5) Sin pedido cerrado ni HOT notificado
        const [pedidoFlag, hotFlag] = await Promise.all([
          redis.get(`pedido:${phone}`),
          redis.get(`hot:${phone}`)
        ]);
        if (pedidoFlag) { results.skippedOrderClosed++; continue; }
        if (hotFlag) { results.skippedHot++; continue; }

        // 6) UNA sola vez por cliente — flag atómico ANTES de enviar (SET NX)
        const acquired = await redis.set(`followup:${phone}`, JSON.stringify({ sentAt: now }), { nx: true, ex: 60 * 60 * 24 * 7 });
        if (!acquired) { results.skippedAlreadySent++; continue; }

        // PASÓ TODOS LOS FILTROS — determinar el producto de interés:
        // 1º el flag interes:{tel} que guarda el webhook (fuente de verdad),
        // 2º respaldo: detección SOLO sobre los mensajes del cliente.
        const productKey = productoIdentificado;

        const msg = buildFollowupMessage(productKey);
        await sendWhatsAppMessage(phone, msg);

        // Guardar en el historial para que el bot tenga contexto si responde
        history.push({ role: 'assistant', content: msg, ts: now });
        await redis.set(key, JSON.stringify(history.slice(-20)), { ex: 60 * 60 * 24 * 30 });

        results.sent++;
        results.details.push({ phone, hoursAgo: hoursAgo.toFixed(1), msgs: userMessages.length });
        console.log(`[followup] Enviado a ${phone} (${hoursAgo.toFixed(1)}h de silencio, ${userMessages.length} msgs)`);

      } catch (e) {
        console.error(`[followup] Error procesando ${phone}:`, e.message);
        results.errors++;
      }
    }

    console.log('[followup] Resumen:', JSON.stringify(results));
    return { statusCode: 200, body: JSON.stringify(results) };

  } catch (e) {
    console.error('[followup] Error general:', e);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
