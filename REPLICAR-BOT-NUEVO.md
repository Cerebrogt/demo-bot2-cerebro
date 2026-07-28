# Receta: replicar el bot para un CLIENTE NUEVO (copy-paste del modelo)

Guía para Claude (Cowork). El molde es github.com/Cerebrogt/jm-bot-marketplace
(marcado como Template repository): sitio + bot de pedidos por WhatsApp +
Panel v2 con montos, asesora, fotos y pedidos por llave.

## 1. Copiar el código (Carlos, 1 minuto)

- github.com/Cerebrogt/jm-bot-marketplace → botón verde **Use this template**
  → Create a new repository → nombre `bot-NOMBRE-CLIENTE` → Private → Create.
- Invitar al socio como colaborador si aplica.

## 2. Crear el sitio en Netlify (Carlos, 2 minutos)

- app.netlify.com → **Add new project → Import an existing project** → GitHub
  → elegir el repo nuevo → branch `main` → NO tocar build settings (el
  netlify.toml manda) → Deploy.
- (Opcional) Renombrar el sitio: Project configuration → Change project name.
- ⚠️ Este SÍ es el flujo de "sitio nuevo" — al revés que en una migración.

## 3. Servicios del cliente nuevo (NUNCA reutilizar los de otro bot)

- **Upstash**: crear una base Redis NUEVA (console.upstash.com) → copiar
  REST URL y token. Cada bot con su base — si se comparte, se mezclan
  pedidos y conversaciones de clientes distintos.
- **WhatsApp/Meta**: número nuevo para el bot del cliente, en la app de Meta:
  token permanente vía System User + Phone Number ID + verify token inventado.
- **Clave del panel**: inventar un ADMIN_PASSWORD propio del cliente.

## 4. Variables de entorno (Netlify → Site configuration → Environment variables)

- ANTHROPIC_API_KEY          (puede ser la misma de Cerebro)
- WHATSAPP_VERIFY_TOKEN      (string inventado, ej. cliente-verify-2026)
- WHATSAPP_ACCESS_TOKEN      (token permanente del System User de Meta)
- WHATSAPP_PHONE_NUMBER_ID   (ID numérico del número del bot en Meta)
- UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN  (de la base NUEVA)
- TEAM_WHATSAPP_NUMBERS      (números que reciben pedidos, separados por coma)
- ADMIN_PASSWORD             (clave del panel del cliente)
- Después de cargar variables: Deploys → Trigger deploy (se congelan por deploy).

## 5. Conectar el webhook en Meta

- developers.facebook.com → app → WhatsApp → Configuration:
  Callback URL: https://SITIO-NUEVO.netlify.app/.netlify/functions/whatsapp-webhook
  Verify token: el mismo WHATSAPP_VERIFY_TOKEN. Suscribir el campo `messages`.
- Cada número del equipo debe escribirle un mensaje al bot para abrir la
  ventana de 24 h (si no, no llegan las notificaciones de pedido).

## 6. Personalizar para el cliente (Claude, en la sesión de Cowork del cliente)

Todo vive en el repo nuevo; cambios por push (se publican solos):
- `netlify/functions/whatsapp-webhook.js`: CATALOG (productos, precios, promos,
  fotos), SYSTEM_PROMPT (nombre de la tienda, envío, tono), saludos,
  detectProduct/PRICE_MAP, y en captureOrder el `tiendaNombre` y `linea`.
- `public/index.html`: marca, colores, productos del sitio.
- `public/admin.html`: 🎨 PALETA EDITABLE (3 variables de color), GALERIA
  (URLs de img/ del sitio NUEVO), textos de marca, y la tabla PRECIOS_JM de
  montos (precios del cliente). inbox-list.js y pedidos-list.js traen el
  nombre de tienda por defecto — actualizarlo.
- `public/img/`: fotos de los productos del cliente (mismas rutas que use CATALOG).

## 7. Prueba de fuego

1. Mandar al número del bot: "Hola! Me interesa el producto: *X* 🛍️ ¿Está disponible?"
2. Debe saludar determinístico, mandar fotos, capturar nombre → teléfono →
   dirección y disparar la notificación 🛒 al equipo.
3. Panel: entrar a /admin.html con la clave, ver la conversación y el pedido
   con su monto. Probar "Descargar Excel" (monto + TOTAL) e intervención de
   asesora (el bot debe callarse 30 min).
4. Verificar que /netlify/functions/*.js dé 404 (fuentes no públicas).

## Notas

- El plan Netlify Pro es POR EQUIPO: cubre todos los sitios nuevos sin pagar más.
- Los datos de cada cliente viven en SU Redis y SU sitio — los deploys nunca
  borran pedidos ni conversaciones.
- Si algo del molde mejora (bug del bot, feature del panel), el cambio se hace
  en el repo del molde y se replica a los clientes copiando el archivo tocado
  (pedírselo a Claude en la sesión de cada cliente).
