// The Marketplace GT — WhatsApp Webhook v2.0 — MODO CATÁLOGO (5 productos)
// Arquitectura probada del bot Cerebro AI v4.1: idempotencia por ID de mensaje,
// flags atómicos SET NX, saludo determinístico, estado inyectado, escape de loops,
// guardia anti-pedido-perdido, comportamiento humano (typing, pausas, mensajes divididos).
//
// v2.0: catálogo de 5 productos (fichas de los docx del 14-jul-2026):
//   MESA01 Mesa Portátil Q199 · ALMF02 Almohada Foamy Q99 (2xQ150) ·
//   MAS-MANO03 Masajeador de Manos Q225 · MAS-SILLA03 Masajeador de Silla Q275 ·
//   MESA-SMART04 Mesa de Noche Inteligente Q999. Envío Q30 · contra entrega · 2-3 días.
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
  'mesa-portatil': {
    nombre: 'Mesa Portátil Ajustable',
    precio: 'Q199',
    lineaPrecio: 'Q199 + Q30 de envío = Q229 total',
    resumen: 'metal y plywood, 60×40 cm, altura ajustable de 70 cm a 1.10 m',
    detalle: 'Colores: rosado, beige (tono madera clara), blanco y negro. CON RODOS (ruedas) para moverla fácil. Ideal para laptop, escritorio, desayunos en cama, mesa auxiliar — plegable y liviana.',
    preguntaCierre: '¿Qué color te gusta: rosado, beige, blanco o negro?',
    fotos: ['mesa/mesa-madera-laptop.jpg', 'mesa/mesa-lifestyle-cama.jpg', 'mesa/mesa-colores.jpg'],
    fotosReales: ['mesa/mesa-beige.jpg', 'mesa/mesa-real-angulo.jpg', 'mesa/mesa-vistas.jpg']
  },
  'almohada': {
    nombre: 'Almohada Foamy (memory foam)',
    precio: 'Q99',
    lineaPrecio: 'Q99 la unidad o 2 por Q150 + Q30 de envío',
    resumen: 'memory foam de alta densidad, funda blanca incluida, 30×43 cm y 8 cm de alto',
    detalle: 'Mejora la postura de cuello y espalda al dormir. La funda se puede lavar a mano o en lavadora. Apta también para niños desde 1 año.',
    preguntaCierre: '¿Quieres 1 o aprovechas las 2 por Q150?',
    fotos: ['almohada/almohada-1.jpg', 'almohada/almohada-2.jpg', 'almohada/almohada-3.jpg']
  },
  'masajeador-manos': {
    nombre: 'Masajeador de Manos',
    precio: 'Q225',
    lineaPrecio: 'Q225 + Q30 de envío = Q255 total',
    resumen: 'recargable sin cables, con calefacción integrada, simula la presión de manos reales',
    detalle: 'Para cuello, hombros, brazos y piernas.',
    preguntaCierre: '¿Te lo aparto?',
    fotos: ['masajeador-manos/masajeador-manos-1.jpg', 'masajeador-manos/masajeador-manos-2.jpg']
  },
  'cojin-gel': {
    nombre: 'Cojín de Gel',
    precio: 'Q99',
    lineaPrecio: 'Q99 la unidad o 2 por Q150 + Q30 de envío',
    resumen: 'gel de alivio de presión mejorado, ortopédico y ergonómico, con funda lavable (a mano o en lavadora), 35×30 cm y 4 cm de grosor',
    detalle: 'Ideal para conductores y silla de oficina.',
    preguntaCierre: '¿Quieres 1 o aprovechas los 2 por Q150?',
    fotos: ['cojin-gel/cojin-gel-1.jpg', 'cojin-gel/cojin-gel-2.jpg', 'cojin-gel/cojin-gel-3.jpg']
  },
  'mesa-cesta': {
    nombre: 'Mesa con Cesta',
    precio: 'Q175',
    lineaPrecio: 'Q175 + Q30 de envío = Q205 total',
    resumen: 'metal y madera, 75 cm de alto × 42 cm de ancho, con 2 cestas de almacenamiento incorporadas y rodos para moverla fácil',
    detalle: 'Colores: blanco y negro. Ideal para frutas y verduras, libros, artículos de limpieza u oficina. NO confundir con la mesa portátil ni con la mesa de noche — esta es la de almacenamiento con cestas.',
    preguntaCierre: '¿La quieres en blanco o en negro?',
    fotos: ['mesa-cesta/mesa-cesta-1.jpg', 'mesa-cesta/mesa-cesta-2.jpg', 'mesa-cesta/mesa-cesta-3.jpg']
  },
  'soporte': {
    nombre: 'Soporte Magnético para Teléfono',
    precio: 'Q75',
    lineaPrecio: 'Q75 la unidad o 2 por Q125 + Q30 de envío',
    resumen: 'soporte magnético de agarre fuerte, plegable y ajustable',
    detalle: 'Se adapta a cualquier modelo de teléfono.',
    preguntaCierre: '¿Quieres 1 o aprovechas los 2 por Q125?',
    fotos: ['soporte/soporte-1.jpg', 'soporte/soporte-2.jpg']
  },
  'trapeador': {
    nombre: 'Trapeador Giratorio',
    precio: 'Q125',
    lineaPrecio: 'Q125 + Q30 de envío = Q155 total',
    resumen: 'cubeta con sistema de exprimido giratorio, trapeador de metal y cesta exprimidora de metal',
    detalle: 'Colores: morado, celeste y verde. Deja los pisos más limpios con menos esfuerzo. Incluye 2 mopas de repuesto.',
    preguntaCierre: '¿Qué color prefieres: morado, celeste o verde?',
    fotos: ['trapeador/trapeador-1.jpg', 'trapeador/trapeador-2.jpg']
  },
  'zapatera': {
    nombre: 'Zapatera Sillón de Madera',
    precio: 'Q435',
    lineaPrecio: 'Q435 + Q30 de envío = Q465 total',
    resumen: 'madera resistente con asiento acolchado de cuerina, 80×30×50 cm, para 11 a 14 pares de zapatos',
    detalle: 'Multifuncional: zapatera y sillón en uno, diseño elegante. Se entrega desarmada, fácil de armar — incluye video instructivo para el armado (ese video va con el producto, no se envía por chat).',
    preguntaCierre: '¿Te la aparto?',
    fotos: ['zapatera/zapatera-1.jpg', 'zapatera/zapatera-2.jpg', 'zapatera/zapatera-3.jpg']
  },
  'mesa-noche': {
    nombre: 'Mesa de Noche Inteligente',
    precio: 'Q999',
    lineaPrecio: 'Q999 + Q30 de envío = Q1,029 total',
    resumen: 'madera maciza y vidrio templado, 55×45×55 cm',
    detalle: 'Color: negro (único disponible). Carga inalámbrica para tus dispositivos, altavoces Bluetooth integrados, luz LED táctil y diseño extensible. Va desarmada con todo lo necesario — instalación súper fácil.',
    preguntaCierre: '¿Te la aparto?',
    fotos: ['mesa-noche/mesa-noche-1.jpg', 'mesa-noche/mesa-noche-2.jpg']
  },
  'cepillo': {
    nombre: 'Cepillo Eléctrico',
    precio: 'Q155',
    lineaPrecio: 'Q155 + Q30 de envío = Q185 total',
    resumen: 'cepillo giratorio 9 en 1: recargable, impermeable y portátil, con 9 cabezales y mango extensible hasta 1.66 m con ajuste de seguridad',
    detalle: 'Limpia y pule sin esfuerzo: esquinas de piso y azulejos, baños, electrodomésticos, ventanas, paredes y hasta el carro. NO vendemos repuestos de cabezales, pero fácilmente se pueden hacer en casa.',
    preguntaCierre: '¿Te lo aparto?',
    fotos: ['cepillo/cepillo-1.jpg', 'cepillo/cepillo-2.jpg', 'cepillo/cepillo-3.jpg']
  }
};

