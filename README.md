# The Marketplace GT — Sitio + Bot de WhatsApp + Panel

Sitio en producción: https://luminous-zuccutto-8f822b.netlify.app
Panel de administración: https://luminous-zuccutto-8f822b.netlify.app/admin.html (clave ADMIN_PASSWORD)

## Estructura

- `public/` — lo que se publica en el sitio (index, panel admin, fotos de productos)
- `netlify/functions/` — el bot de WhatsApp y las APIs del panel (NO se publican como archivos)
- `netlify.toml` — configuración de deploy (publica `public/`, funciones con esbuild, cron del follow-up)

## Cómo trabajar

Cada cambio que se sube a la rama `main` se publica SOLO en Netlify (1-2 minutos).
No hay que arrastrar carpetas ni correr scripts.

- Cambios simples: editar el archivo directo en github.com → Commit changes → listo
- Las variables de entorno (tokens de WhatsApp, Redis, ADMIN_PASSWORD) viven en
  Netlify (Site configuration → Environment variables), NO en este repositorio
- Los pedidos y conversaciones viven en Redis (Upstash) — un deploy nunca los borra

## Reglas del bot

Ver los comentarios en `netlify/functions/whatsapp-webhook.js` (catálogo, precios,
promos, marcadores [PEDIDO:...] y [HOT_PEDIDO:...], anti-duplicados, pausa de asesora).

_Conectado a Netlify: cada push a main se publica automáticamente._

