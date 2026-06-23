# 🚚 Fleet Tracker

App web de **seguimiento de flota / repartidores en tiempo real** con mapa en vivo.

Pensada para que una empresa siga la ubicación de sus repartidores o vehículos **con el consentimiento de cada conductor**.

## Características

- **Panel de control** (`/`): mapa en vivo (Leaflet + OpenStreetMap) con todos los vehículos, lista lateral con velocidad y última actualización, e indicador de conexión.
- **App del repartidor** (`/driver.html`): comparte la ubicación del navegador en tiempo real, con casilla de consentimiento obligatoria.
- **Tiempo real** con WebSockets (Socket.IO) — sin recargar la página.
- Los vehículos sin reportar durante 30 s se marcan automáticamente como offline.
- Sin API keys: usa mapas gratuitos de OpenStreetMap.

## Stack

- **Backend:** Node.js + Express + Socket.IO
- **Frontend:** HTML/CSS/JS + Leaflet
- **Geolocalización:** API `navigator.geolocation` del navegador

## Cómo ejecutar

```bash
npm install
npm start
```

Luego abre:
- Panel de control: <http://localhost:3000/>
- App del repartidor: <http://localhost:3000/driver.html>

> La geolocalización del navegador solo funciona sobre `https://` o `localhost`. Para producción con móviles reales necesitas un dominio con HTTPS.

## Estructura

```
fleet-tracker/
├── server.js              # Backend Express + Socket.IO
├── package.json
└── public/
    ├── index.html         # Panel del despachador (mapa en vivo)
    ├── driver.html        # App del repartidor
    ├── css/style.css
    └── js/
        ├── dispatcher.js  # Lógica del mapa Leaflet
        └── driver.js      # Geolocalización del navegador
```

## Próximos pasos (para producción)

- Autenticación de repartidores y despachadores.
- Persistencia en base de datos (Postgres / Redis).
- Historial de rutas y geofencing/alertas.

## Privacidad

Esta app está diseñada para uso **con consentimiento**: cada conductor activa explícitamente el compartir su ubicación y puede detenerlo en cualquier momento. No debe usarse para rastrear a personas sin su conocimiento o autorización.
