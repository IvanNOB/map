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

### 5. Agregar permisos de ubicación en segundo plano
Abre el archivo `mobile/android/app/src/main/AndroidManifest.xml` y, dentro de
`<manifest>` (antes de `<application>`), agrega estos permisos:

```xml
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_LOCATION" />
<uses-permission android:name="android.permission.WAKE_LOCK" />
```

> El plugin `@capacitor-community/background-geolocation` ya registra su servicio
> automáticamente al sincronizar; estos permisos son los que Android exige.

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
