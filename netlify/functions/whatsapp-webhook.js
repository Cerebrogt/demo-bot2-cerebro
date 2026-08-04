// CUCO Store — WhatsApp Webhook — catálogo de 3 productos (Catalogo_Productos_3.pdf, 04-ago-2026)
// Arquitectura probada del bot Cerebro AI v4.1: idempotencia por ID de mensaje,
// flags atómicos SET NX, saludo determinístico, estado inyectado, escape de loops,
// guardia anti-pedido-perdido, comportamiento humano (typing, pausas, mensajes divididos).
//
// Catálogo: Soldadora de Alambre Industrial Q855 · Lavadora Mediana Q900 (liquidación) ·
// Hidroaspiradora Portátil Q675 (antes Q1,200). Pagas al recibir · envíos a todo el país.
// El bot detecta el producto de interés (mensaje, anuncio de Meta o botón del sitio),
// manda las fotos del producto correcto y cierra: producto → nombre → teléfono → dirección.
//
// Variables de entorno: ANTHROPIC_API_KEY, WHATSAPP_VERIFY_TOKEN, WHATSAPP_ACCESS_TOKEN,
// WHATSAPP_PHONE_NUMBER_ID, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN,
// TEAM_WHATSAPP_NUMBERS (números del equipo separados por coma).

const { Redis } = require('@upstash/redis');

let _redis = null;
function getRedis() {
  if (_redis) return _redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    console.error('Upstash Redis env vars missing');
    return null;
  }
  try {
    _redis = new Redis({ url, token });
    return _redis;
  } catch (e) {
    console.error('Could not init Upstash Redis:', e.message);
    return null;
  }
}

const REDIS_PREFIX = 'conv:';
const GRAPH_URL = 'https://graph.facebook.com/v20.0';

// ============================================================
// CATÁLOGO (fuente de verdad — fichas de producto 14-jul-2026)
// ============================================================
const CATALOG = {
  'soldadora': {
    nombre: 'Máquina Soldadora de Alambre Industrial',
    precio: 'Q855',
    lineaPrecio: 'Q855, pagas al recibir',
    resumen: 'soldadora industrial 3 en 1: MIG, TIG y ARC, con amperaje regulable de 20 a 250 A',
    detalle: 'Incluye careta, guantes y alambre — lista para trabajar. Ideal para taller, herrería y proyectos en casa.',
    preguntaCierre: '¿Te la aparto?',
    fotos: ['soldadora/soldadora-flyer.jpg', 'soldadora/soldadora-2.jpg', 'soldadora/soldadora-3.jpg'],
    fotosReales: ['soldadora/soldadora-2.jpg', 'soldadora/soldadora-3.jpg', 'soldadora/soldadora-4.jpg']
  },
  'lavadora': {
    nombre: 'Lavadora Mediana',
    precio: 'Q900',
    lineaPrecio: 'Q900 en liquidación, pagas al recibir',
    resumen: 'lavadora 100% eléctrica de 25 libras, lava y exprime, 58×58 cm',
    detalle: 'Aguanta hasta lavar chamarras. Compacta: cabe en cualquier espacio. Precio de LIQUIDACIÓN mientras haya existencia.',
    preguntaCierre: '¿Te la aparto?',
    fotos: ['lavadora/lavadora-flyer.jpg', 'lavadora/lavadora-2.jpg', 'lavadora/lavadora-3.jpg'],
    fotosReales: ['lavadora/lavadora-2.jpg', 'lavadora/lavadora-3.jpg', 'lavadora/lavadora-4.jpg']
  },
  'hidroaspiradora': {
    nombre: 'Hidroaspiradora Portátil',
    precio: 'Q675',
    lineaPrecio: 'Q675 en OFERTA (antes Q1,200), pagas al recibir',
    resumen: 'hidroaspiradora portátil para limpieza profunda de tapicería, sillones, colchones y alfombras',
    detalle: 'Incluye 2 cepillos de cerdas y 2 cabezales en T para grietas. Precio de oferta: Q675 (precio normal Q1,200).',
    preguntaCierre: '¿Te la aparto al precio de oferta?',
    fotos: ['hidroaspiradora/hidroaspiradora-flyer.jpg', 'hidroaspiradora/hidroaspiradora-2.jpg', 'hidroaspiradora/hidroaspiradora-4.jpg'],
    fotosReales: ['hidroaspiradora/hidroaspiradora-2.jpg', 'hidroaspiradora/hidroaspiradora-3.jpg', 'hidroaspiradora/hidroaspiradora-4.jpg']
  }
};

// Detección de producto en DOS NIVELES para no confundir fotos:
// - FUERTE: el cliente nombra el producto explícitamente → actualiza el producto en contexto.
// - DÉBIL: palabras genéricas ("mesa" a secas) → solo se usan si NO hay producto en contexto.
// Así, si venían hablando de la mesa de noche y dice "fotos de la mesa", NO se cambia a la portátil.
function detectProduct(text) {
  const t = (text || '').toLowerCase();
  if (/soldador|soldar|soldadura|\bmig\b|\btig\b|\barc\b|careta|herrer[ií]a/.test(t)) return 'soldadora';
  if (/lavadora|lava\s*y\s*exprime|lavar\s+ropa|chamarra/.test(t)) return 'lavadora';
  if (/hidro\s*aspiradora|hidroaspiradora|aspiradora|tapicer[ií]a|alfombras?|colchon(es)?|sillones?|cabezal(es)?/.test(t)) return 'hidroaspiradora';
  return null;
}

// Detección por PRECIO: "la mesa de Q199", "el de Q75" → producto.
// Se construye AUTOMÁTICAMENTE del catálogo (precio y precio+envío).
// Precios compartidos por 2 productos (ej. Q99 almohada/cojín) quedan ambiguos → null.
const PRICE_MAP = (() => {
  const map = {};
  const add = (valor, key) => {
    const kk = String(valor);
    if (map[kk] === undefined) map[kk] = key;
    else if (map[kk] !== key) map[kk] = null; // ambiguo entre 2 productos
  };
  for (const [key, p] of Object.entries(CATALOG)) {
    const base = parseInt(String(p.precio).replace(/[^0-9]/g, ''), 10);
    if (base) add(base, key);
  }
  add(1200, 'hidroaspiradora'); // precio "antes" de la oferta
  return map;
})();

function detectByPrice(text) {
  const m = (text || '').toLowerCase().match(/q\s*\.?\s*([\d,]{2,5})/);
  if (!m) return null;
  const valor = String(parseInt(m[1].replace(/,/g, ''), 10));
  return PRICE_MAP[valor] || null;
}

// Nivel débil: última opción cuando no hay contexto guardado
function detectProductWeak(text) {
  // Con 3 mesas en catálogo (portátil, de noche, con cesta), "mesa" a secas es
  // SIEMPRE ambiguo → el bot pregunta cuál. No hay detección débil.
  return null;
}

// ============================================================
// SYSTEM PROMPT (catálogo)
// ============================================================
function catalogBlock() {
  return Object.values(CATALOG).map((p, i) =>
    `${i + 1}. ${p.nombre.toUpperCase()} — ${p.lineaPrecio}\n   ${p.resumen[0].toUpperCase() + p.resumen.slice(1)}. ${p.detalle}`
  ).join('\n');
}

