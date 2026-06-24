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