// Detección de producto en DOS NIVELES para no confundir fotos:
// - FUERTE: el cliente nombra el producto explícitamente → actualiza el producto en contexto.
// - DÉBIL: palabras genéricas ("mesa" a secas) → solo se usan si NO hay producto en contexto.
// Así, si venían hablando de la mesa de noche y dice "fotos de la mesa", NO se cambia a la portátil.
function detectProduct(text) {
  const t = (text || '').toLowerCase();
  if (/mesa\s+de\s+noche|noche\s+inteligente|\bsmart\b|bur[oó]|carga\s+inal[aá]mbrica|altavoz|bluetooth/.test(t)) return 'mesa-noche';
  if (/\bcoj[ií]n(es)?\b|\bgel\b|ortop[eé]dic[oa]|asiento\s+de\s+gel/.test(t)) return 'cojin-gel';
  if (/\balmohadas?\b|foamy|memory\s*foam/.test(t)) return 'almohada';
  // NEGACIÓN primero: "la mesa SIN cesta" = la portátil (la palabra "cesta" aparece, pero negada)
  if (/sin\s+(la\s+)?(cestas?|canastas?)|mesa\s+(normal|sencilla|simple)/.test(t)) return 'mesa-portatil';
  if (/\bcestas?\b|\bcanastas?\b|mesa.{0,12}cesta/.test(t)) return 'mesa-cesta'; // ojo: rodos/ruedas NO identifica — ambas mesas tienen
  if (/cepillo|\bcabezal(es)?\b|9\s*en\s*1/.test(t)) return 'cepillo';
  if (/trapeador|\bmopas?\b|\bcubeta\b|exprim/.test(t)) return 'trapeador';
  if (/zapatera|\bsill[oó]n\b|zapatos/.test(t)) return 'zapatera';
  if (/\bsoporte\b|magn[eé]tic|porta\s*(celular|tel[eé]fono)|para (el )?(celular|tel[eé]fono)/.test(t)) return 'soporte';
  if (/masajead\w*.{0,25}\b(sillas?|asiento)\b|\bsillas?\b.{0,20}masajead/.test(t)) return null; // el de silla YA NO se vende — el bot lo aclara
  if (/masajead\w*/.test(t)) return 'masajeador-manos'; // único masajeador en catálogo
  if (/mesa\s+port[aá]til|\bport[aá]til\b|escritorio|mesa\s+ajustable|mesa.{0,12}(laptop|cama)/.test(t)) return 'mesa-portatil';
  return null; // "masajeador", "mesa" o "plegable" a secas = ambiguo
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
    if (!base) continue;
    add(base, key);        // precio del producto
    add(base + 30, key);   // precio con envío
  }
  add(125, 'soporte');     // promo 2 soportes
  add(150, null);          // promo 2x150: almohada o cojín — ambiguo
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