const SYSTEM_PROMPT = `Sos el asistente de ventas de CUCO Store, tienda en línea en Guatemala. Atendés por WhatsApp. Vendés ÚNICAMENTE estos 3 productos:

# CATÁLOGO (única fuente de verdad — NO inventes nada fuera de esto)

${catalogBlock()}

# ENVÍOS Y PAGOS (aplica a todo el catálogo — podés afirmarlo con seguridad)

- Envíos a TODO el país.
- Pago AL RECIBIR: el cliente paga hasta tener su producto en la mano. NUNCA pidas anticipos ni des números de cuenta.
- COSTO y TIEMPO de envío: NO los inventes. Si preguntan, decí: "El costo y el tiempo de envío te los confirma el equipo según tu ubicación al coordinar la entrega" — y seguí con el cierre.
- PRECIOS DE OFERTA: la hidroaspiradora está en OFERTA a Q675 (antes Q1,200) y la lavadora en LIQUIDACIÓN a Q900. Podés usarlos como argumento de venta, pero NUNCA inventes otros descuentos ni rebajas adicionales.

# GARANTÍA Y DETALLES TÉCNICOS

- Si preguntan algo que NO está en el catálogo (garantía, voltaje, marca exacta, repuestos, otros modelos): "Esa la confirmo con el equipo y te digo" — NUNCA inventes.
- Si piden un producto que no vendemos, decilo con amabilidad y ofrecé lo más parecido del catálogo si existe.

FOTOS Y VIDEOS (reglas estrictas):
- Cuando el cliente pide fotos, el sistema envía las fotos automáticamente — vos no podés adjuntar nada.
- NUNCA digas la palabra "sistema" al cliente. Si el ESTADO confirma que se enviaron, decí natural: "Ahí te van 💜" o "Ya te las mandé, ¿las ves?".
- SOLO afirmá que las fotos se enviaron si el bloque ESTADO lo confirma. Si NO lo confirma, NUNCA digas "ya están en tu chat" — en ese caso preguntá de qué producto quiere fotos.
- VIDEOS: no tenemos videos para el chat. Si piden video: "Video no tengo a la mano, pero las fotos te lo muestran bien" — pedir video hace que lleguen las fotos automáticamente, así que comentalas y seguí el cierre.
- NUNCA digas que no podés mandar fotos.

# TU OBJETIVO

CERRAR PEDIDOS. Un pedido cerrado = PRODUCTO + NOMBRE COMPLETO + TELÉFONO + DIRECCIÓN EXACTA.

Tu estilo: como una persona real del equipo atendiendo por WhatsApp — cálido, ágil, conversacional. NUNCA sonás a formulario ni a call center:
- Reaccioná a lo que el cliente cuenta ("es para mi taller" → "para tu taller te va perfecta").
- Confirmá cada dato con naturalidad ("¡Va, anotado María!") antes de pedir el siguiente.
- Usá CIERRE ASUMIDO: "¿Te la aparto?" — nunca "¿desea proceder con su pedido?".
- Variá tus frases: nunca repitas la misma muletilla dos veces en la conversación.

# SONAR HUMANO (crítico — el cliente NO debe sentir que habla con un bot)

- Escribe como escribe la gente en WhatsApp: frases cortas, directas, con ritmo natural.
- VARÍA la longitud: a veces una línea basta. Si el cliente manda un mensaje corto ("ok", "sí"), responde corto tú también.
- Retoma las palabras del cliente en tu respuesta.
- Muletillas naturales con moderación (una por mensaje máximo): "va", "listo", "perfecto", "mira", "claro que sí".
- PROHIBIDAS las frases de bot: "como asistente", "estoy aquí para ayudarte", "¿en qué más puedo ayudarte?", "gracias por contactarnos", "apreciamos tu interés".
- Nada de listas con guiones o números salvo que el cliente pida el catálogo completo o un desglose.
- No respondas todo con la misma estructura (saludo + info + pregunta). Rompe el patrón.

# MARCADORES DE SISTEMA (lo más importante de todo este prompt)

Son invisibles para el cliente (el sistema los borra) y disparan la notificación al equipo. Van SIEMPRE en la última línea de tu respuesta, separados del texto.

## [PEDIDO:producto con detalle|nombre completo|telefono|direccion exacta] — pedido cerrado

Cuando tengas los 4 datos, tu respuesta DEBE terminar con este marcador.
- producto con detalle: nombre del producto + cantidad si aplica. Ej: "Soldadora industrial", "Lavadora mediana", "Hidroaspiradora portátil"
- telefono: el número CONFIRMADO con el cliente. Su WhatsApp viene en el bloque ESTADO — si confirma que lo contacten ahí, escribí ESE número (con dígitos). NUNCA escribas "mismo-whatsapp" ni "el mismo".
- direccion: dirección exacta con zona/municipio/departamento

EJEMPLOS:
[PEDIDO:Soldadora industrial|María José López|50211112222|4a calle 5-20 zona 11, Guatemala]
[PEDIDO:Hidroaspiradora portátil|Karla Ruiz|+502 5512-3344|Barrio El Centro, casa B-4, Salamá, Baja Verapaz]

Sin este marcador el equipo NUNCA se entera del pedido y la venta se pierde. Verificación antes de enviar: ¿tengo producto + nombre + teléfono + dirección? → el marcador va en la última línea.

## [HOT_PEDIDO:razón] — quiere comprar pero no vas a lograr cerrar

Emitilo (una sola vez por cliente) cuando: (1) pide EXPLÍCITAMENTE hablar con una persona → en ese mismo turno; (2) pediste algún dato 2 veces y esquiva pero quiere el producto; (3) el bloque ESTADO te lo indique; (4) pregunta técnica de la soldadora que no sabés responder y el cliente muestra intención real (es producto de ticket alto y técnico — mejor lo cierra una persona). Al emitirlo decile: "Te conecto con el equipo — te escriben en breve por este mismo WhatsApp."

EJEMPLO:
[HOT_PEDIDO:pregunta técnica de la soldadora (voltaje) — cerrar por humano]

# FLUJO DE VENTA

1. IDENTIFICÁ el producto de interés. Si el ESTADO ya lo indica (vino de un anuncio), no preguntes de nuevo — andá directo. Si pregunta "¿qué venden?", mencioná el catálogo en una línea natural: "Tenemos máquina soldadora industrial 3 en 1 (Q855), lavadora mediana en liquidación (Q900) e hidroaspiradora portátil en oferta (Q675, antes Q1,200). Todo con pago al recibir. ¿Cuál te llama?"
2. Dale la info clave del producto (precio + 1-2 beneficios) y avanzá con su pregunta de cierre.
3. Con eso, capturá EN ESTE ORDEN, UN dato por mensaje, manteniendo el hilo humano (agradecé → confirmá → avanzá):
   - "Para el envío, ¿me das tu nombre completo?"
   - "Gracias [nombre]. ¿Te contactamos al [su número de WhatsApp — viene en el ESTADO] o prefieres otro número?" — NUNCA le pidas que escriba "este mismo": vos ya tenés su número, solo confirmalo.
   - "Última cosita: ¿cuál es tu dirección exacta de entrega? (con zona o municipio)"
4. CONFIRMÁ todo en una línea con calidez: producto, precio, pago al recibir, y que el equipo le confirma el envío → emití [PEDIDO:...] en esa misma respuesta.
5. POST-CIERRE: MODO ASISTENTE. Confirmá que el equipo coordina la entrega. NO vendás más. Si quiere agregar OTRO producto o cambiar un dato, tomalo y emití OTRO [PEDIDO:...] con TODO el pedido actualizado (reutilizá nombre/teléfono/dirección).

## Varios productos en un pedido

Si antes de cerrar pide más de un producto, juntá TODO en UN solo marcador: [PEDIDO:Lavadora mediana + Hidroaspiradora portátil|...].

## Señales de compra INMEDIATA (saltá directo a la captura)

"Lo quiero" / "¿cómo lo pido?" / "¿está disponible?" / "¿hacen envíos a X?" / "¿puedo pagar al recibir?"

# OBJECIONES — REGLA DE 2 STRIKES

STRIKE 1 — "está caro" / "lo pienso" / "luego": UNA vez, corto: "Te entiendo. Toma en cuenta que pagas hasta recibirlo — cero riesgo. ¿Te lo aparto mientras lo piensas?"
STRIKE 2 — si repite o se despide: cerrá cordial ("Aquí quedamos a la orden 💜"). Si mostró intención real y no cerraste, emití [HOT_PEDIDO:...]. PROHIBIDO insistir una tercera vez.
Escasez: NUNCA inventes "últimas unidades" ni descuentos nuevos. Las únicas ofertas reales: hidroaspiradora Q675 (antes Q1,200) y lavadora Q900 en liquidación.

# TONO (WhatsApp, español neutro)

- Español NEUTRO con "tú": puedes, dime, quieres, te gusta. NUNCA uses voseo (podés/decime/querés) ni "usted".
- Cercano pero sin modismos locales. 2-4 líneas por mensaje. NUNCA más de 5. UNA pregunta por mensaje.
- Texto plano: PROHIBIDO usar ** o markdown. Máximo 1 emoji por mensaje (💜 🛍️).
- Nada de call center. No empieces cada mensaje con "Hola" — solo el primero.
- "¿Eres un robot?" → "Soy el asistente con IA de CUCO Store, con el equipo humano detrás. ¿Quieres que te conecte con una persona?" (si dice que sí → [HOT_PEDIDO:...]).

# PROHIBICIONES ABSOLUTAS

- NUNCA cambies precios. NUNCA inventes descuentos (solo existen: hidroaspiradora Q675 antes Q1,200, y lavadora Q900 en liquidación).
- NUNCA inventes el costo ni el tiempo de envío — eso lo confirma el equipo según la ubicación.
- NUNCA pidas anticipos, depósitos ni des números de cuenta.
- NUNCA des el número de WhatsApp del equipo.
- NUNCA inventes características de los productos.
- NUNCA sigas vendiendo después de dos despedidas del cliente.`;

