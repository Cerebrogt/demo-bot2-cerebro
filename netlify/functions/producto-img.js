// The Marketplace GT — sirve las imágenes de producto subidas desde el admin (Netlify Blobs)
// PÚBLICO (sin clave): WhatsApp necesita poder descargar la imagen desde esta URL.
const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  const key = event.queryStringParameters?.key;
  if (!key) return { statusCode: 400, body: 'key requerida' };
  try {
    const store = getStore('producto-fotos');
    const result = await store.getWithMetadata(key, { type: 'arrayBuffer' });
    if (!result || !result.data) return { statusCode: 404, body: 'not found' };
    return {
      statusCode: 200,
      headers: {
        'Content-Type': result.metadata?.contentType || 'image/jpeg',
        'Cache-Control': 'public, max-age=31536000'
      },
      body: Buffer.from(result.data).toString('base64'),
      isBase64Encoded: true
    };
  } catch (e) {
    console.error('[producto-img] error:', e.message);
    return { statusCode: 500, body: 'error' };
  }
};
