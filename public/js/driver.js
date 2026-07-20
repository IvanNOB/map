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
  let sharing = false;

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
  const btnShareLocation = document.getElementById('btn-share-location');
  const btnStopLocation = document.getElementById('btn-stop-location');
  const gpsReadout = document.getElementById('gps-readout');

  // Background tracking UI elements
  const trackingStatus = document.getElementById('tracking-status');
  const trackingIndicator = document.getElementById('tracking-indicator');
  const trackingStatusText = document.getElementById('tracking-status-text');
  const trackingDiagnostics = document.getElementById('tracking-diagnostics');
  const diagWakeLock = document.getElementById('diag-wakelock');
  const diagGps = document.getElementById('diag-gps');
  const diagSocket = document.getElementById('diag-socket');
  const diagBackground = document.getElementById('diag-background');
  const diagLastUpdate = document.getElementById('diag-last-update');

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
    loadStats();
    initSocket();
    initMap();
    initBackgroundLocation();
    // Request notification permission
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.textContent = '';
    loginError.className = 'login-error';
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    const submitBtn = loginForm.querySelector('button[type="submit"]');

    try {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Verificando...';
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (res.ok) {
        if (data.user.role !== 'driver') {
          loginError.textContent = 'Esta app es solo para repartidores';
          submitBtn.disabled = false;
          submitBtn.textContent = 'Iniciar Sesion';
          return;
        }
        token = data.token;
        localStorage.setItem('driver_token', token);
        currentUser = data.user;
        showApp();
      } else if (res.status === 429) {
        // Account locked
        loginError.className = 'login-error login-error-locked';
        loginError.innerHTML = '<strong>&#128274; Cuenta bloqueada</strong><br>' + (data.error || 'Demasiados intentos. Intenta mas tarde.');
        submitBtn.disabled = true;
        let remaining = data.retry_after_minutes || 15;
        const countdownInterval = setInterval(() => {
          remaining--;
          if (remaining <= 0) {
            clearInterval(countdownInterval);
            loginError.textContent = '';
            loginError.className = 'login-error';
            submitBtn.disabled = false;
            submitBtn.textContent = 'Iniciar Sesion';
          } else {
            loginError.innerHTML = '<strong>&#128274; Cuenta bloqueada</strong><br>Intenta de nuevo en ' + remaining + ' minuto' + (remaining !== 1 ? 's' : '') + '.';
          }
        }, 60000);
      } else {
        let msg = data.error || 'Error al iniciar sesion';
        if (data.attempts_remaining != null) {
          loginError.className = 'login-error login-error-warning';
        }
        loginError.textContent = msg;
      }
    } catch {
      loginError.textContent = 'Error de conexion';
    } finally {
      if (!loginError.classList.contains('login-error-locked')) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Iniciar Sesion';
      }
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

  // ─── Orders ─────────────────────────────────────────────────────────────────

  async function loadStats() {
    try {
      const res = await apiFetch('/api/drivers/my-stats');
      if (res.ok) {
        const s = await res.json();
        document.getElementById('stat-deliveries-today').textContent = s.today.deliveries;
        document.getElementById('stat-earnings-today').textContent = '$' + (s.today.earnings || 0).toLocaleString();
        document.getElementById('stat-deliveries-week').textContent = s.week.deliveries;
        document.getElementById('stat-earnings-week').textContent = '$' + (s.week.earnings || 0).toLocaleString();
        document.getElementById('stat-active-orders').textContent = s.active_orders;
        document.getElementById('stat-avg-time').textContent = s.avg_delivery_minutes != null ? s.avg_delivery_minutes : '--';
      }
    } catch {}
  }

  async function loadOrders() {
    try {
      const res = await apiFetch('/api/orders');
      if (res.ok) {
        orders = await res.json();
        renderOrders();
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

    active.forEach((order) => renderOrderCard(order));

    if (delivered.length > 0) {
      const divider = document.createElement('h4');
      divider.textContent = 'Completados';
      divider.style.cssText = 'color:var(--text-muted);font-size:0.85rem;margin:1rem 0 0.5rem;';
      driverOrders.appendChild(divider);
      delivered.slice(0, 5).forEach((order) => renderOrderCard(order));
    }
  }

  function renderOrderCard(order) {
    const card = document.createElement('div');
    card.className = 'driver-order-card';
    const action = nextAction(order.status);
    card.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem;">
        <span class="order-code">${escapeHtml(order.code)}</span>
        <span class="badge badge-${escapeHtml(order.status)}">${escapeHtml(statusLabelText(order.status))}</span>
      </div>
      <div class="order-detail"><strong>Cliente:</strong> ${escapeHtml(order.customer_name)}</div>
      <div class="order-detail"><strong>Recogida:</strong> ${escapeHtml(order.pickup_address || '-')}</div>
      <div class="order-detail"><strong>Entrega:</strong> ${escapeHtml(order.dropoff_address || '-')}</div>
      ${order.items ? '<div class="order-detail"><strong>Articulos:</strong> ' + escapeHtml(order.items) + '</div>' : ''}
      ${order.amount ? '<div class="order-detail"><strong>Monto:</strong> $' + escapeHtml(String(order.amount)) + '</div>' : ''}
      ${action ? '<div style="margin-top:0.8rem;"><button class="btn btn-success btn-sm" data-order-id="' + order.id + '" data-next-status="' + action.next + '">' + escapeHtml(action.label) + '</button></div>' : ''}
      ${order.status === 'delivered' ? '<div style="margin-top:0.5rem;"><span class="badge badge-delivered">Completado</span></div>' : ''}
    `;
    driverOrders.appendChild(card);

    // Bind action button
    const btn = card.querySelector('[data-order-id]');
    if (btn) {
      btn.addEventListener('click', () => updateOrderStatus(btn.dataset.orderId, btn.dataset.nextStatus));
    }
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
      // Auto-start location sharing when going online
      if (!sharing) {
        startSharing();
      }
    } else {
      statusLabel.textContent = 'Desconectado';
      statusLabel.style.color = 'var(--text-muted)';
      stopSharing();
    }
  });

  // ─── Background Location Integration ───────────────────────────────────────

  function initBackgroundLocation() {
    if (!window.BackgroundLocation) {
      console.warn('BackgroundLocation module not loaded');
      return;
    }

    window.BackgroundLocation.init({
      token: token,
      driverId: currentUser.id,
      driverName: currentUser.name,
      socket: socket,
      onLocation: handleBackgroundLocationUpdate,
      onStatus: handleTrackingStatusChange,
      onError: handleTrackingError,
    });

    // If BackgroundLocation recovers a previous session, update UI
    if (window.BackgroundLocation.isActive()) {
      sharing = true;
      updateTrackingUI('active');
      updateLocationButtons(true);
      toggleOnline.checked = true;
      statusLabel.textContent = 'En linea';
      statusLabel.style.color = 'var(--success)';
    }

    // Update diagnostics periodically
    setInterval(updateDiagnostics, 3000);
  }

  function handleBackgroundLocationUpdate(locationData) {
    const { lat, lng, speed, accuracy } = locationData;
    const now = new Date().toLocaleTimeString('es-CO');

    // Update GPS readout
    if (gpsReadout) {
      gpsReadout.textContent = `Lat: ${lat.toFixed(5)} | Lng: ${lng.toFixed(5)} | Velocidad: ${(speed || 0).toFixed(1)} m/s | Precision: ${(accuracy || 0).toFixed(0)} m | Ultima: ${now}`;
    }

    // Update map marker
    if (map) {
      const latlng = [lat, lng];
      if (positionMarker) {
        positionMarker.setLatLng(latlng);
      } else {
        positionMarker = L.circleMarker(latlng, {
          radius: 10,
          color: '#3b82f6',
          fillColor: '#3b82f6',
          fillOpacity: 0.8,
        }).addTo(map);
      }
      map.setView(latlng, 15);
    }

    // Update compass from GPS heading
    if (locationData.heading != null && !isNaN(locationData.heading)) {
      updateCompassFromGPS(locationData.heading);
    }
  }

  function handleTrackingStatusChange(status) {
    updateTrackingUI(status);

    switch (status) {
      case 'active':
        showToast('Ubicacion activa en segundo plano', 'success');
        break;
      case 'stopped':
        showToast('Ubicacion detenida', 'info');
        sharing = false;
        updateLocationButtons(false);
        break;
      case 'recovering':
        showToast('Recuperando sesion de ubicacion...', 'info');
        break;
    }
  }

  function handleTrackingError(message) {
    showToast(message, 'error');
  }

  function updateTrackingUI(status) {
    if (!trackingStatus) return;

    trackingStatus.classList.remove('hidden');

    switch (status) {
      case 'active':
        trackingIndicator.className = 'tracking-dot tracking-dot-active';
        trackingStatusText.textContent = 'Ubicacion activa (segundo plano habilitado)';
        trackingStatus.className = 'tracking-status tracking-status-active';
        break;
      case 'starting':
      case 'recovering':
        trackingIndicator.className = 'tracking-dot tracking-dot-starting';
        trackingStatusText.textContent = 'Iniciando tracking...';
        trackingStatus.className = 'tracking-status tracking-status-starting';
        break;
      case 'stopped':
        trackingIndicator.className = 'tracking-dot tracking-dot-stopped';
        trackingStatusText.textContent = 'Ubicacion detenida';
        trackingStatus.className = 'tracking-status tracking-status-stopped';
        setTimeout(() => {
          if (!sharing && trackingStatus) trackingStatus.classList.add('hidden');
        }, 3000);
        break;
      default:
        trackingStatus.classList.add('hidden');
    }
  }

  function updateLocationButtons(isSharing) {
    if (isSharing) {
      btnShareLocation.classList.add('hidden');
      btnStopLocation.classList.remove('hidden');
    } else {
      btnShareLocation.classList.remove('hidden');
      btnStopLocation.classList.add('hidden');
    }
  }

  function updateDiagnostics() {
    if (!window.BackgroundLocation || !trackingDiagnostics) return;
    if (!sharing) {
      trackingDiagnostics.classList.add('hidden');
      return;
    }

    trackingDiagnostics.classList.remove('hidden');
    const diag = window.BackgroundLocation.getDiagnostics();

    if (diagWakeLock) {
      diagWakeLock.textContent = diag.hasWakeLock ? 'Activo' : 'No disponible';
      diagWakeLock.className = 'diag-value ' + (diag.hasWakeLock ? 'diag-ok' : 'diag-warn');
    }
    if (diagGps) {
      diagGps.textContent = diag.hasGPSWatch ? 'Activo' : 'Inactivo';
      diagGps.className = 'diag-value ' + (diag.hasGPSWatch ? 'diag-ok' : 'diag-error');
    }
    if (diagSocket) {
      const connected = socket && socket.connected;
      diagSocket.textContent = connected ? 'Conectado' : 'Desconectado';
      diagSocket.className = 'diag-value ' + (connected ? 'diag-ok' : 'diag-warn');
    }
    if (diagBackground) {
      diagBackground.textContent = diag.isVisible ? 'Primer plano' : 'Segundo plano';
      diagBackground.className = 'diag-value ' + (diag.isVisible ? 'diag-ok' : 'diag-warn');
    }
    if (diagLastUpdate) {
      if (diag.lastSentTime) {
        const time = new Date(diag.lastSentTime).toLocaleTimeString('es-CO');
        diagLastUpdate.textContent = time;
        diagLastUpdate.className = 'diag-value diag-ok';
      } else {
        diagLastUpdate.textContent = 'Esperando...';
        diagLastUpdate.className = 'diag-value diag-warn';
      }
    }
  }

  // ─── Location Sharing (integrated with BackgroundLocation) ─────────────────

  btnShareLocation.addEventListener('click', startSharing);
  btnStopLocation.addEventListener('click', stopSharing);

  async function startSharing() {
    if (!navigator.geolocation) {
      showToast('Geolocalizacion no disponible', 'error');
      return;
    }

    sharing = true;
    updateLocationButtons(true);

    // Use BackgroundLocation module for persistent tracking
    if (window.BackgroundLocation) {
      // Ensure socket reference is up to date
      window.BackgroundLocation.updateSocket(socket);
      window.BackgroundLocation.updateToken(token);
      const started = await window.BackgroundLocation.start();
      if (!started) {
        sharing = false;
        updateLocationButtons(false);
        return;
      }
    }

    // Auto-enable online toggle
    if (!toggleOnline.checked) {
      toggleOnline.checked = true;
      statusLabel.textContent = 'En linea';
      statusLabel.style.color = 'var(--success)';
    }
  }

  async function stopSharing() {
    sharing = false;
    updateLocationButtons(false);

    if (window.BackgroundLocation) {
      await window.BackgroundLocation.stop();
    }
  }

  // ─── Map ────────────────────────────────────────────────────────────────────

  function initMap() {
    if (map) return;
    map = L.map('driver-map').setView([4.6097, -74.0817], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);
    initCompass();
  }

  // ─── Compass & Orientation ─────────────────────────────────────────────────

  let currentHeading = null;
  let compassInitialized = false;

  function initCompass() {
    if (compassInitialized) return;
    compassInitialized = true;

    const compassRose = document.getElementById('compass-rose');
    const compassHeading = document.getElementById('compass-heading');

    if (!compassRose || !compassHeading) return;

    // Try DeviceOrientationEvent (mobile devices with magnetometer)
    if (window.DeviceOrientationEvent) {
      // iOS 13+ requires permission request
      if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        const compassWidget = document.getElementById('compass-widget');
        compassWidget.style.cursor = 'pointer';
        compassWidget.title = 'Toca para activar la brujula';

        compassWidget.addEventListener('click', async function requestPermission() {
          try {
            const permission = await DeviceOrientationEvent.requestPermission();
            if (permission === 'granted') {
              startDeviceOrientation(compassRose, compassHeading);
              compassWidget.style.cursor = '';
              compassWidget.title = '';
              compassWidget.removeEventListener('click', requestPermission);
            } else {
              showToast('Permiso de orientacion denegado', 'warning');
            }
          } catch (err) {
            showToast('Error al solicitar orientacion: ' + err.message, 'error');
          }
        });
      } else {
        startDeviceOrientation(compassRose, compassHeading);
      }
    }
  }

  function startDeviceOrientation(compassRose, compassHeading) {
    window.addEventListener('deviceorientation', function (event) {
      let heading = null;

      if (event.webkitCompassHeading != null) {
        heading = event.webkitCompassHeading;
      } else if (event.alpha != null) {
        heading = event.absolute ? (360 - event.alpha) : (360 - event.alpha);
      }

      if (heading != null) {
        updateCompass(heading, compassRose, compassHeading);
      }
    }, true);
  }

  function updateCompass(heading, compassRose, compassHeading) {
    if (heading == null || isNaN(heading)) return;
    currentHeading = heading;

    if (compassRose) {
      compassRose.style.transform = 'rotate(' + (-heading) + 'deg)';
    }
    if (compassHeading) {
      const cardinal = getCardinalDirection(heading);
      compassHeading.textContent = Math.round(heading) + '\u00B0 ' + cardinal;
    }
  }

  function getCardinalDirection(degree) {
    const directions = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
    const index = Math.round(degree / 45) % 8;
    return directions[index];
  }

  function updateCompassFromGPS(gpsHeading) {
    if (gpsHeading == null || isNaN(gpsHeading)) return;
    if (currentHeading === null) {
      const compassRose = document.getElementById('compass-rose');
      const compassHeading = document.getElementById('compass-heading');
      updateCompass(gpsHeading, compassRose, compassHeading);
    }
  }

  // ─── Socket.IO ──────────────────────────────────────────────────────────────

  function initSocket() {
    if (socket) return;
    socket = io({ auth: { token } });

    socket.on('connect', () => {
      console.log('Socket conectado (repartidor)');
      // Update BackgroundLocation with new socket reference
      if (window.BackgroundLocation) {
        window.BackgroundLocation.updateSocket(socket);
      }
    });

    socket.on('order:assigned', (order) => {
      showToast('Nuevo pedido asignado!', 'info');
      loadOrders();
    });

    socket.on('notification', (data) => {
      if ('Notification' in window && Notification.permission === 'granted') {
        let title = 'Notificacion';
        let body = '';
        switch (data.type) {
          case 'order_assigned':
            title = 'Nuevo pedido asignado!';
            body = data.data && data.data.code ? data.data.code : '';
            break;
          default:
            title = 'Notificacion';
            body = data.type || '';
        }
        new Notification(title, { body: body });
      }
    });

    socket.on('disconnect', () => {
      console.log('Socket desconectado');
    });

    socket.on('reconnect', () => {
      console.log('Socket reconectado');
      if (window.BackgroundLocation) {
        window.BackgroundLocation.updateSocket(socket);
      }
    });
  }

  // ─── Auto Refresh (every 2 minutes) ─────────────────────────────────────────

  setInterval(() => {
    if (currentUser) {
      loadOrders();
      loadStats();
    }
  }, 2 * 60 * 1000);

  // ─── Init ──────────────────────────────────────────────────────────────────

  checkAuth();
})();