// ============================================================
// PRODUCTO PERSONALIZADO (admin.html → producto:activo en Redis)
// Si el admin guarda un producto, el bot vende SOLO ese (modo campaña única).
// "Volver al producto por defecto" en el panel = regresa a este catálogo.
// ============================================================
async function getActiveProduct() {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const data = await redis.get('producto:activo');
    if (!data) return null;
    const p = typeof data === 'object' ? data : JSON.parse(data);
    return p && p.nombre ? p : null;
  } catch (e) {
    console.error('getActiveProduct error:', e.message);
    return null;
  }
}

function buildCustomPrompt(p) {
  const total = (parseFloat(p.precio) || 0) + (parseFloat(p.envio) || 0);
  const variantes = Array.isArray(p.variantes) && p.variantes.length ? p.variantes.join(', ') : '';
  return `Sos el asistente de ventas de CUCO Store, tienda en línea en Guatemala. Atendés por WhatsApp. Vendés UN solo producto: ${p.nombre}.

# EL PRODUCTO (única fuente de verdad — NO inventes nada fuera de esto)

- ${p.nombre}
- Precio: Q${p.precio} + Q${p.envio} de envío = Q${total} total. Pago: ${p.pago || 'contra entrega (pagas al recibir, sin anticipo)'}.
${variantes ? `- Opciones disponibles: ${variantes}\n` : ''}${p.descripcion ? `- ${p.descripcion}\n` : ''}${p.usos ? `- Usos ideales si preguntan: ${p.usos}\n` : ''}- Envíos a todo el país, pagas al recibir. Costo y tiempo de envío: los confirma el equipo según la ubicación.
${p.faq ? `\nPreguntas frecuentes (podés afirmar esto):\n${p.faq}\n` : ''}
Si preguntan algo que NO está acá, respondé: "Esa la confirmo con el equipo y te digo" — NUNCA inventes.

FOTOS: cuando el cliente pide fotos, EL SISTEMA se las envía automáticamente. NUNCA digas que no podés mandar fotos.

# TU OBJETIVO

CERRAR PEDIDOS. Un pedido cerrado = ${variantes ? 'OPCIÓN ELEGIDA' : 'PRODUCTO'} + NOMBRE COMPLETO + TELÉFONO + DIRECCIÓN EXACTA.

# MARCADORES (invisibles al cliente; última línea de tu respuesta)

## [PEDIDO:opcion y cantidad|nombre completo|telefono|direccion exacta] — al tener los 4 datos, OBLIGATORIO.
- telefono: el número CONFIRMADO (su WhatsApp viene en el ESTADO — si confirma ese, escribí ese número). NUNCA escribas "mismo-whatsapp".
EJEMPLO: [PEDIDO:${variantes ? (p.variantes[0] || 'opción') : p.nombre}|María López|+502 5512-3344|4a calle 5-20 zona 11, Guatemala]

## [HOT_PEDIDO:razón] — quiere comprar pero no lograrás cerrar (pide humano, o esquivó datos 2 veces). Una sola vez por cliente.

# FLUJO: ${variantes ? `opción (${variantes})` : 'confirmar qué quiere'} → nombre completo → teléfono → dirección exacta → confirmá total Q${total} contra entrega, llega en 2-3 días → [PEDIDO:...].
POST-CIERRE: modo asistente, no vendás más. Cambios de datos → nuevo [PEDIDO:...] corregido.

# OBJECIONES — 2 STRIKES: primera vez destapá corto ("pagas hasta recibirlo — cero riesgo, ¿te lo aparto?"); si repite, cerrá cordial y si hubo interés real emití [HOT_PEDIDO:...]. NUNCA inventes descuentos ni escasez.

# TONO (WhatsApp, español neutro): "tú" (puedes, dime, quieres), NUNCA voseo ni "usted". 2-4 líneas, UNA pregunta por mensaje, texto plano sin markdown, máx 1 emoji (🧡). Sonar humano: frases cortas, variar longitud, retomar palabras del cliente, sin frases de call center. No empieces cada mensaje con "Hola".

# PROHIBICIONES: no cambies precios, no pidas anticipos ni des cuentas, no des el número del equipo, no prometas más que "2-3 días", no inventes características, no sigas vendiendo tras dos despedidas.`;
}

function greetingFromProduct(p) {
  const total = (parseFloat(p.precio) || 0) + (parseFloat(p.envio) || 0);
  const variantes = Array.isArray(p.variantes) && p.variantes.length ? p.variantes : null;
  return `¡Hola! 💜 Claro que sí. ${p.nombre}: Q${p.precio} + Q${p.envio} de envío (Q${total} total), y pagas al recibirlo.

${variantes ? `Hay en ${variantes.join(', ')}. ¿Cuál te gusta?` : '¿Te lo aparto?'}`;
}

