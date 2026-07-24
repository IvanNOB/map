# Guía de Despliegue en Internet

Esta guía te muestra cómo poner la app en línea para que tus repartidores la usen
desde su celular con GPS real.

---

## Opción 1: Render.com (GRATIS y más fácil)

### Pasos:

1. **Crea una cuenta** en https://render.com (puedes usar tu cuenta de GitHub)

2. **Conecta tu repositorio:**
   - Ve a https://dashboard.render.com/
   - Clic en "New +" → "Web Service"
   - Conecta tu cuenta de GitHub
   - Selecciona el repositorio `IvanNOB/map`
   - Branch: `feature/delivery-platform`

3. **Configura:**
   - Name: `agencia-domicilios` (o el nombre que quieras)
   - Runtime: Node
   - Build Command: `npm install && npm run seed`
   - Start Command: `npm start`
   - Plan: Free (gratis)

4. **Variables de entorno** (clic en "Advanced" → "Add Environment Variable"):
   - `JWT_SECRET` = (pon una contraseña larga y aleatoria, ej: `mi-super-secreto-2024-xyz`)
   - `NODE_ENV` = `production`

5. **Clic en "Create Web Service"**

6. **Espera 2-3 minutos** mientras se construye

7. **¡Listo!** Te dará una URL como:
   ```
   https://agencia-domicilios.onrender.com
   ```

### Tus URLs serán:
- Admin: `https://agencia-domicilios.onrender.com/`
- Repartidor: `https://agencia-domicilios.onrender.com/driver.html`
- Cliente: `https://agencia-domicilios.onrender.com/customer.html?code=ORD-1001`

### Notas de Render (plan gratis):
- La app se "duerme" tras 15 min sin uso (tarda ~30 seg en despertar)
- Para que no se duerma, puedes usar el plan Starter ($7/mes)
- HTTPS incluido automáticamente (necesario para GPS)

---

## Opción 2: Railway.app (fácil, con plan gratis limitado)

1. Ve a https://railway.app/ → Sign up con GitHub
2. Clic en "New Project" → "Deploy from GitHub repo"
3. Selecciona `IvanNOB/map`, branch `feature/delivery-platform`
4. Railway detecta Node.js automáticamente
5. Agrega variables de entorno:
   - `JWT_SECRET` = tu-secreto-aqui
   - `PORT` = 3000
6. Clic en "Deploy"
7. Te dará una URL con HTTPS

---

## Opción 3: VPS propio (más control, ~$5/mes)

Si prefieres un servidor propio (DigitalOcean, Linode, Hetzner):

### 1. Crear servidor Ubuntu 22.04

