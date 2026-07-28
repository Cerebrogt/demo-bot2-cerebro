// AI Inbox (Demo) — List Function
// Devuelve la lista de todas las conversaciones del bot WhatsApp
//
// Auth: requiere header "x-admin-password" que coincida con ADMIN_PASSWORD
//
// GET /.netlify/functions/inbox-list

const { Redis } = require('@upstash/redis');

// Prefijos por plataforma:
// - conv:50212345678        (WhatsApp - legacy sin prefijo de plataforma)
// - conv:fb:USER_ID         (Facebook Messenger)
// - conv:ig:USER_ID         (Instagram Direct)
const REDIS_PREFIXES = ['conv:'];

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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // Auth
  const provided = event.headers['x-admin-password'] || event.headers['X-Admin-Password'];
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'ADMIN_PASSWORD env var not set' }) };
  }
  if (!provided || provided !== expected) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const redis = getRedis();
  if (!redis) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Redis not configured' }) };
  }

  // Detectar plataforma e ID del cliente desde la key de Redis
  function parseKey(key) {
    // conv:fb:PAGE_ID:PSID → facebook (multi-tienda)
    // conv:50212345678     → whatsapp
    const withoutConv = key.replace(/^conv:/, '');
    if (withoutConv.startsWith('fb:')) {
      const rest = withoutConv.replace(/^fb:/, '');
      const parts = rest.split(':');
      if (parts.length === 2) {
        return {
          platform: 'facebook', id: rest, pageId: parts[0],
          linea: 'Llantas Total'
        };
      }
      return { platform: 'facebook', id: rest, pageId: null, linea: null };
    }
    if (withoutConv.startsWith('ig:')) {
      return { platform: 'instagram', id: withoutConv.replace(/^ig:/, ''), pageId: null, linea: null };
    }
    return { platform: 'whatsapp', id: withoutConv, pageId: null, linea: 'Llantas Total' };
  }

  try {
    // Listar todas las keys
    const keys = await redis.keys('conv:*');

    if (!keys || keys.length === 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ total: 0, conversations: [] })
      };
    }

    const values = await redis.mget(...keys);

    const conversations = keys.map((key, i) => {
      const { platform, id, pageId, linea } = parseKey(key);
      let history = values[i];
      if (typeof history === 'string') {
        try { history = JSON.parse(history); } catch { history = null; }
      }
      if (!Array.isArray(history) || history.length === 0) return null;

      const lastMsg = history[history.length - 1];
      const firstMsg = history[0];
      return {
        id: id,
        rawKey: key,
        platform: platform,
        pageId: pageId,
        linea: linea,
        phone: platform === 'whatsapp' ? id : null,
        messageCount: history.length,
        lastRole: lastMsg?.role || 'unknown',
        lastMessage: (lastMsg?.content || '').slice(0, 200),
        firstMessage: (firstMsg?.content || '').slice(0, 100),
        lastTs: lastMsg?.ts || null,    // Timestamp del último mensaje (puede ser null en convs viejas)
        firstTs: firstMsg?.ts || null,  // Timestamp del primer mensaje
      };
    }).filter(c => c !== null);

    // Enriquecer con flags de estado (🚨 lead / 🔥 hot / 🌡️ rescue / 🤖 campaña)
    // Los flags ya existen en Redis — acá solo se leen para mostrarlos en el inbox.
    try {
      const flagKeys = [];
      for (const c of conversations) {
        // chatId usado por el motor: whatsapp = teléfono; facebook = fb:PAGE:PSID
        const chatId = c.platform === 'whatsapp' ? c.id : `fb:${c.id}`;
        flagKeys.push(`pedido_done:${chatId}`, `hot:${chatId}`, `rescue:${chatId}`, `campaign:${chatId}`, `hotdone:${chatId}`, `hot:friccion:${chatId}`, `humano:${chatId}`);
      }
      const flagValues = [];
      for (let i = 0; i < flagKeys.length; i += 300) {
        const vals = await redis.mget(...flagKeys.slice(i, i + 300));
        flagValues.push(...vals);
      }
      conversations.forEach((c, idx) => {
        const v = flagValues.slice(idx * 7, idx * 7 + 7);
        c.isPedido = !!v[0];
        c.isLead = !!v[0]; // compat con panel viejo
        c.isHot = !!v[1] || !!v[5];
        c.isRescued = !!v[2];
        c.campaign = v[3] || null;
        c.hotAtendido = !!v[4];
        c.botPausado = !!v[6];
        // Razón del caliente (señal guardada por notifyHotLead)
        let razon = null;
        for (const hv of [v[1], v[5]]) {
          if (!hv) continue;
          try {
            const parsed = typeof hv === 'string' ? JSON.parse(hv) : hv;
            if (parsed && parsed.signal) { razon = parsed.signal; break; }
          } catch {}
        }
        c.hotRazon = razon;
      });
    } catch (e) {
      console.error('Inbox flags error:', e.message);
    }

    // Ordenar: primero por lastTs (más reciente arriba), luego por messageCount como fallback
    conversations.sort((a, b) => {
      // Si ambos tienen ts → comparar por ts
      if (a.lastTs && b.lastTs) return b.lastTs - a.lastTs;
      // Si solo uno tiene ts → el que lo tiene va primero
      if (a.lastTs && !b.lastTs) return -1;
      if (!a.lastTs && b.lastTs) return 1;
      // Si ninguno tiene ts → por cantidad de mensajes
      return b.messageCount - a.messageCount;
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        total: conversations.length,
        conversations
      })
    };
  } catch (e) {
    console.error('Inbox-list error:', e);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: e.message })
    };
  }
};