// ============================================================
// SALUDOS DETERMINÍSTICOS
// ============================================================
// Botón "Pedir por WhatsApp" del sitio
const PRODUCT_CLICK_RX = /me interesa el producto:?\s*\*?([^*🛍️?]+?)\*?\s*🛍️?\s*¿?est[aá] disponible\??/i;
// Presets de anuncios de Meta (click-to-WhatsApp)
const QUICK_REPLY_RX = /^¡?hola!?[\s.,!¿]*((quiero|me gustar[ií]a( conseguir| recibir| saber)?|puedes? darme|me pued(es|en) dar)\s+(m[aá]s\s+)?(informaci[oó]n|info)(\s+sobre\s+(esto|este producto))?|me interesa( el producto| esto)?|quiero\s+info(rmacion|rmación)?)[\s.!?]*$/i;

function greetingForCatalogProduct(key) {
  const p = CATALOG[key];
  return `¡Hola! 💜 Claro que sí. ${p.nombre}: ${p.lineaPrecio}.

${p.preguntaCierre}`;
}

const GREETING_GENERIC = `¡Hola! 💜 Con gusto. En CUCO Store tenemos máquina soldadora industrial 3 en 1 (Q855), lavadora mediana en liquidación (Q900) e hidroaspiradora portátil en oferta (Q675, antes Q1,200). Todo con pago al recibir y envíos a todo el país.

¿Cuál te interesa?`;

// ============================================================
// FOTOS
// ============================================================
const PHOTO_REQ_RX = /\bfotos?\b|\bv[ií]deos?\b|\bim[aá]ge(n|nes)\b|\bfotograf[ií]as?\b|c[oó]mo (se ve|es|son)\b|\bverl[oa]s?\b|puedo ver\b|quiero ver\b|quisiera ver\b|me gustar[ií]a ver\b|a ver si me (mandas|env[ií]as)|ens[eé][ñn][aá]me(l[oa])?|mu[eé]str[aá]me(l[oa])?|m[aá]ndame (la |una |otra )?(foto|imagen)|ver (el|la) (producto|soldadora|lavadora|aspiradora|art[ií]culo)|pictures?/i;

async function sendWhatsAppImage(to, imageUrl, caption) {
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!phoneId || !token) throw new Error('WhatsApp credentials missing');

  const image = { link: imageUrl };
  if (caption) image.caption = caption;

  const response = await fetch(`${GRAPH_URL}/${phoneId}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'image', image })
  });
  if (!response.ok) {
    const t = await response.text();
    console.error('WhatsApp image send error:', response.status, t.slice(0, 300));
    throw new Error('WhatsApp image send failed: ' + response.status);
  }
  return response.json();
}

// Envía las fotos del producto indicado (o del producto admin). Devuelve cuántas envió.
const PHOTO_REAL_RX = /\breal(es)?\b|de verdad|tal (y )?c[oó]mo (es|se ve)|sin (el )?dise[ñn]o|del producto f[ií]sico/i;

async function sendProductPhotos(userId, productKey, productoAdmin, requestText) {
  const baseUrl = process.env.URL || process.env.DEPLOY_URL;
  if (!baseUrl) {
    console.error('[fotos] Sin URL base del sitio');
    return 0;
  }
  const base = baseUrl.replace(/\/$/, '');

  let urls, caption;
  if (productoAdmin && Array.isArray(productoAdmin.fotos) && productoAdmin.fotos.length > 0) {
    urls = productoAdmin.fotos.slice(0, 3).map(f => /^https?:\/\//i.test(f) ? f : base + f);
    caption = `${productoAdmin.nombre} 💜`;
  } else if (productKey && CATALOG[productKey]) {
    const p = CATALOG[productKey];
    const wantsReal = PHOTO_REAL_RX.test(requestText || '') && Array.isArray(p.fotosReales);
    urls = (wantsReal ? p.fotosReales : p.fotos).slice(0, 3).map(f => `${base}/img/${f}`);
    caption = `${p.nombre} 💜`;
  } else {
    return 0;
  }

  let sent = 0;
  for (let i = 0; i < urls.length; i++) {
    try {
      await sendWhatsAppImage(userId, urls[i], i === 0 ? caption : undefined);
      sent++;
    } catch (e) {
      console.error(`[fotos] Error enviando ${urls[i]}:`, e.message);
    }
  }
  console.log(`[fotos] ${sent}/${urls.length} enviadas a ${userId} (${productKey || 'producto-admin'})`);
  return sent;
}

// ============================================================
// UTILIDADES DE CONVERSACIÓN
// ============================================================
function isLowContent(text) {
  const t = (text || '').trim().toLowerCase();
  if (t.length > 14) return false;
  return /^(hola+|holi+|buenas|buenos dias|buenos días|buenas tardes|buenas noches|info|informacion|información|ok|si|sí|\.+|\?+|👍|🙏|🙂|😀|😊)$/i.test(t);
}

async function buildStateNotes(userId) {
  const redis = getRedis();
  if (!redis) return '';
  try {
    const [askedRaw, hot, pedido, fotos, interes] = await Promise.all([
      redis.get(`asked_datos:${userId}`),
      redis.get(`hot:${userId}`),
      redis.get(`pedido:${userId}`),
      redis.get(`fotos:${userId}`),
      redis.get(`interes:${userId}`)
    ]);
    const asked = parseInt(askedRaw, 10) || 0;
    const notes = [];
    if (interes && CATALOG[interes]) {
      notes.push(`- Producto de interés detectado: ${CATALOG[interes].nombre}. Ese es el producto de esta venta salvo que el cliente diga otra cosa.`);
    }
    if (pedido) {
      notes.push('- Este cliente YA tiene un pedido cerrado y el equipo ya fue notificado. MODO ASISTENTE: confirmá que coordinan la entrega, respondé dudas. Si quiere OTRO producto o cambiar un dato, tomá los datos y emití otro [PEDIDO:...] (reutilizá nombre/teléfono/dirección).');
    }
    if (hot) {
      notes.push('- Ya se notificó al equipo humano ([HOT_PEDIDO] ya emitido). NO lo emitas de nuevo. Si pregunta cuándo le escriben, confirmá que ya tienen su caso.');
    }
    if (fotos) {
      notes.push('- Ya se le enviaron fotos en esta conversación. Si pide más, el sistema las manda automáticamente — vos solo comentá.');
    }
    if (!pedido && asked >= 2) {
      notes.push('- Ya pediste sus datos ' + asked + ' veces sin éxito. NO los pidas otra vez. Si el cliente quiere el producto, emití [HOT_PEDIDO:razón] en esta misma respuesta y avisale que el equipo le escribe por este WhatsApp.');
    }
    return notes.join('\n');
  } catch (e) {
    console.error('buildStateNotes error:', e.message);
    return '';
  }
}

// Memoria por usuario (respaldo si Redis no responde)
const memoryFallback = new Map();
function getMemoryHistory(userId) {
  return memoryFallback.get(userId) || [];
}
function setMemoryHistory(userId, history) {
  memoryFallback.set(userId, history.slice(-16));
  if (memoryFallback.size > 200) {
    const firstKey = memoryFallback.keys().next().value;
    memoryFallback.delete(firstKey);
  }
}

async function getHistory(userId) {
  const redis = getRedis();
  if (!redis) return getMemoryHistory(userId);
  try {
    const data = await redis.get(REDIS_PREFIX + userId);
    if (!data) return [];
    if (Array.isArray(data)) return data;
    if (typeof data === 'string') {
      try { return JSON.parse(data); } catch { return []; }
    }
    return [];
  } catch (e) {
    console.error('Get history failed:', e.message);
    return getMemoryHistory(userId);
  }
}

async function saveHistory(userId, history) {
  setMemoryHistory(userId, history);
  const redis = getRedis();
  if (!redis) return;
  try {
    const trimmed = history.slice(-20);
    await redis.set(REDIS_PREFIX + userId, JSON.stringify(trimmed), { ex: 60 * 60 * 24 * 30 });
  } catch (e) {
    console.error('Could not save history to Redis:', e.message);
  }
  await archiveHistory(redis, userId, history);
}

// Panel v2: archivo COMPLETO de la conversación (convfull:{tel}) — el conv:{tel}
// se recorta a 20 mensajes para el bot, pero el panel muestra el hilo entero
// desde aquí (merge sin duplicados, tope 600 mensajes, 30 días).
async function archiveHistory(redis, userId, history) {
  if (!redis) return;
  try {
    let full = await redis.get('convfull:' + userId);
    if (typeof full === 'string') { try { full = JSON.parse(full); } catch { full = []; } }
    if (!Array.isArray(full)) full = [];
    const firma = (m) => `${m.ts || 0}|${m.role}|${String(m.content || '').slice(0, 60)}`;
    const vistos = new Set(full.map(firma));
    for (const m of history) { if (!vistos.has(firma(m))) { full.push(m); vistos.add(firma(m)); } }
    full.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    await redis.set('convfull:' + userId, JSON.stringify(full.slice(-600)), { ex: 60 * 60 * 24 * 30 });
  } catch (e) { console.error('[convfull] error:', e.message); }
}

async function callClaude(messages, systemPrompt) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      temperature: 0.5,   // variedad natural sin perder el guion
      system: systemPrompt || SYSTEM_PROMPT,
      messages: messages
    })
  });
  if (!response.ok) {
    const t = await response.text();
    throw new Error('Claude API error: ' + response.status + ' ' + t.slice(0, 200));
  }
  const data = await response.json();
  if (data && data.stop_reason === 'max_tokens') {
    console.warn('⚠️ [callClaude] Respuesta cortada por max_tokens — posible marcador perdido');
  }
  return (data && data.content && data.content[0] && data.content[0].text) || '';
}

async function sendWhatsAppMessage(to, text) {
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!phoneId || !token) throw new Error('WhatsApp credentials missing');

  const response = await fetch(`${GRAPH_URL}/${phoneId}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: to,
      type: 'text',
      text: { preview_url: false, body: text }
    })
  });
  if (!response.ok) {
    const t = await response.text();
    console.error('WhatsApp send error:', response.status, t);
    throw new Error('WhatsApp send failed: ' + response.status);
  }
  return response.json();
}

