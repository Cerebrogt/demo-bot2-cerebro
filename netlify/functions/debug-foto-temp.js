// TEMPORAL — diagnóstico de envío de fotos por WhatsApp. Se elimina al terminar.
// GET /.netlify/functions/debug-foto-temp?clave=ADMIN_PASSWORD&to=502XXXXXXXX

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  if (q.clave !== process.env.ADMIN_PASSWORD) return { statusCode: 401, body: 'Unauthorized' };
  const to = (q.to || '').replace(/\D/g, '');
  if (!to) return { statusCode: 400, body: 'Falta ?to=numero' };

  const out = { env: {}, imagen: {}, envio: {} };
  const baseUrl = process.env.URL || process.env.DEPLOY_URL;
  out.env = {
    URL: process.env.URL || null,
    DEPLOY_URL: process.env.DEPLOY_URL || null,
    phoneId: process.env.WHATSAPP_PHONE_NUMBER_ID ? 'set' : 'MISSING',
    token: process.env.WHATSAPP_ACCESS_TOKEN ? 'set (' + process.env.WHATSAPP_ACCESS_TOKEN.slice(0, 8) + '…)' : 'MISSING'
  };

  const imgUrl = (baseUrl || 'https://cerebrobot2.netlify.app').replace(/\/$/, '') + '/img/hidroaspiradora/hidroaspiradora-flyer.jpg';
  // 1) ¿La imagen es accesible públicamente como la vería Meta?
  try {
    const r = await fetch(imgUrl, { method: 'GET' });
    out.imagen = { url: imgUrl, status: r.status, contentType: r.headers.get('content-type'), bytes: (await r.arrayBuffer()).byteLength };
  } catch (e) { out.imagen = { url: imgUrl, error: e.message }; }

  // 2) Envío real vía Graph API — respuesta completa
  try {
    const r = await fetch(`https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'image', image: { link: imgUrl, caption: 'Prueba de diagnóstico 🛠️' } })
    });
    out.envio = { status: r.status, body: await r.json() };
  } catch (e) { out.envio = { error: e.message }; }

  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(out, null, 2) };
};
