// TEMPORAL — borra TODOS los datos de Redis de este bot (conversaciones, pedidos, flags).
// Se usa una sola vez al reciclar el demo para otro cliente y luego SE ELIMINA este archivo.
// Uso: GET /.netlify/functions/admin-wipe-temp?clave=ADMIN_PASSWORD&confirm=BORRAR-TODO

const { Redis } = require('@upstash/redis');

exports.handler = async (event) => {
  const pw = event.queryStringParameters?.clave;
  const confirm = event.queryStringParameters?.confirm;
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || pw !== expected) return { statusCode: 401, body: 'Unauthorized' };
  if (confirm !== 'BORRAR-TODO') return { statusCode: 400, body: 'Falta confirm=BORRAR-TODO' };

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return { statusCode: 500, body: 'Redis no configurado' };

  try {
    const redis = new Redis({ url, token });
    const antes = await redis.dbsize();
    await redis.flushdb();
    const despues = await redis.dbsize();
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, llavesBorradas: antes, llavesRestantes: despues })
    };
  } catch (e) {
    return { statusCode: 500, body: 'Error: ' + e.message };
  }
};