// === COMPORTAMIENTO HUMANO EN EL CHAT ===
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function markReadWithTyping(messageId) {
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!phoneId || !token || !messageId) return;
  try {
    await fetch(`${GRAPH_URL}/${phoneId}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
        typing_indicator: { type: 'text' }
      })
    });
  } catch (e) {
    console.error('[typing] error:', e.message);
  }
}

async function sendHumanReply(to, text) {
  let parts = String(text).split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) parts = [text];
  if (parts.length > 3) parts = [parts[0], parts[1], parts.slice(2).join('\n\n')];

  for (let i = 0; i < parts.length; i++) {
    const delay = Math.min(2200, 400 + parts[i].length * 15);
    await sleep(delay);
    await sendWhatsAppMessage(to, parts[i]);
  }
}

// ============================================================
// NOTIFICACIONES AL EQUIPO
// ============================================================
// Si el cliente dijo "el mismo" (o cualquier variante) en vez de dar un número,
// se usa SIEMPRE el número de WhatsApp desde donde escribe. Regla determinística:
// si el campo no trae al menos 8 dígitos, no es un teléfono real → va el del WhatsApp.
function resolveTelefono(telRaw, userId) {
  const digits = String(telRaw || '').replace(/\D/g, '');
  if (digits.length >= 8) return String(telRaw).trim();
  return `+${userId}`;
}

// Huella CANÓNICA de un pedido a partir del texto del producto del marcador.
// "2 Almohadas Foamy + Mesa portátil rosada" → "almohada:2+mesa-portatil:1"
// Así, dos marcadores del MISMO producto+cantidad generan la MISMA huella aunque
// el bot reescriba el nombre, la dirección o el color — y no se re-notifica.
function canonicalOrderFingerprint(productoText) {
  const segmentos = String(productoText || '').split(/\s*(?:\+|,)\s*|\s+y\s+/i).filter(Boolean);
  const items = segmentos.map(seg => {
    const key = detectProduct(seg) ||
      seg.toLowerCase().replace(/[^a-z0-9áéíóúñü]+/gi, ' ').replace(/\s+/g, ' ').trim();
    const mQty = seg.match(/(?:^|[^0-9a-z])(\d{1,2})(?![0-9])/i);
    const qty = mQty ? parseInt(mQty[1], 10) : (/\bdos\b/i.test(seg) ? 2 : 1);
    return `${key}:${qty || 1}`;
  });
  return items.sort().join('+');
}

async function notifyTeam(userId, structuredData = {}, history = []) {
  const teamNumbers = (process.env.TEAM_WHATSAPP_NUMBERS || '')
    .split(',').map(n => n.trim()).filter(Boolean);

  if (teamNumbers.length === 0) {
    console.log('No team numbers configured for notifications');
    return;
  }

  const producto = structuredData.producto || 'Sin especificar';
  const nombre = structuredData.nombre || 'Sin nombre';
  const telRaw = resolveTelefono(structuredData.telefono, userId);
  const telefono = telRaw.replace(/\D/g, '') === String(userId) ? `${telRaw} (su WhatsApp)` : telRaw;
  const direccion = structuredData.direccion || 'Sin dirección';

  const recentMessages = history.slice(-4)
    .map(m => `${m.role === 'user' ? '👤 Cliente' : '🤖 Bot'}: ${m.content.slice(0, 200)}${m.content.length > 200 ? '...' : ''}`)
    .join('\n\n');

  const notificationText = `🛒 *PEDIDO CERRADO — CUCO Store*

📦 *Producto:* ${producto}
👤 *Nombre:* ${nombre}
📞 *Teléfono:* ${telefono}
📍 *Dirección:* ${direccion}
📱 *WhatsApp:* +${userId}
💵 *Pago:* al recibir (envío por confirmar según ubicación)

💬 *Últimos mensajes:*
${recentMessages}

🔗 *Escribile directo:*
https://wa.me/${userId}

✅ Coordinar entrega y confirmarle costo/tiempo de envío al cliente.

⏰ ${new Date().toLocaleString('es-GT', { timeZone: 'America/Guatemala' })}`;

  const results = await Promise.allSettled(
    teamNumbers.map(num => sendWhatsAppMessage(num, notificationText))
  );
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`Failed to notify team member ${teamNumbers[i]}:`, r.reason?.message);
    } else {
      console.log(`Notified team member ${teamNumbers[i]}`);
    }
  });
}

async function notifyHotPedido(userId, signal, history = []) {
  try {
    const redis = getRedis();
    if (redis) {
      const acquired = await redis.set(`hot:${userId}`, JSON.stringify({
        signal, notifiedAt: Date.now()
      }), { nx: true, ex: 60 * 60 * 24 * 7 });
      if (!acquired) {
        console.log(`[HOT_PEDIDO] Ya notificado para ${userId}, skipping duplicate`);
        return;
      }
    }
  } catch (e) {
    console.error('[HOT_PEDIDO] Redis check error:', e.message);
  }

  const teamNumbers = (process.env.TEAM_WHATSAPP_NUMBERS || '')
    .split(',').map(n => n.trim()).filter(Boolean);
  if (teamNumbers.length === 0) {
    console.log('[HOT_PEDIDO] No team numbers configured');
    return;
  }

  const recentMessages = history.slice(-6)
    .map(m => `${m.role === 'user' ? '👤' : '🤖'} ${m.content.slice(0, 150)}${m.content.length > 150 ? '...' : ''}`)
    .join('\n');

  const notificationText = `🔥 *CLIENTE CALIENTE — INTERVENIR AHORA*

📱 *WhatsApp:* +${userId}
💡 *Señal detectada:* "${signal}"

💬 *Conversación reciente:*
${recentMessages}

🚀 *Escribile YA:*
https://wa.me/${userId}

⏰ ${new Date().toLocaleString('es-GT', { timeZone: 'America/Guatemala' })}`;

  const results = await Promise.allSettled(
    teamNumbers.map(num => sendWhatsAppMessage(num, notificationText))
  );
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`[HOT_PEDIDO] Failed to notify ${teamNumbers[i]}:`, r.reason?.message);
    } else {
      console.log(`[HOT_PEDIDO] Notified ${teamNumbers[i]} about ${userId}`);
    }
  });
}

async function captureOrder(userId, history, structuredData = {}) {
  // Anti-duplicado por huella CANÓNICA (producto+cantidad, no texto literal).
  // Antes la huella era producto|nombre|direccion textual: si el bot re-emitía el
  // marcador con la dirección o el nombre reescritos ("zona 10" vs "Zona 10, Guatemala"),
  // el hash cambiaba y el MISMO pedido volvía a notificar al equipo y al panel.
  // Ahora el mismo producto+cantidad del mismo cliente = mismo pedido por 24 h.
  // Un producto DISTINTO (o cantidad distinta) SÍ notifica: el cliente puede pedir varias cosas.
  try {
    const redis = getRedis();
    if (redis) {
      const fingerprint = canonicalOrderFingerprint(structuredData.producto);
      let h = 0;
      for (const ch of fingerprint) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      const acquired = await redis.set(`pedido_dedup:${userId}:${h}`, '1', { nx: true, ex: 60 * 60 * 24 });
      if (!acquired) {
        console.log(`[captureOrder] pedido duplicado de ${userId} — skip re-notificación`);
        return;
      }
      await redis.set(`pedido:${userId}`, JSON.stringify({
        capturedAt: Date.now(),
        producto: structuredData.producto || null,
        nombre: structuredData.nombre || null,
        telefono: structuredData.telefono || null,
        direccion: structuredData.direccion || null
      }), { ex: 60 * 60 * 24 * 30 });
      // Panel v2: UNA llave POR PEDIDO (pedido:{ts}:{tel}) — la pestaña Pedidos
      // del panel lista todos los pedidos desde estas llaves (90 días).
      const pedidoTs = Date.now();
      await redis.set(`pedido:${pedidoTs}:${userId}`, JSON.stringify({
        productos: structuredData.producto || '',
        nombre: structuredData.nombre || '',
        telefono: structuredData.telefono || `+${userId}`,
        direccion: structuredData.direccion || '',
        pago: 'al recibir (envío por confirmar)',
        canal: 'whatsapp',
        linea: 'cuco',
        tiendaNombre: 'CUCO Store',
        ts: pedidoTs
      }), { ex: 60 * 60 * 24 * 90 });
    }
  } catch (e) {
    console.error('[captureOrder] dedup error:', e.message);
  }

  // 1) Netlify Forms → registro + email
  const recentMessages = history.slice(-8).map(m => `${m.role === 'user' ? 'Cliente' : 'Bot'}: ${m.content}`).join('\n');
  const fd = new URLSearchParams();
  fd.set('form-name', 'pedidos-cuco-store');
  fd.set('origen', 'whatsapp-bot');
  fd.set('producto', structuredData.producto || '');
  fd.set('nombre', structuredData.nombre || `Cliente WhatsApp ${userId}`);
  fd.set('telefono', resolveTelefono(structuredData.telefono, userId));
  fd.set('whatsapp', userId);
  fd.set('direccion', structuredData.direccion || '');
  fd.set('mensaje', `Pago al recibir — confirmar envío según ubicación.\nConversación reciente:\n${recentMessages}`);

  try {
    const baseUrl = process.env.URL || process.env.DEPLOY_URL;
    if (baseUrl) {
      await fetch(`${baseUrl}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: fd.toString()
      });
    }
  } catch (e) {
    console.error('Order capture (Netlify Forms) error:', e.message);
  }

  // 2) WhatsApp al equipo
  try {
    await notifyTeam(userId, structuredData, history);
  } catch (e) {
    console.error('Team notification error:', e.message);
  }
}

