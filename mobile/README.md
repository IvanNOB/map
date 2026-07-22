# 📱 App Android del Repartidor (rastreo en segundo plano)

Esta carpeta convierte la app web del repartidor en una **app Android nativa**
que sigue enviando la ubicación **aunque el repartidor cierre la app o bloquee
el celular** (usando un servicio en primer plano con notificación).

La app carga el sitio en vivo (`https://map-rgi5.onrender.com/driver.html`), así
que **reutiliza todo el código web** y se actualiza solo cuando despliegas cambios.
El `driver.js` ya detecta cuando corre dentro de la app y activa el rastreo en
segundo plano automáticamente.

---

## Requisitos (en tu computadora)
- **Node.js** (ya lo tienes)
- **Android Studio** → https://developer.android.com/studio (incluye el SDK de Android)
- Un celular Android o un emulador

---

## Pasos para generar el APK

```bash
# 1. Entra a la carpeta mobile
cd mobile

# 2. Instala dependencias
npm install

# 3. Crea el proyecto Android
npx cap add android

# 4. Sincroniza
npx cap sync
```

### 5. Agregar permisos y habilitar microfono
```bash
# Esto agrega permisos de ubicacion + microfono al AndroidManifest
# y modifica MainActivity para auto-conceder microfono al WebView
npm run patch
```

Los permisos que se agregan:
- `ACCESS_FINE_LOCATION` / `ACCESS_BACKGROUND_LOCATION` — GPS en segundo plano
- `FOREGROUND_SERVICE` / `FOREGROUND_SERVICE_LOCATION` — servicio en primer plano
- `WAKE_LOCK` — mantener CPU activo
- `POST_NOTIFICATIONS` — notificaciones push
- `RECORD_AUDIO` — microfono para walkie-talkie
- `MODIFY_AUDIO_SETTINGS` — control de audio

### 6. Abrir en Android Studio y compilar
```bash
npx cap open android
```
En Android Studio:
- Espera a que termine de indexar (Gradle sync).
- Menú **Build → Build Bundle(s) / APK(s) → Build APK(s)**.
- Cuando termine, haz clic en **locate** para encontrar el archivo `app-debug.apk`.

### 7. Instalar en los celulares
- Pasa el `app-debug.apk` a cada celular (WhatsApp, USB, etc.) e instálalo
  (hay que permitir "instalar apps de orígenes desconocidos").
- Al abrir, inicia sesión como repartidor y acepta el permiso de ubicación
  **"Permitir todo el tiempo"** (importante para el rastreo en segundo plano).

---

## Cómo funciona el rastreo en segundo plano
- Cuando el repartidor activa "Compartir ubicación", la app inicia un **servicio
  en primer plano** con una notificación permanente ("Repartidor en línea").
- Mientras esté activo, envía la ubicación al servidor **aunque la pantalla esté
  apagada o la app minimizada**.
- Al pulsar "Dejar de compartir" o cerrar sesión, el servicio se detiene.

---

## Notas
- En la versión **web** (sin instalar el APK), el rastreo solo funciona con la app
  abierta y la pantalla encendida (se mantiene encendida con Wake Lock).
- El APK **no necesita** la Play Store; se instala directo. Si más adelante quieres
  publicarlo en Google Play, hay que generar un APK/AAB firmado (te puedo guiar).
- Si cambias la URL de producción, edita `server.url` en `capacitor.config.json`.

---

## Sistema de Auto-Actualización

La app verifica automáticamente si hay una nueva versión al abrirse.

### Cómo publicar una actualización:

1. **Genera la nueva APK** (siguiendo los pasos de arriba)
2. **Sube el APK a GitHub Releases:**
   - Ve a https://github.com/IvanNOB/map/releases
   - Click "Create a new release"
   - Tag: `v1.1.0` (o la nueva versión)
   - Arrastra el APK y **renombralo a `repartidor.apk`**
   - Publica
3. **Actualiza la versión** en `public/apk/version.json`:
   ```json
   {
     "version": "1.1.0",
     "versionCode": 2,
     "releaseNotes": "Walkie-talkie y asignacion competitiva",
     "apkUrl": "https://github.com/IvanNOB/map/releases/latest/download/repartidor.apk",
     "forceUpdate": true
   }
   ```
4. **Actualiza `APP_VERSION`** en `public/js/driver.js` (busca `var APP_VERSION =`)
   para que coincida con la versión nueva.
5. **Haz deploy** (push a main).

> **Nota:** Render no persiste archivos entre deploys, por eso se usa
> GitHub Releases para alojar el APK (gratis y permanente).

Los repartidores verán un **banner dorado** al abrir la app:
> "Nueva versión disponible (v1.2.0) — [Actualizar]"

Al tocar "Actualizar", se descarga el APK y Android ofrece instalarlo.

### Forzar actualización:
Si pones `"forceUpdate": true` en `version.json`, el banner no se puede cerrar
y el repartidor DEBE actualizar para seguir usando la app.