### 2. Instalar Node.js y PM2:
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git nginx certbot python3-certbot-nginx
sudo npm install -g pm2
```

### 3. Clonar y preparar:
```bash
cd /var/www
git clone https://github.com/IvanNOB/map.git
cd map
git checkout feature/delivery-platform
npm install
npm run seed
```

### 4. Crear archivo de entorno:
```bash
cat > .env << 'EOF'
PORT=3000
JWT_SECRET=pon-un-secreto-largo-aqui-cambiame
NODE_ENV=production
EOF
```

### 5. Iniciar con PM2 (se reinicia si se cae):
```bash
pm2 start server.js --name "domicilios"
pm2 save
pm2 startup
```

### 6. Configurar Nginx como proxy:
```bash
sudo nano /etc/nginx/sites-available/domicilios
```

Pega esto (cambia `tudominio.com` por tu dominio real):
```nginx
server {
    listen 80;
    server_name tudominio.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/domicilios /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

### 7. Activar HTTPS con Let's Encrypt (gratis):
```bash
sudo certbot --nginx -d tudominio.com
```

¡Listo! Tu app estará en `https://tudominio.com` con HTTPS.

---

## Después de desplegar

### Compartir con tus repartidores:
Envíales por WhatsApp el link de la app del repartidor:
```
https://tu-url.com/driver.html
```
Diles que se creen un acceso directo en la pantalla de inicio de su celular
(en Chrome: menú ⋮ → "Agregar a pantalla de inicio").

### Compartir con clientes:
Cuando crees un pedido, puedes enviarle al cliente el link:
```
https://tu-url.com/customer.html?code=ORD-XXXX
```

---

## Preguntas Frecuentes

**¿Cuánto cuesta?**
- Render gratis: $0 (pero se duerme)
- Render Starter: $7/mes (siempre activo)
- Railway: ~$5/mes con uso normal
- VPS: $4-6/mes (DigitalOcean/Hetzner)

**¿Necesito dominio propio?**
No obligatoriamente. Render y Railway te dan un subdominio gratis con HTTPS.
Pero si quieres uno propio (ej: miempresa.com), cuesta ~$10/año en Namecheap.

**¿El GPS funciona en el celular?**
Sí, pero SOLO con HTTPS (por eso necesitas desplegarlo). En localhost funciona
para pruebas, pero en celulares reales necesitas el certificado SSL.

**¿Cuántos repartidores soporta?**
Con SQLite: hasta ~50 repartidores simultáneos sin problema.
Para más, migra a PostgreSQL (te puedo ayudar con eso).



---

## Base de datos persistente con PostgreSQL (Render)

Por defecto la app usa SQLite (un archivo local). En Render el plan gratuito
**no tiene disco persistente**, así que cada reinicio borra los datos. Para que
los pedidos persistan, conecta una base de datos PostgreSQL gratuita de Render.

### Cómo funciona
- Si la variable de entorno `DATABASE_URL` está definida → la app usa **PostgreSQL**.
- Si NO está definida → la app usa **SQLite** (ideal para desarrollo local; no
  necesitas instalar PostgreSQL en tu computadora).

### Pasos en Render

1. En el dashboard de Render: **New +** → **PostgreSQL**.
   - Name: `domicilios-db`
   - Plan: **Free**
   - Clic en **Create Database** y espera 1-2 minutos.

2. En la página de la base de datos, copia la **Internal Database URL**
   (empieza con `postgresql://...`). Úsala solo dentro de Render.

3. Ve a tu **Web Service** → **Environment** → **Add Environment Variable**:
   - Key: `DATABASE_URL`
   - Value: (pega la Internal Database URL)

4. Guarda. Render redesplegará automáticamente. El build (`npm install; npm run seed`)
   creará las tablas y los datos de prueba en PostgreSQL.

A partir de ahora, los pedidos, repartidores y el historial **persisten** entre
reinicios y despliegues.

### Notas
- El `npm run seed` es idempotente: solo inserta los usuarios/pedidos de demo si
  no existen, por lo que NO borra datos reales en cada despliegue.
- Para desarrollo local NO necesitas hacer nada: sin `DATABASE_URL`, sigue
  funcionando con SQLite como siempre.



---

## WhatsApp 100% automático (opcional, Twilio)

Por defecto, al asignar un pedido se abre WhatsApp con el mensaje ya escrito
(semi-automático, sin costo). Para envío **100% automático** desde el servidor,
configura una cuenta de [Twilio WhatsApp](https://www.twilio.com/whatsapp) y
agrega estas variables de entorno en Render:

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_WHATSAPP_FROM`  (ej. `whatsapp:+14155238886`)
- `PUBLIC_URL`  (ej. `https://map-rgi5.onrender.com`) para los links de seguimiento

Cuando estas variables están presentes, el sistema envía automáticamente el
mensaje de seguimiento al cliente al asignar un repartidor. Si no están
configuradas, no pasa nada (se mantiene el botón manual de WhatsApp).

## Notificaciones push

Las notificaciones push del navegador funcionan automáticamente: las claves
VAPID se generan y guardan en la base de datos en el primer arranque. Solo
requieren HTTPS (Render ya lo provee) y que el usuario acepte el permiso de
notificaciones. Opcional: `VAPID_CONTACT` (ej. `mailto:tu@correo.com`).


## Activar el asistente OpenAI del panel

El asistente de monitoreo funciona únicamente para administradores y es de solo lectura. La clave nunca debe agregarse a archivos JavaScript ni compartirse con el navegador.

1. Crea una clave de API en tu cuenta de OpenAI.
2. En Render abre el servicio web y entra a **Environment**.
3. Agrega estas variables:
   - `OPENAI_API_KEY`: tu clave secreta de OpenAI.
   - `OPENAI_MODEL`: `gpt-5.6-terra`.
   - `ASSISTANT_RATE_LIMIT_MAX`: `10` (opcional; consultas por minuto e instancia).
4. Guarda los cambios para iniciar un nuevo despliegue.
5. En el panel administrador pulsa **IA**. El indicador debe mostrar “OpenAI listo · modo solo lectura”.

La integración no envía teléfonos, correos, direcciones ni coordenadas exactas. Los códigos de pedido y nombres de repartidores se sustituyen por alias antes de llamar a OpenAI y se restauran localmente en la respuesta del servidor. No incluyas datos personales manualmente en las preguntas.



## Activar Ghosty (asistente WhatsApp + voz)

Ghosty permite que los clientes hagan pedidos conversando por WhatsApp y que tú des comandos de voz desde el panel.

### Requisitos previos
1. **OpenAI API Key** configurada (ver sección anterior).
2. **Cuenta de Meta Business** con WhatsApp Business Platform.

### Paso 1: Crear app en Meta Developers

1. Ve a [developers.facebook.com](https://developers.facebook.com/) y crea una app de tipo "Business".
2. En la app, agrega el producto "WhatsApp".
3. En **WhatsApp > API Setup** obtendrás:
   - **Phone Number ID** (el ID numérico, no el teléfono).
   - **Temporary Access Token** (luego generas uno permanente en System Users).

### Paso 2: Configurar el Webhook

1. En **WhatsApp > Configuration > Webhook**, configura:
   - **Callback URL:** `https://tu-servicio.onrender.com/api/ghosty/whatsapp/webhook`
   - **Verify Token:** El mismo valor que pongas en `META_WHATSAPP_VERIFY_TOKEN`.
2. Suscríbete al campo **messages**.

### Paso 3: Variables de entorno en Render

Agrega estas variables en tu servicio de Render:

| Variable | Valor |
|----------|-------|
| `META_WHATSAPP_TOKEN` | Token permanente de System User |
| `META_WHATSAPP_PHONE_ID` | Phone Number ID de la API Setup |
| `META_WHATSAPP_VERIFY_TOKEN` | Una frase secreta (ej: `ghosty-2024-secret`) |
| `META_WHATSAPP_APP_SECRET` | App Secret de tu Meta App (opcional, para verificar firmas) |

### Paso 4: Verificar

1. Guarda las variables y espera el despliegue.
2. En tu panel admin, haz clic en **👻 Voz** y di "Hola Ghosty".
3. Envía un mensaje de prueba al número de WhatsApp configurado.
4. Ghosty debe responder automáticamente pidiendo los datos del pedido.

### Cómo funciona

```
Cliente WhatsApp → Meta → Webhook → Ghosty Brain (OpenAI) → Respuesta automática
                                          ↓
                                    Pedido completo
                                          ↓
                              Panel Admin ← Socket.IO ← Sugerencia de repartidor
                                          ↓
                              Admin confirma → Se asigna → Cliente notificado
```

### Comandos de voz (panel admin)

- Presiona **👻 Voz** o usa **Ctrl+Shift+G**.
- Ejemplos:
  - "Ghosty, crea un pedido para Juan, recogida en Subway, entrega en Calle 5"
  - "Ghosty, qué pedidos hay pendientes?"
  - "Ghosty, confirma el pedido"

### Costos

- **Meta WhatsApp Cloud API:** 1000 conversaciones gratis/mes.
- **OpenAI:** ~$0.01-0.03 por conversación (usa GPT-5.6 Terra).
- **Sin costos adicionales** de infraestructura.