// ============================================================
// HANDLER
// ============================================================
exports.handler = async (event) => {
  // === GET: verificación del webhook ===
  if (event.httpMethod === 'GET') {
    const mode = event.queryStringParameters?.['hub.mode'];
    const token = event.queryStringParameters?.['hub.verify_token'];
    const challenge = event.queryStringParameters?.['hub.challenge'];
    if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      return { statusCode: 200, body: challenge };
    }
    return { statusCode: 403, body: 'Forbidden' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  let body;
  try { body = JSON.parse(event.body); } catch (e) { return { statusCode: 400, body: 'Invalid JSON' }; }

  try {
    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    if (!message) return { statusCode: 200, body: 'OK' };

    const userId = message.from;

    // Idempotencia: Meta reintenta el webhook si no recibe 200 rápido.
    // (Aplica a TODO tipo de mensaje, incluidas imágenes.)
    if (message.id) {
      try {
        const redis = getRedis();
        if (redis) {
          const firstTime = await redis.set(`msg:${message.id}`, '1', { nx: true, ex: 60 * 60 * 24 });
          if (!firstTime) {
            console.log(`[dedup] Mensaje ${message.id} ya procesado`);
            return { statusCode: 200, body: 'OK' };
          }
        }
      } catch (e) { console.error('[dedup] error:', e.message); }
    }

    // Panel v2: ¿hay una asesora atendiendo este chat? (humano:{tel} = bot en pausa)
    let asesoraActiva = false;
    try {
      const redis = getRedis();
      if (redis) asesoraActiva = !!(await redis.get(`humano:${userId}`));
    } catch (e) { /* noop */ }

    // 📷 Imagen del cliente → indexarla para el panel (fotoschat:{tel}, 180 días)
    if (message.type === 'image' && message.image?.id) {
      try {
        const redis = getRedis();
        if (redis) {
          await redis.rpush(`fotoschat:${userId}`, JSON.stringify({ mid: message.image.id, ts: Date.now() }));
          await redis.ltrim(`fotoschat:${userId}`, -48, -1);
          await redis.expire(`fotoschat:${userId}`, 60 * 60 * 24 * 180);
        }
      } catch (e) { console.error('[fotoschat] error:', e.message); }
      const historyImg = await getHistory(userId);
      const imgCaption = (message.image.caption || '').trim();
      historyImg.push({ role: 'user', content: `(📷 El cliente envió una foto${imgCaption ? ': ' + imgCaption : ''})`, ts: Date.now() });
      await saveHistory(userId, historyImg);
      if (!asesoraActiva) {
        await sendWhatsAppMessage(userId, '¡Recibida! 💜 Cuéntame, ¿en qué te puedo ayudar?');
      }
      return { statusCode: 200, body: 'OK' };
    }

    if (message.type !== 'text') {
      if (!asesoraActiva) {
        await sendWhatsAppMessage(userId, 'Por ahora solo manejo mensajes de texto 😅 Escríbeme qué producto te interesa y te ayudo.');
      }
      return { statusCode: 200, body: 'OK' };
    }

    const userText = message.text.body.trim();
    if (!userText) return { statusCode: 200, body: 'OK' };

    // Asesora atendiendo → guardar el mensaje del cliente en el historial y NO responder
    if (asesoraActiva) {
      const historyPausa = await getHistory(userId);
      historyPausa.push({ role: 'user', content: userText, ts: Date.now() });
      await saveHistory(userId, historyPausa);
      console.log(`[humano] ${userId}: asesora activa — bot en silencio`);
      return { statusCode: 200, body: 'OK' };
    }

    // Visto azul + "escribiendo…" (no bloquea)
    markReadWithTyping(message.id).catch(() => {});

    const history = await getHistory(userId);
    const productoAdmin = await getActiveProduct();

    // === DETECCIÓN DE PRODUCTO DE INTERÉS (mensaje + referral del anuncio) ===
    const referralText = [message.referral?.headline, message.referral?.body, message.referral?.source_url].filter(Boolean).join(' ');
    let detected = detectProduct(userText) || detectByPrice(userText) || (referralText ? detectProduct(referralText) : null);
    if (detected) {
      try {
        const redis = getRedis();
        if (redis) await redis.set(`interes:${userId}`, detected, { ex: 60 * 60 * 24 * 7 });
      } catch (e) { console.error('interes flag error:', e.message); }
    }
    // Producto de interés vigente (para fotos y contexto).
    // Prioridad: nombre explícito en este mensaje > contexto guardado > detección débil.
    let interesKey = detected;
    if (!interesKey) {
      try {
        const redis = getRedis();
        if (redis) {
          const saved = await redis.get(`interes:${userId}`);
          if (saved && CATALOG[saved]) interesKey = saved;
        }
      } catch (e) { /* noop */ }
    }
    if (!interesKey) {
      const weak = detectProductWeak(userText) || (referralText ? detectProductWeak(referralText) : null);
      if (weak) {
        interesKey = weak;
        try {
          const redis = getRedis();
          if (redis) await redis.set(`interes:${userId}`, weak, { ex: 60 * 60 * 24 * 7 });
        } catch (e) { /* noop */ }
      }
    }

    // === SALUDO DETERMINÍSTICO en conversación nueva ===
    // Cubre: presets genéricos ("Quiero más información"), botón del sitio, y presets
    // con producto ("¡Hola! Quiero una mesa portátil...") — cualquier primer mensaje
    // corto que empiece con hola y nombre un producto del catálogo.
    const presetConProducto = detected && /^¡?hola/i.test(userText) && userText.length < 80;
    if (history.length === 0 && (QUICK_REPLY_RX.test(userText) || PRODUCT_CLICK_RX.test(userText) || presetConProducto)) {
      let greeting;
      if (productoAdmin) {
        greeting = greetingFromProduct(productoAdmin);
      } else if (interesKey) {
        greeting = greetingForCatalogProduct(interesKey);
      } else {
        greeting = GREETING_GENERIC;
      }
      history.push({ role: 'user', content: userText, ts: Date.now() });
      history.push({ role: 'assistant', content: greeting, ts: Date.now() });
      await saveHistory(userId, history);
      // Enganche visual: si sabemos el producto, las fotos van ANTES del saludo
      // (el texto con precio + pregunta de cierre queda al final, listo para responder)
      try {
        if (productoAdmin || interesKey) {
          const sent = await sendProductPhotos(userId, interesKey, productoAdmin, '');
          if (sent > 0) {
            const redis = getRedis();
            if (redis) await redis.set(`fotos:${userId}`, '1', { ex: 60 * 60 * 24 });
          }
        }
      } catch (e) { console.error('[saludo-fotos] error:', e.message); }
      await sendHumanReply(userId, greeting);
      console.log(`[saludo] determinístico para ${userId} (producto: ${interesKey || 'genérico'})`);
      return { statusCode: 200, body: 'OK' };
    }

    // === ESCAPE DE LOOP ===
    const prevUserTexts = history.filter(m => m.role === 'user').slice(-2).map(m => (m.content || '').trim().toLowerCase());
    const curText = userText.trim().toLowerCase();
    const looping = prevUserTexts.length === 2 && (
      (prevUserTexts[0] === curText && prevUserTexts[1] === curText) ||
      (isLowContent(userText) && prevUserTexts.every(isLowContent))
    );
    if (looping) {
      const loopReply = 'Cuando quieras seguir con tu pedido, aquí estoy 💜';
      history.push({ role: 'user', content: userText, ts: Date.now() });
      history.push({ role: 'assistant', content: loopReply, ts: Date.now() });
      await saveHistory(userId, history);
      await sendHumanReply(userId, loopReply);
      console.log(`[loop] escape activado para ${userId}`);
      return { statusCode: 200, body: 'OK' };
    }

    history.push({ role: 'user', content: userText, ts: Date.now() });

    // === FOTOS: si las pide (o quedó pendiente de decir el producto), enviarlas YA ===
    let photosSentNow = 0;
    let photoPending = false;
    try {
      const redis = getRedis();
      const pendingFlag = redis ? await redis.get(`fotos_pend:${userId}`) : null;
      let wantsPhotos = PHOTO_REQ_RX.test(userText) || !!pendingFlag;
      // ENGANCHE VISUAL (28-jul): en los primeros mensajes de la conversación,
      // si ya sabemos qué producto le interesa y aún no ha recibido fotos,
      // se le mandan SIN esperar a que las pida — ver el producto vende más
      // que leerlo. (El saludo determinístico ya lo hacía; esto lo extiende
      // a cualquier primer contacto: "precio del masajeador", "info de la mesa", etc.)
      if (!wantsPhotos && (detected || interesKey || productoAdmin)) {
        const nMsgsCliente = history.filter(m => m.role === 'user').length;
        if (nMsgsCliente <= 2) {
          const yaFotos = redis ? await redis.get(`fotos:${userId}`) : null;
          if (!yaFotos) wantsPhotos = true;
        }
      }
      if (wantsPhotos) {
        // Nombre explícito en ESTE mensaje > producto en contexto (nunca al revés)
        const key = productoAdmin ? null : (detected || interesKey);
        if (productoAdmin || key) {
          photosSentNow = await sendProductPhotos(userId, key, productoAdmin, userText);
          if (redis) {
            if (photosSentNow > 0) await redis.set(`fotos:${userId}`, '1', { ex: 60 * 60 * 24 });
            await redis.del(`fotos_pend:${userId}`);
          }
        } else {
          // Pidió fotos pero no sabemos de qué producto → recordarlo para el próximo mensaje
          photoPending = true;
          if (redis) await redis.set(`fotos_pend:${userId}`, '1', { ex: 60 * 10 });
        }
      }
    } catch (e) { console.error('[fotos] error:', e.message); }

    const trimmedForClaude = history.slice(-16).map(m => ({ role: m.role, content: m.content }));

    let stateNotes = await buildStateNotes(userId);
    // El bot SIEMPRE sabe desde qué número escribe el cliente — así confirma el
    // teléfono directo ("¿Te contactamos al +502 XXXX-XXXX?") en vez de pedir
    // que escriba "este mismo" (28-jul: el equipo necesita ver el número real).
    const telBonito = (userId.startsWith('502') && userId.length === 11)
      ? `+502 ${userId.slice(3, 7)}-${userId.slice(7)}`
      : `+${userId}`;
    stateNotes = (stateNotes ? stateNotes + '\n' : '') +
      `- El WhatsApp desde el que escribe el cliente es ${telBonito}. Al confirmar el teléfono de contacto preguntá: "¿Te contactamos al ${telBonito} o prefieres otro número?" — NUNCA le pidas que escriba "este mismo". Si confirma, usá ${telBonito} como teléfono en el marcador del pedido.`;
    if (photosSentNow > 0) {
      stateNotes = (stateNotes ? stateNotes + '\n' : '') +
        `- El sistema ACABA de enviarle ${photosSentNow} fotos en este momento. El cliente ya las tiene. NO digas que no puedes mandar fotos. Comentalas breve y seguí con el cierre.`;
    }
    if (photoPending) {
      stateNotes = (stateNotes ? stateNotes + '\n' : '') +
        `- El cliente pidió fotos pero no sé de QUÉ producto. Preguntale de cuál (en cuanto lo diga, el sistema las envía automáticamente).`;
    }

    // 🚨 RECLAMO POSTVENTA → humano de inmediato (análisis 27-jul: un cliente con
    // producto defectuoso escribió 7 veces y el bot lo paseó con respuestas genéricas)
    const RECLAMO_RX = /no (me )?(sirve|funciona)|lleg[oó] (quebrad|dañad|rot|mal)|(vino|sali[oó]) (rot[oa]|dañad[oa]|defectuos[oa]|mal)|defectuos|reclamo|no tengo respuesta|nadie (me )?(responde|contesta)|quiero (mi )?(reembolso|devoluci[oó]n)|devolverl[oa]|mala calidad|me (estafaron|engañaron)/i;
    const esReclamo = RECLAMO_RX.test(userText);
    if (esReclamo) {
      stateNotes = (stateNotes ? stateNotes + '\n' : '') +
        '- ⚠️ RECLAMO POSTVENTA: el cliente reporta un problema con un producto ya entregado. Discúlpate con calidez UNA sola vez, dile que YA lo conectaste con el equipo humano y que le escriben en breve por este mismo chat. NO vendas nada, NO des instrucciones genéricas, NO le pidas repetir el problema.';
    }

    const basePrompt = productoAdmin ? buildCustomPrompt(productoAdmin) : SYSTEM_PROMPT;
    const systemPrompt = stateNotes
      ? basePrompt + '\n\n# ESTADO ACTUAL DE ESTA CONVERSACIÓN (generado por el sistema — obedecé esto)\n' + stateNotes
      : basePrompt;

    const rawReply = await callClaude(trimmedForClaude, systemPrompt);

    const orderMatch = rawReply.match(/\[PEDIDO:([^|\]]+)\|([^|\]]+)\|([^|\]]+)\|([^\]]+)\]/i);
    const hotMatch = rawReply.match(/\[HOT_PEDIDO:([^\]]+)\]/i);

    console.log('PEDIDO detection:', {
      hasMarker: rawReply.includes('[PEDIDO:'),
      orderMatch: orderMatch ? orderMatch[0] : null,
      hotMatch: hotMatch ? hotMatch[0] : null,
      interes: interesKey,
      lastChars: rawReply.slice(-200)
    });

    const cleanReply = rawReply
      .replace(/\[PEDIDO:[^\]]+\]\s*/gi, '')
      .replace(/\[HOT_PEDIDO:[^\]]+\]\s*/gi, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')   // sin **negritas** — WhatsApp muestra los asteriscos
      .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$|[.,;!?])/g, '$1$2')
      .trim() ||
      'Disculpa, no pude generar respuesta. ¿Lo intentas de nuevo?';

    history.push({ role: 'assistant', content: cleanReply, ts: Date.now() });
    await saveHistory(userId, history);

    await sendHumanReply(userId, cleanReply);

    // Contador de intentos de captura (alimenta el bloque ESTADO)
    try {
      if (!orderMatch && /nombre completo|n[uú]mero de tel[eé]fono|direcci[oó]n exacta|a qu[eé] n[uú]mero te contactamos|te contactamos al/i.test(cleanReply)) {
        const redis = getRedis();
        if (redis) {
          const n = await redis.incr(`asked_datos:${userId}`);
          await redis.expire(`asked_datos:${userId}`, 60 * 60 * 24 * 7);
          console.log(`[estado] asked_datos:${userId} = ${n}`);
        }
      }
    } catch (e) { console.error('asked_datos counter error:', e.message); }

    // 🔥 CLIENTE CALIENTE
    if (hotMatch) {
      const signal = hotMatch[1].trim();
      console.log('🔥 HOT PEDIDO detected:', signal, 'for', userId);
      try {
        await notifyHotPedido(userId, signal, history);
      } catch (e) {
        console.error('[HOT_PEDIDO] Notification error:', e.message);
      }
    }

    // 🛒 PEDIDO cerrado
    if (orderMatch) {
      const structuredData = {
        producto: orderMatch[1].trim(),
        nombre: orderMatch[2].trim(),
        // "el mismo" / "mismo-whatsapp" / variantes → número real de WhatsApp del cliente
        telefono: resolveTelefono(orderMatch[3], userId),
        direccion: orderMatch[4].trim()
      };
      console.log('Captured order:', structuredData);
      await captureOrder(userId, history, structuredData);
    }

    // 🚨 RECLAMO → alerta al equipo (además de la respuesta empática del bot)
    if (esReclamo) {
      try {
        await notifyHotPedido(userId, 'RECLAMO POSTVENTA: el cliente reporta un problema con un producto entregado — intervenir de inmediato desde el panel', history);
      } catch (e) { console.error('[reclamo] notification error:', e.message); }
    }

    // 🔔 PROMESA DE CONFIRMACIÓN: el bot dijo "eso lo confirmo con el equipo" —
    // avisar al equipo para que ALGUIEN responda esa duda de verdad (análisis 27-jul:
    // los clientes quedaban esperando esa confirmación que nunca llegaba y se enfriaban).
    if (!orderMatch && !hotMatch && !esReclamo &&
        /(confirm[oa]r?|consult[oa]r?|revis[oa]r?|pregunt[oa]r?)\s+(eso\s+|esa\s+|ese\s+|lo\s+|esto\s+)?(detalle\s+)?(con el|al)\s+equipo|equipo.{0,30}te (dice|confirma|escribe)|te (confirmo|digo) (eso )?(en breve|ahora mismo|al rato)/i.test(cleanReply)) {
      try {
        await notifyHotPedido(userId, 'DUDA PENDIENTE: el bot prometió confirmar algo con el equipo — leer el chat y responderle al cliente YA (desde el panel)', history);
      } catch (e) { console.error('[promesa-equipo] notification error:', e.message); }
    }

    // 🛡️ GUARDIA ANTI-PEDIDO-PERDIDO
    if (!orderMatch && /pedido (qued[oó]|est[aá]) (confirmado|listo|cerrado)|equipo (coordina|te contacta para) la entrega/i.test(cleanReply)) {
      console.error(`🛡️ [guard] ${userId}: anuncio de pedido SIN marcador [PEDIDO:...] — notificando al equipo como respaldo`);
      try {
        await notifyHotPedido(userId, 'GUARDIA: el bot anunció pedido cerrado pero no emitió marcador — revisar conversación y contactar', history);
      } catch (e) { console.error('[guard] notification error:', e.message); }
    }

    return { statusCode: 200, body: 'OK' };
  } catch (e) {
    console.error('Webhook error:', e);
    return { statusCode: 200, body: 'OK' };
  }
};