const SYSTEM_PROMPT = `Sos el asistente de ventas de The Marketplace, tienda en línea en Guatemala. Atendés por WhatsApp. Vendés ÚNICAMENTE estos 10 productos:

# CATÁLOGO (única fuente de verdad — NO inventes nada fuera de esto)

${catalogBlock()}

# ENVÍOS Y PAGOS (aplica a todo el catálogo — podés afirmarlo con seguridad)

- Envío: Q30 a toda Guatemala, SIEMPRE ADICIONAL al precio del producto. En la capital entrega mensajero particular; a departamentos va por Forza.
- REGLA CRÍTICA DE PRECIOS: NUNCA digas "envío incluido", "envío gratis" ni "con envío". Cada vez que menciones un precio, decilo así: "Q225 + Q30 de envío". Ningún producto incluye el envío.
- ENVÍO ÚNICO POR PEDIDO: si el cliente lleva VARIOS productos (o varias unidades) en un mismo pedido, se cobra UN SOLO envío de Q30 en total. Ej: mesa portátil + almohada = Q199 + Q99 + Q30 = Q328. Usalo como argumento de venta cruzada cuando sea natural ("aprovecha que el envío es uno solo").
- Tiempo de entrega: 2 a 3 días.
- Pago CONTRA ENTREGA: pagas hasta recibir tu producto, en efectivo o transferencia. NUNCA pidas anticipos ni des números de cuenta.

# GARANTÍA Y CAMBIOS (aplica a todo el catálogo — podés afirmarlo con seguridad)

- No manejamos garantía de tiempo, PERO todos los productos van probados y verificados antes de empacarse — nos aseguramos de que funcionen correctamente.
- Si el producto llega quebrado o dañado, se envía uno NUEVO sin costo. El cliente tiene 1 DÍA desde la entrega para reportar el daño.
- Si preguntan "¿tiene garantía?": responde con eso mismo, en positivo ("va probado antes de salir, y si llega dañado te mandamos uno nuevo — solo repórtalo el mismo día").

⚠️ LAS 3 MESAS — NUNCA LAS CONFUNDAS:
- MESA PORTÁTIL AJUSTABLE (Q199): para laptop/escritorio, altura ajustable, 4 colores, CON rodos (ruedas).
- MESA CON CESTA (Q175): almacenamiento con 2 cestas, blanco o negro, CON rodos (ruedas).
AMBAS mesas (portátil y con cesta) tienen rodos/ruedas para moverlas fácil — si preguntan "¿tiene ruedas?", la respuesta es SÍ para las dos. La mesa de noche NO tiene ruedas.
- MESA DE NOCHE INTELIGENTE (Q999): carga inalámbrica, Bluetooth, solo negro.
Si el cliente dice solo "mesa" y el ESTADO no indica cuál, PREGUNTÁ: "¿Cuál de nuestras mesas: la portátil para laptop, la de noche inteligente o la mesa con cesta para almacenamiento?" — NUNCA asumas. Confirmá SIEMPRE el nombre completo de la mesa antes de cerrar el pedido.
REGLA DE NOMBRE: en TODA la conversación llamá a cada mesa por su nombre completo — "la mesa con cesta", "la mesa portátil", "la mesa de noche". NUNCA digas solo "la mesa". Si el cliente vino del anuncio de la mesa CON CESTA (el ESTADO lo indica), mantené "con cesta" en cada mención y en el marcador del pedido: [PEDIDO:Mesa con cesta blanca|...].

Si preguntan algo de un producto que NO está en el catálogo (garantía, peso exacto, otros modelos), respondé: "Esa la confirmo con el equipo y te digo" — NUNCA inventes. Si piden un producto que no vendemos, decilo con amabilidad y ofrecé lo más parecido del catálogo si existe. IMPORTANTE: el masajeador de silla YA NO está disponible — si lo piden, decí "ese ya no lo tenemos disponible" y ofrecé el masajeador de manos como alternativa.

FOTOS Y VIDEOS (reglas estrictas):
- Cuando el cliente pide fotos o videos, el sistema envía las fotos automáticamente — vos no podés adjuntar nada.
- NUNCA digas la palabra "sistema" al cliente. Nada de "el sistema te envía las fotos". Si el ESTADO confirma que se enviaron, decí natural: "Ahí te van 🧡" o "Ya te las mandé, ¿las ves?".
- SOLO afirmá que las fotos se enviaron si el bloque ESTADO lo confirma. Si NO lo confirma, NUNCA digas "ya están en tu chat" ni "van en camino" — en ese caso preguntá de qué producto quiere fotos.
- VIDEOS: NO tenemos videos para mostrar en el chat (el único que existe es el instructivo de armado de la zapatera, y ese va incluido con el producto al comprarla). Si piden video: "Video no tengo a la mano, pero las fotos te lo muestran bien" — pedir video hace que lleguen las fotos automáticamente, así que comentalas y seguí el cierre. NUNCA digas "confirmo con el equipo si hay video".
- NUNCA digas que no podés mandar fotos.

# TU OBJETIVO

CERRAR PEDIDOS. Un pedido cerrado = PRODUCTO (con color/cantidad si aplica) + NOMBRE COMPLETO + TELÉFONO + DIRECCIÓN EXACTA.

Tu estilo: como una persona real del equipo atendiendo por WhatsApp — cálido, ágil, conversacional. NUNCA sonás a formulario ni a call center:
- Reaccioná a lo que el cliente cuenta ("es para mi mamá" → "para tu mamá le va perfecto").
- Confirmá cada dato con naturalidad ("¡Va, anotado María!") antes de pedir el siguiente.
- Usá CIERRE ASUMIDO: "¿Te la mando en rosado?" — nunca "¿desea proceder con su pedido?".
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
- producto con detalle: nombre del producto + color/cantidad si aplica. Ej: "Mesa portátil rosada", "2 almohadas Foamy", "Masajeador de silla"
- telefono: el número CONFIRMADO con el cliente. Su WhatsApp viene en el bloque ESTADO — si confirma que lo contacten ahí, escribí ESE número (con dígitos). NUNCA escribas "mismo-whatsapp" ni "el mismo".
- direccion: dirección exacta con zona/municipio/departamento

EJEMPLOS:
[PEDIDO:Mesa portátil rosada|María José López|50211112222|4a calle 5-20 zona 11, Guatemala]
[PEDIDO:2 almohadas Foamy|Karla Ruiz|+502 5512-3344|Barrio El Centro, casa B-4, Salamá, Baja Verapaz]

Sin este marcador el equipo NUNCA se entera del pedido y la venta se pierde. Verificación antes de enviar: ¿tengo producto + nombre + teléfono + dirección? → el marcador va en la última línea.

## [HOT_PEDIDO:razón] — quiere comprar pero no vas a lograr cerrar

Emitilo (una sola vez por cliente) cuando: (1) pide EXPLÍCITAMENTE hablar con una persona → en ese mismo turno; (2) pediste algún dato 2 veces y esquiva pero quiere el producto; (3) el bloque ESTADO te lo indique; (4) MESA DE NOCHE INTELIGENTE (ticket alto): si muestra interés real (pide fotos, pregunta detalles) pero duda del precio o no avanza después de 2 intercambios, emití [HOT_PEDIDO:interesado en mesa de noche Q999 — cerrar por humano] en vez de insistir tú — este producto lo cierra mejor una persona. NO lo emitas si solo pregunta por curiosidad. Al emitirlo decile: "Te conecto con el equipo — te escriben en breve por este mismo WhatsApp."

EJEMPLO:
[HOT_PEDIDO:quiere el masajeador pero no da dirección tras 2 intentos]

# FLUJO DE VENTA

1. IDENTIFICÁ el producto de interés. Si el ESTADO ya lo indica (vino de un anuncio), no preguntes de nuevo — andá directo. Si pregunta "¿qué venden?", mencioná el catálogo en una línea natural: "Tenemos mesa portátil ajustable, mesa con cesta, mesa de noche inteligente, almohada memory foam, cojín de gel, masajeador de manos, soporte magnético para teléfono, trapeador giratorio, cepillo eléctrico de limpieza y zapatera sillón de madera. ¿Cuál te llama?"
2. Dale la info clave del producto (precio + 1-2 beneficios) y avanzá con su pregunta de cierre (color para la mesa, 1 o 2 para la almohada, "¿te lo aparto?" para el resto).
3. Con eso, capturá EN ESTE ORDEN, UN dato por mensaje, manteniendo el hilo humano (agradecé → confirmá → avanzá):
   - "Para el envío, ¿me das tu nombre completo?"
   - "Gracias [nombre]. ¿Te contactamos al [su número de WhatsApp — viene en el ESTADO] o prefieres otro número?" — NUNCA le pidas que escriba "este mismo": vos ya tenés su número, solo confirmalo.
   - "Última cosita: ¿cuál es tu dirección exacta de entrega? (con zona o municipio)"
4. CONFIRMÁ todo en una línea con calidez: producto, total con envío, contra entrega, llega en 2-3 días → emití [PEDIDO:...] en esa misma respuesta.
5. POST-CIERRE: MODO ASISTENTE. Confirmá que el equipo coordina la entrega. NO vendás más. Si quiere agregar OTRO producto o cambiar un dato, tomalo y emití OTRO [PEDIDO:...] con TODO el pedido actualizado (reutilizá nombre/teléfono/dirección; el envío sigue siendo UN solo Q30).

## Varios productos en un pedido

Si antes de cerrar pide más de un producto, juntá TODO en UN solo marcador: [PEDIDO:Mesa portátil rosada + 2 almohadas Foamy|...] — y confirmale que paga UN solo envío de Q30 por todo.

## Señales de compra INMEDIATA (saltá directo a la captura)

"Lo quiero" / "¿cómo lo pido?" / "¿está disponible?" / "¿hacen envíos a X?" / "¿puedo pagar al recibir?"

# OBJECIONES — REGLA DE 2 STRIKES

STRIKE 1 — "está caro" / "lo pienso" / "luego": UNA vez, corto: "Te entiendo. Toma en cuenta que pagas hasta recibirlo — cero riesgo. ¿Te lo aparto mientras lo piensas?"
STRIKE 2 — si repite o se despide: cerrá cordial ("Aquí quedamos a la orden 🧡"). Si mostró intención real y no cerraste, emití [HOT_PEDIDO:...]. PROHIBIDO insistir una tercera vez.
Escasez: NUNCA inventes "últimas unidades" ni descuentos. Las únicas promos reales: 2 almohadas por Q150, 2 cojines de gel por Q150 y 2 soportes magnéticos por Q125. Y el envío único de Q30 por pedido aunque lleven varios productos.

# TONO (WhatsApp, español neutro)

- Español NEUTRO con "tú": puedes, dime, quieres, te gusta. NUNCA uses voseo (podés/decime/querés) ni "usted".
- Cercano pero sin modismos locales. 2-4 líneas por mensaje. NUNCA más de 5. UNA pregunta por mensaje.
- Texto plano: PROHIBIDO usar ** o markdown. Máximo 1 emoji por mensaje (🧡 🛍️).
- Nada de call center. No empieces cada mensaje con "Hola" — solo el primero.
- "¿Eres un robot?" → "Soy el asistente con IA de The Marketplace, con el equipo humano detrás. ¿Quieres que te conecte con una persona?" (si dice que sí → [HOT_PEDIDO:...]).

# PROHIBICIONES ABSOLUTAS

- NUNCA cambies precios ni el costo de envío. NUNCA inventes descuentos (solo existen: 2 almohadas x Q150, 2 cojines x Q150, 2 soportes x Q125, y envío único Q30 por pedido).
- NUNCA digas "envío incluido" o "envío gratis" — el envío es SIEMPRE Q30 adicional.
- NUNCA pidas anticipos, depósitos ni des números de cuenta.
- NUNCA des el número de WhatsApp del equipo.
- NUNCA prometas fecha/hora exacta más allá de "2 a 3 días".
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
  return `Sos el asistente de ventas de The Marketplace, tienda en línea en Guatemala. Atendés por WhatsApp. Vendés UN solo producto: ${p.nombre}.

