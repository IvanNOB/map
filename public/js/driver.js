/* ─── Driver App JavaScript ───────────────────────────────────────────────── */

(function () {
  'use strict';

  // ─── State ──────────────────────────────────────────────────────────────────
  let token = localStorage.getItem('driver_token') || '';
  let currentUser = null;
  let orders = [];
  let socket = null;
  let map = null;
  let positionMarker = null;
  let watchId = null;
  let sharing = false;
  let orderMarkers = [];
  let baseLayers = null;
  let dchatMessages = [];
  let driverRoutePolyline = null;
  let lastRouteTs = 0;

  // Fastest driving route via OSRM (free, no key)
  async function osrmRoute(lat1, lng1, lat2, lng2) {
    try {
      var url = 'https://router.project-osrm.org/route/v1/driving/' + lng1 + ',' + lat1 + ';' + lng2 + ',' + lat2 + '?overview=full&geometries=geojson';
      var res = await fetch(url);
      if (!res.ok) return null;
      var data = await res.json();
      var r = data.routes && data.routes[0];
      if (!r) return null;
      return { distanceKm: r.distance / 1000, minutes: r.duration / 60, latlngs: r.geometry.coordinates.map(function (c) { return [c[1], c[0]]; }) };
    } catch (e) { return null; }
  }

  // Draw the fastest route from the driver to the current target:
  // - going to pickup while the order is 'assigned'
  // - going to dropoff once 'picked_up' / 'on_the_way'
  async function updateDriverRoute(curLat, curLng) {
    if (!map) return;
    const active = orders.find((o) => ['assigned', 'picked_up', 'on_the_way'].includes(o.status));
    if (!active) {
      if (driverRoutePolyline) { map.removeLayer(driverRoutePolyline); driverRoutePolyline = null; }
      return;
    }
    const toPickup = active.status === 'assigned';
    const tLat = toPickup ? active.pickup_lat : active.dropoff_lat;
    const tLng = toPickup ? active.pickup_lng : active.dropoff_lng;
    if (tLat == null || tLng == null) return;

    // Throttle route recalculation to once every 20s
    const now = Date.now();
    if (now - lastRouteTs < 20000) return;
    lastRouteTs = now;

    const route = await osrmRoute(curLat, curLng, tLat, tLng);
    if (!route || !map) return;
    if (driverRoutePolyline) map.removeLayer(driverRoutePolyline);
    driverRoutePolyline = L.polyline(route.latlngs, {
      color: toPickup ? '#22c55e' : '#3b82f6', weight: 5, opacity: 0.8,
    }).addTo(map);
  }

  // ─── Pin icons ──────────────────────────────────────────────────────────────
  function pinIcon(kind, emoji) {
    return L.divIcon({
      className: '',
      html: '<div class="pin pin-' + kind + '"><span>' + emoji + '</span></div>',
      iconSize: [28, 28],
      iconAnchor: [14, kind === 'driver' ? 14 : 28],
      popupAnchor: [0, kind === 'driver' ? -14 : -28],
    });
  }

  // ─── Theme ────────────────────────────────────────────────────────────────
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
    const btn = document.getElementById('btn-theme');
    if (btn) btn.textContent = theme === 'light' ? '☀️' : '🌙';
  }
  applyTheme(localStorage.getItem('theme') || 'dark');
  document.addEventListener('click', (e) => {
    if (e.target && e.target.id === 'btn-theme') {
      const cur = document.documentElement.getAttribute('data-theme');
      applyTheme(cur === 'light' ? 'dark' : 'light');
    }
  });

  // ─── DOM References ─────────────────────────────────────────────────────────
  const loginScreen = document.getElementById('login-screen');
  const app = document.getElementById('app');
  const loginForm = document.getElementById('login-form');
  const loginError = document.getElementById('login-error');
  const driverName = document.getElementById('driver-name');
  const btnLogout = document.getElementById('btn-logout');
  const toastContainer = document.getElementById('toast-container');
  const driverOrders = document.getElementById('driver-orders');
  const toggleOnline = document.getElementById('toggle-online');
  const statusLabel = document.getElementById('status-label');
  const consentLocation = document.getElementById('consent-location');
  const btnShareLocation = document.getElementById('btn-share-location');
  const btnStopLocation = document.getElementById('btn-stop-location');
  const gpsReadout = document.getElementById('gps-readout');

  // ─── Helpers ────────────────────────────────────────────────────────────────

  function apiHeaders() {
    return {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token,
    };
  }

  async function apiFetch(url, opts = {}) {
    opts.headers = { ...apiHeaders(), ...opts.headers };
    const res = await fetch(url, opts);
    if (res.status === 401) {
      logout();
      throw new Error('No autorizado');
    }
    return res;
  }

  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = 'toast ' + type;
    toast.textContent = message;
    toastContainer.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  function statusLabelText(status) {
    const labels = {
      pending: 'Pendiente',
      assigned: 'Asignado',
      picked_up: 'Recogido',
      on_the_way: 'En Camino',
      delivered: 'Entregado',
      cancelled: 'Cancelado',
    };
    return labels[status] || status;
  }

  function nextAction(status) {
    const actions = {
      assigned: { next: 'picked_up', label: 'Recogido' },
      picked_up: { next: 'on_the_way', label: 'En Camino' },
      on_the_way: { next: 'delivered', label: 'Entregado' },
    };
    return actions[status] || null;
  }

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // ─── Auth ───────────────────────────────────────────────────────────────────

  async function checkAuth() {
    if (!token) {
      showLogin();
      return;
    }
    try {
      const res = await fetch('/api/auth/me', { headers: apiHeaders() });
      if (res.ok) {
        currentUser = (await res.json()).user;
        if (currentUser.role !== 'driver') {
          showLogin();
          return;
        }
        showApp();
      } else {
        showLogin();
      }
    } catch {
      showLogin();
    }
  }

  function showLogin() {
    loginScreen.classList.remove('hidden');
    app.classList.add('hidden');
  }

  function showApp() {
    loginScreen.classList.add('hidden');
    app.classList.remove('hidden');
    driverName.textContent = currentUser.name;
    loadOrders();
    initSocket();
    initMap();
    loadDriverChat();
    loadEarnings();
    // Request notification permission + subscribe to push
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
    if (window.enablePush) window.enablePush(token);
    // En el APK: pedir permiso de notificaciones nativas
    const ln = localNotifPlugin();
    if (ln && ln.requestPermissions) { try { ln.requestPermissions(); } catch (e) {} }
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.textContent = '';
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (res.ok) {
        if (data.user.role !== 'driver') {
          loginError.textContent = 'Esta app es solo para repartidores';
          return;
        }
        token = data.token;
        localStorage.setItem('driver_token', token);
        currentUser = data.user;
        showApp();
      } else {
        loginError.textContent = data.error || 'Error al iniciar sesion';
      }
    } catch {
      loginError.textContent = 'Error de conexion';
    }
  });

  function logout() {
    stopSharing();
    token = '';
    localStorage.removeItem('driver_token');
    currentUser = null;
    if (socket) { socket.disconnect(); socket = null; }
    showLogin();
  }

  btnLogout.addEventListener('click', async () => {
    try { await apiFetch('/api/auth/logout', { method: 'POST' }); } catch {}
    logout();
  });

  // ─── Refresh Button ─────────────────────────────────────────────────────────

  const btnRefreshDriver = document.getElementById('btn-refresh-driver');
  if (btnRefreshDriver) {
    btnRefreshDriver.addEventListener('click', async () => {
      btnRefreshDriver.disabled = true;
      btnRefreshDriver.style.opacity = '0.5';
      btnRefreshDriver.style.transition = 'transform 0.3s';
      btnRefreshDriver.style.transform = 'rotate(360deg)';
      try {
        await loadOrders();
        await loadEarnings();
        showToast('Pedidos actualizados', 'success');
      } catch {
        showToast('Error al refrescar', 'error');
      } finally {
        btnRefreshDriver.disabled = false;
        btnRefreshDriver.style.opacity = '1';
        btnRefreshDriver.style.transform = '';
      }
    });
  }

  // ─── Orders ─────────────────────────────────────────────────────────────────

  async function loadOrders() {
    try {
      const res = await apiFetch('/api/orders');
      if (res.ok) {
        orders = await res.json();
        lastRouteTs = 0; // force route recompute when orders/targets change
        renderOrders();
        if (lastPos) updateDriverRoute(lastPos.lat, lastPos.lng);
      }
    } catch {}
  }

  function renderOrders() {
    driverOrders.innerHTML = '';
    const active = orders.filter((o) => o.status !== 'delivered' && o.status !== 'cancelled');
    const delivered = orders.filter((o) => o.status === 'delivered');

    if (active.length === 0 && delivered.length === 0) {
      driverOrders.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:1rem;">No tienes pedidos asignados</p>';
      return;
    }

    active.forEach((order, idx) => renderOrderCard(order, idx));

    if (delivered.length > 0) {
      const divider = document.createElement('h4');
      divider.textContent = 'Completados';
      divider.style.cssText = 'color:var(--text-muted);font-size:0.85rem;margin:1rem 0 0.5rem;';
      driverOrders.appendChild(divider);
      delivered.slice(0, 5).forEach((order) => renderOrderCard(order));
    }

    renderOrderMarkers();
  }

  // Colores para diferenciar pedidos por orden de prioridad
  const orderColors = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899'];

  function renderOrderCard(order, idx) {
    const card = document.createElement('div');
    const colorIdx = (typeof idx === 'number') ? idx % orderColors.length : 0;
    const color = orderColors[colorIdx];
    card.className = 'driver-order-card';
    card.style.borderLeft = '4px solid ' + color;
    const action = nextAction(order.status);

    // Navigation target: go to pickup while assigned, to dropoff once picked up
    let navBtn = '';
    const toPickup = order.status === 'assigned';
    const navLat = toPickup ? order.pickup_lat : order.dropoff_lat;
    const navLng = toPickup ? order.pickup_lng : order.dropoff_lng;
    if (navLat && navLng) {
      const navUrl = 'https://www.google.com/maps/dir/?api=1&destination=' + navLat + ',' + navLng + '&travelmode=driving';
      navBtn = '<a class="btn btn-nav btn-sm" href="' + navUrl + '" target="_blank" rel="noopener">🧭 Navegar ' + (toPickup ? 'a recogida' : 'a entrega') + '</a>';
    }

    // Contact the customer via WhatsApp / call (from the driver's phone)
    let contactBtns = '';
    if (order.customer_phone) {
      const digits = String(order.customer_phone).replace(/[^0-9]/g, '');
      if (digits) {
        const waMsg = encodeURIComponent('Hola! Soy tu repartidor de Servicio Ghost con tu pedido ' + order.code + '.');
        contactBtns =
          '<a class="btn btn-whatsapp btn-sm" href="https://wa.me/' + digits + '?text=' + waMsg + '" target="_blank" rel="noopener">💬 WhatsApp cliente</a>' +
          '<a class="btn btn-outline btn-sm" href="tel:' + digits + '">📞 Llamar</a>';
      }
    }

    card.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem;">
        <div style="display:flex;align-items:center;gap:0.4rem;">
          <span style="background:${color};color:#fff;font-weight:bold;font-size:0.75rem;width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;">${typeof idx === 'number' ? idx + 1 : ''}</span>
          <span class="order-code">${escapeHtml(order.code)}</span>
        </div>
        <span class="badge badge-${escapeHtml(order.status)}">${escapeHtml(statusLabelText(order.status))}</span>
      </div>
      <div class="order-detail"><strong>Cliente:</strong> ${escapeHtml(order.customer_name)}</div>
      <div class="order-detail"><strong>🟢 Recogida:</strong> ${escapeHtml(order.pickup_address || '-')}</div>
      <div class="order-detail"><strong>🔴 Entrega:</strong> ${escapeHtml(order.dropoff_address || '-')}</div>
      ${order.items ? '<div class="order-detail"><strong>Articulos:</strong> ' + escapeHtml(order.items) + '</div>' : ''}
      ${order.amount ? '<div class="order-detail"><strong>Monto:</strong> $' + escapeHtml(String(order.amount)) + '</div>' : ''}
      <div style="margin-top:0.8rem;display:flex;gap:0.5rem;flex-wrap:wrap;">
        ${action ? '<button class="btn btn-success btn-sm" data-order-id="' + order.id + '" data-next-status="' + action.next + '">' + escapeHtml(action.label) + '</button>' : ''}
        ${navBtn}
        ${contactBtns}
        ${['on_the_way', 'delivered'].includes(order.status) ? '<button class="btn btn-nav btn-sm" data-proof="' + order.id + '">📸 Subir prueba</button>' : ''}
        ${order.status === 'delivered' ? '<span class="badge badge-delivered">Completado</span>' : ''}
      </div>
    `;
    driverOrders.appendChild(card);

    // Bind action button
    const btn = card.querySelector('[data-order-id]');
    if (btn) {
      btn.addEventListener('click', () => updateOrderStatus(btn.dataset.orderId, btn.dataset.nextStatus));
    }
    const proofBtn = card.querySelector('[data-proof]');
    if (proofBtn) {
      proofBtn.addEventListener('click', () => uploadProof(proofBtn.dataset.proof));
    }
  }

  // Capture/resize a photo and upload as proof of delivery
  function uploadProof(orderId) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.capture = 'environment';
    input.onchange = function () {
      const file = input.files && input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function (e) {
        const img = new Image();
        img.onload = async function () {
          // Resize to max 800px wide, JPEG ~0.6 quality
          const max = 800;
          let w = img.width, h = img.height;
          if (w > max) { h = Math.round(h * max / w); w = max; }
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.6);
          try {
            const res = await apiFetch('/api/orders/' + orderId + '/proof', {
              method: 'POST',
              body: JSON.stringify({ image: dataUrl }),
            });
            if (res.ok) showToast('Foto de entrega subida', 'success');
            else { const er = await res.json(); showToast(er.error || 'Error al subir', 'error'); }
          } catch { showToast('Error de conexion', 'error'); }
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    };
    input.click();
  }

  async function updateOrderStatus(orderId, status) {
    try {
      const res = await apiFetch('/api/orders/' + orderId + '/status', {
        method: 'POST',
        body: JSON.stringify({ status }),
      });
      if (res.ok) {
        showToast('Estado actualizado: ' + statusLabelText(status), 'success');
        loadOrders();
        loadEarnings();
      } else {
        const err = await res.json();
        showToast(err.error || 'Error al actualizar', 'error');
      }
    } catch {
      showToast('Error de conexion', 'error');
    }
  }

  // ─── Online/Offline Toggle ──────────────────────────────────────────────────

  toggleOnline.addEventListener('change', () => {
    if (toggleOnline.checked) {
      statusLabel.textContent = 'En linea';
      statusLabel.style.color = 'var(--success)';
    } else {
      statusLabel.textContent = 'Desconectado';
      statusLabel.style.color = 'var(--text-muted)';
      stopSharing();
    }
  });

  // ─── Location Sharing ──────────────────────────────────────────────────────

  consentLocation.addEventListener('change', () => {
    btnShareLocation.disabled = !consentLocation.checked;
  });

  btnShareLocation.addEventListener('click', startSharing);
  btnStopLocation.addEventListener('click', stopSharing);

  // ─── Wake Lock (keep screen on while sharing) ───────────────────────────────
  let wakeLock = null;
  async function acquireWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch (e) { /* ignore */ }
  }
  function releaseWakeLock() {
    try { if (wakeLock) { wakeLock.release(); wakeLock = null; } } catch (e) {}
  }
  // Re-acquire the wake lock when the app comes back to the foreground
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && sharing) {
      acquireWakeLock();
      // Reenviar la ultima posicion al volver para volver a aparecer "en linea"
      if (lastPos) postLocation(lastPos.lat, lastPos.lng, lastPos.speed);
    }
  });

  // ─── Capacitor (native Android) background geolocation, if available ─────────
  function bgPlugin() {
    return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BackgroundGeolocation) || null;
  }

  // Notificaciones NATIVAS del APK (aparecen aunque el repartidor este en otra app)
  function localNotifPlugin() {
    return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications) || null;
  }
  async function notifyDriverDevice(title, body) {
    const ln = localNotifPlugin();
    if (ln) {
      try {
        await ln.schedule({
          notifications: [{
            id: Math.floor(Math.random() * 100000) + 1,
            title: title || 'Servicio Ghost',
            body: body || '',
          }],
        });
        return;
      } catch (e) { /* sigue al fallback web */ }
    }
    if ('Notification' in window && Notification.permission === 'granted') {
      try { new Notification(title || 'Servicio Ghost', { body: body || '' }); } catch (e) {}
    }
  }

  // Avisa al repartidor si la ubicacion seguira en segundo plano o no.
  function updateBgStatus() {
    const el = document.getElementById('bg-status');
    if (!el) return;
    if (bgPlugin()) {
      el.className = 'bg-status ok';
      el.innerHTML = '✅ App instalada: tu ubicación se sigue enviando aunque cierres la app o bloquees la pantalla. ' +
        '<b>Importante:</b> en los permisos de ubicación elige <b>"Permitir todo el tiempo"</b>.';
    } else {
      el.className = 'bg-status warn';
      el.innerHTML = '⚠️ Estás usando la versión de <b>navegador</b>. Si sales de la app o bloqueas la pantalla, ' +
        'la ubicación <b>deja de enviarse</b>. Para que siga en segundo plano, instala la <b>APK</b> en el celular.';
    }
  }
  // Capacitor inyecta el plugin un instante despues de cargar.
  setTimeout(updateBgStatus, 1200);
  let bgWatcherId = null;
  let lastPos = null;
  let heartbeat = null;

  function postLocation(lat, lng, speed) {
    fetch('/api/location/ping', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ lat: lat, lng: lng, speed: speed || 0 }),
      keepalive: true,
    }).catch(() => {});
  }

  function startHeartbeat() {
    stopHeartbeat();
    // Re-send the last known position every 15s so the driver stays "online"
    // even while stationary (GPS only emits on movement).
    heartbeat = setInterval(() => {
      if (lastPos) postLocation(lastPos.lat, lastPos.lng, lastPos.speed);
    }, 15000);
  }
  function stopHeartbeat() {
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
  }

  function sendLocation(latitude, longitude, speed, heading, accuracy) {
    const now = new Date().toLocaleTimeString('es-CO');
    gpsReadout.textContent = `Lat: ${latitude.toFixed(5)} | Lng: ${longitude.toFixed(5)} | Velocidad: ${(speed || 0).toFixed(1)} m/s | Precision: ${(accuracy || 0).toFixed(0)} m | Ultima actualizacion: ${now}`;
    if (map) {
      const latlng = [latitude, longitude];
      if (positionMarker) positionMarker.setLatLng(latlng);
      else positionMarker = L.marker(latlng, { icon: pinIcon('driver', '🛵') }).addTo(map);
      map.setView(latlng, 15);
    }
    lastPos = { lat: latitude, lng: longitude, speed: speed || 0 };
    // Send over HTTP (works in background, unlike a WebSocket which the OS suspends)
    postLocation(latitude, longitude, speed);
    // Draw/refresh the fastest route to the current target (in-app, no Google Maps)
    updateDriverRoute(latitude, longitude);
  }

  function startSharing() {
    if (!consentLocation.checked) return;

    const bg = bgPlugin();
    sharing = true;
    btnShareLocation.classList.add('hidden');
    btnStopLocation.classList.remove('hidden');
    startHeartbeat();
    updateBgStatus();

    if (bg) {
      // Native app: tracks in the background even with the app closed / screen off
      bg.addWatcher({
        backgroundMessage: "Compartiendo tu ubicacion con la central",
        backgroundTitle: "Repartidor en linea",
        requestPermissions: true,
        stale: false,
        distanceFilter: 20,
      }, (location, error) => {
        if (error) {
          if (error.code === 'NOT_AUTHORIZED') {
            showToast('Activa el permiso de ubicacion en "Permitir todo el tiempo"', 'warning');
          }
          return;
        }
        if (location) sendLocation(location.latitude, location.longitude, location.speed, location.bearing, location.accuracy);
      }).then((id) => { bgWatcherId = id; });
      showToast('Rastreo en segundo plano activado. Permite la ubicacion "todo el tiempo".', 'success');
      return;
    }

    // Web fallback: foreground tracking + keep screen on
    if (!navigator.geolocation) { showToast('Geolocalizacion no disponible', 'error'); return; }
    showToast('Atencion: en el navegador la ubicacion se detiene si sales de la app. Instala la APK para segundo plano.', 'warning');
    acquireWakeLock();
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude, speed, accuracy, heading } = pos.coords;
        sendLocation(latitude, longitude, speed, heading, accuracy);
      },
      (err) => { showToast('Error de geolocalizacion: ' + err.message, 'error'); },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
    );
  }

  function stopSharing() {
    const bg = bgPlugin();
    if (bg && bgWatcherId) {
      bg.removeWatcher({ id: bgWatcherId });
      bgWatcherId = null;
    }
    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
    releaseWakeLock();
    stopHeartbeat();
    sharing = false;
    btnShareLocation.classList.remove('hidden');
    btnStopLocation.classList.add('hidden');

    // Notify the server over HTTP (reliable) and via socket if connected
    fetch('/api/location/offline', { method: 'POST', headers: apiHeaders(), keepalive: true }).catch(() => {});
    if (socket && socket.connected) {
      socket.emit('driver:stop');
    }
  }

  // ─── Map ────────────────────────────────────────────────────────────────────

  function initMap() {
    if (map) return;
    map = L.map('driver-map').setView([4.6097, -74.0817], 13);
    const darkMatter = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; CartoDB', maxZoom: 19,
    });
    const satellite = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { attribution: 'Tiles &copy; Esri', maxZoom: 19 }
    );
    darkMatter.addTo(map);
    L.control.layers({ '🌑 Dark Ghost': darkMatter, '🛰️ Satelital': satellite }, null, { position: 'topright' }).addTo(map);
    renderOrderMarkers();
  }

  // Show pickup (green) and dropoff (red) markers for active orders
  function renderOrderMarkers() {
    if (!map) return;
    orderMarkers.forEach((m) => map.removeLayer(m));
    orderMarkers = [];
    const bounds = [];
    orders.forEach((o) => {
      if (!['assigned', 'picked_up', 'on_the_way'].includes(o.status)) return;
      if (o.pickup_lat && o.pickup_lng) {
        const m = L.marker([o.pickup_lat, o.pickup_lng], { icon: pinIcon('pickup', '🟢') })
          .bindPopup('🟢 Recogida ' + escapeHtml(o.code) + '<br>' + escapeHtml(o.pickup_address || '')).addTo(map);
        orderMarkers.push(m); bounds.push([o.pickup_lat, o.pickup_lng]);
      }
      if (o.dropoff_lat && o.dropoff_lng) {
        const m = L.marker([o.dropoff_lat, o.dropoff_lng], { icon: pinIcon('dropoff', '🔴') })
          .bindPopup('🔴 Entrega ' + escapeHtml(o.code) + '<br>' + escapeHtml(o.dropoff_address || '')).addTo(map);
        orderMarkers.push(m); bounds.push([o.dropoff_lat, o.dropoff_lng]);
      }
    });
    if (bounds.length) { try { map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 }); } catch (e) {} }
  }

  // ─── Socket.IO ──────────────────────────────────────────────────────────────

  // ─── Chat with dispatch ─────────────────────────────────────────────────────
  function dtime(ts) {
    if (!ts) return '';
    var d = new Date(ts.indexOf && ts.indexOf('T') === -1 ? ts.replace(' ', 'T') + 'Z' : ts);
    return isNaN(d.getTime()) ? '' : d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
  }

  function renderDriverChat() {
    var box = document.getElementById('dchat-messages');
    if (!box) return;
    if (dchatMessages.length === 0) {
      box.innerHTML = '<div class="chat-empty">Escribe a tu central de despacho</div>';
      return;
    }
    box.innerHTML = dchatMessages.map(function (m) {
      var mine = m.sender_role === 'driver';
      return '<div class="chat-msg ' + (mine ? 'mine' : 'theirs') + '">' +
        escapeHtml(m.body) + '<span class="cm-time">' + dtime(m.created_at) + '</span></div>';
    }).join('');
    box.scrollTop = box.scrollHeight;
  }

  async function loadDriverChat() {
    if (!currentUser) return;
    try {
      var res = await fetch('/api/chat/' + currentUser.id, { headers: apiHeaders() });
      if (res.ok) {
        dchatMessages = await res.json();
        renderDriverChat();
      }
    } catch (e) {}
  }

  function sendDriverChat() {
    var input = document.getElementById('dchat-input');
    var body = input.value.trim();
    if (!body || !socket) return;
    socket.emit('chat:send', { body: body });
    input.value = '';
  }

  (function bindDriverChat() {
    var sendBtn = document.getElementById('dchat-send');
    var input = document.getElementById('dchat-input');
    if (sendBtn) sendBtn.addEventListener('click', sendDriverChat);
    if (input) input.addEventListener('keydown', function (e) { if (e.key === 'Enter') sendDriverChat(); });
  })();

  async function loadEarnings() {
    if (!currentUser) return;
    const today = new Date().toISOString().slice(0, 10);
    try {
      const res = await fetch('/api/reports/my-earnings?from=' + today + '&to=' + today, { headers: apiHeaders() });
      if (!res.ok) return;
      const e = await res.json();
      const v = document.getElementById('earn-today');
      const d = document.getElementById('earn-deliveries');
      const p = document.getElementById('earn-pct');
      if (v) v.textContent = '$' + Number(e.earning || 0).toLocaleString();
      if (d) d.textContent = (e.deliveries || 0) + ' entregas';
      if (p) p.textContent = 'Comision ' + (e.commission_pct || 0) + '%';
    } catch (err) {}
  }

  function initSocket() {
    if (socket) return;
    socket = io({ auth: { token } });
    socket.on('connect', () => {
      console.log('Socket conectado (repartidor)');
    });

    socket.on('order:assigned', (order) => {
      if (window.ghostAlert) window.ghostAlert({ title: '👻 ¡Nuevo domicilio asignado!', body: order && order.code ? '📦 ' + order.code + ' - ¡A rodar!' : '¡Tienes un nuevo pedido!' });
      notifyDriverDevice('👻 ¡SERVICIOS GHOST!', order && order.code ? '📦 Nuevo domicilio: ' + order.code + ' - ¡A entregar!' : '¡Tienes un nuevo pedido asignado!');
      loadOrders();
    });

    socket.on('chat:message', (msg) => {
      dchatMessages.push(msg);
      renderDriverChat();
      if (msg.sender_role === 'admin') {
        if (window.ghostAlert) window.ghostAlert({ title: '💬 Mensaje de Central Ghost', body: msg.body || '' });
        notifyDriverDevice('💬 Central Ghost dice:', msg.body || 'Tienes un nuevo mensaje');
      }
    });

    socket.on('notification', (data) => {
      let title = '👻 Servicios Ghost';
      let body = '';
      switch (data.type) {
        case 'order_assigned':
          title = '👻 ¡Nuevo domicilio asignado!';
          body = data.data && data.data.code ? '📦 ' + data.data.code + ' - ¡A rodar!' : '';
          break;
        case 'admin_message':
          title = '🔔 ' + ((data.data && data.data.title) || 'Aviso de Central Ghost');
          body = (data.data && data.data.body) || '';
          break;
        default:
          title = '👻 Servicios Ghost';
          body = data.type || '';
      }
      if (window.ghostAlert) window.ghostAlert({ title: title, body: body });
      notifyDriverDevice(title, body);
    });

    socket.on('disconnect', () => {
      console.log('Socket desconectado');
    });
  }

  // ─── Auto Refresh (cada 5 segundos, silencioso) ─────────────────────────────

  let syncDot = null;
  setInterval(async () => {
    if (currentUser) {
      syncDot = syncDot || document.getElementById('sync-dot');
      try {
        await loadOrders();
        await loadEarnings();
        // Flash green = connected
        if (syncDot) { syncDot.style.background = '#22c55e'; }
      } catch {
        // Red = disconnected
        if (syncDot) { syncDot.style.background = '#ef4444'; }
      }
    }
  }, 5000);

  // ─── Init ──────────────────────────────────────────────────────────────────

  checkAuth();
})();