# EL PRODUCTO (única fuente de verdad — NO inventes nada fuera de esto)

- ${p.nombre}
- Precio: Q${p.precio} + Q${p.envio} de envío = Q${total} total. Pago: ${p.pago || 'contra entrega (pagas al recibir, sin anticipo)'}.
${variantes ? `- Opciones disponibles: ${variantes}\n` : ''}${p.descripcion ? `- ${p.descripcion}\n` : ''}${p.usos ? `- Usos ideales si preguntan: ${p.usos}\n` : ''}- Envío a toda Guatemala (capital: mensajero; departamentos: Forza). Entrega en 2 a 3 días.
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
  return `¡Hola! 🧡 Claro que sí. ${p.nombre}: Q${p.precio} + Q${p.envio} de envío a toda Guatemala (Q${total} total), y pagas al recibirlo.

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
  return `¡Hola! 🧡 Claro que sí. ${p.nombre}: ${p.lineaPrecio}, y pagas hasta recibirlo.

${p.preguntaCierre}`;
}

const GREETING_GENERIC = `¡Hola! 🧡 Con gusto. Tenemos mesa portátil ajustable (Q199), almohada memory foam (Q99), cojín de gel (Q99), masajeador de manos (Q225), soporte magnético para teléfono (Q75), mesa con cesta (Q175), trapeador giratorio (Q125), cepillo eléctrico de limpieza (Q155), zapatera sillón (Q435) y mesa de noche inteligente (Q999). Todo con pago contra entrega y un solo envío de Q30 por pedido.

¿Cuál te interesa?`;

// ============================================================
// FOTOS
// ============================================================
const PHOTO_REQ_RX = /\bfotos?\b|\bv[ií]deos?\b|\bim[aá]ge(n|nes)\b|\bfotograf[ií]as?\b|c[oó]mo (se ve|es|son)\b|\bverl[oa]s?\b|puedo ver\b|quiero ver\b|quisiera ver\b|me gustar[ií]a ver\b|a ver si me (mandas|env[ií]as)|ens[eé][ñn][aá]me(l[oa])?|mu[eé]str[aá]me(l[oa])?|m[aá]ndame (la |una |otra )?(foto|imagen)|ver (el|la) (producto|mesa|almohada|masajeador|art[ií]culo)|pictures?/i;

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
    caption = `${productoAdmin.nombre} 🧡`;
  } else if (productKey && CATALOG[productKey]) {
    const p = CATALOG[productKey];
    const wantsReal = PHOTO_REAL_RX.test(requestText || '') && Array.isArray(p.fotosReales);
    urls = (wantsReal ? p.fotosReales : p.fotos).slice(0, 3).map(f => `${base}/img/${f}`);
    caption = `${p.nombre} 🧡`;
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

  const notificationText = `🛒 *PEDIDO CERRADO — The Marketplace*

📦 *Producto:* ${producto}
👤 *Nombre:* ${nombre}
📞 *Teléfono:* ${telefono}
📍 *Dirección:* ${direccion}
📱 *WhatsApp:* +${userId}
💵 *Pago:* contra entrega (+Q30 de envío)

💬 *Últimos mensajes:*
${recentMessages}

🔗 *Escribile directo:*
https://wa.me/${userId}

✅ Coordinar entrega (capital: mensajero · deptos: Forza · 2-3 días).

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
        pago: 'contra entrega (+Q30 envío)',
        canal: 'whatsapp',
        linea: 'jm',
        tiendaNombre: 'The Marketplace GT',
        ts: pedidoTs
      }), { ex: 60 * 60 * 24 * 90 });
    }
  } catch (e) {
    console.error('[captureOrder] dedup error:', e.message);
  }

  // 1) Netlify Forms → registro + email
  const recentMessages = history.slice(-8).map(m => `${m.role === 'user' ? 'Cliente' : 'Bot'}: ${m.content}`).join('\n');
  const fd = new URLSearchParams();
  fd.set('form-name', 'pedidos-marketplace');
  fd.set('origen', 'whatsapp-bot');
  fd.set('producto', structuredData.producto || '');
  fd.set('nombre', structuredData.nombre || `Cliente WhatsApp ${userId}`);
  fd.set('telefono', resolveTelefono(structuredData.telefono, userId));
  fd.set('whatsapp', userId);
  fd.set('direccion', structuredData.direccion || '');
  fd.set('mensaje', `Contra entrega + Q30 envío.\nConversación reciente:\n${recentMessages}`);

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
        await sendWhatsAppMessage(userId, '¡Recibida! 🧡 Cuéntame, ¿en qué te puedo ayudar?');
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
      const loopReply = 'Cuando quieras seguir con tu pedido, aquí estoy 🧡';
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
