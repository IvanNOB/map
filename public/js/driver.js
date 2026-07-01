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
    // Request notification permission
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
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

  // ─── Orders ─────────────────────────────────────────────────────────────────

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

  function startSharing() {
    if (!navigator.geolocation) {
      showToast('Geolocalizacion no disponible', 'error');
      return;
    }
    if (!consentLocation.checked) return;

    sharing = true;
    btnShareLocation.classList.add('hidden');
    btnStopLocation.classList.remove('hidden');

    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude, speed, accuracy } = pos.coords;
        const now = new Date().toLocaleTimeString('es-CO');
        gpsReadout.textContent = `Lat: ${latitude.toFixed(5)} | Lng: ${longitude.toFixed(5)} | Velocidad: ${(speed || 0).toFixed(1)} m/s | Precision: ${(accuracy || 0).toFixed(0)} m | Ultima actualizacion: ${now}`;

        // Update map marker
        if (map) {
          const latlng = [latitude, longitude];
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

        // Emit via Socket.IO
        if (socket && socket.connected) {
          socket.emit('driver:update', {
            lat: latitude,
            lng: longitude,
            speed: speed || 0,
            heading: pos.coords.heading || 0,
            accuracy: accuracy || 0,
          });
        }
      },
      (err) => {
        showToast('Error de geolocalizacion: ' + err.message, 'error');
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
    );
  }

  function stopSharing() {
    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
    sharing = false;
    btnShareLocation.classList.remove('hidden');
    btnStopLocation.classList.add('hidden');

    if (socket && socket.connected) {
      socket.emit('driver:stop');
    }
  }

  // ─── Map ────────────────────────────────────────────────────────────────────

  function initMap() {
    if (map) return;
    map = L.map('driver-map').setView([4.6097, -74.0817], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);
  }

  // ─── Socket.IO ──────────────────────────────────────────────────────────────

  function initSocket() {
    if (socket) return;
    socket = io({ auth: { token } });

    socket.on('connect', () => {
      console.log('Socket conectado (repartidor)');
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
  }

  // ─── Auto Refresh (every 5 minutes) ─────────────────────────────────────────

  setInterval(() => {
    if (currentUser) {
      loadOrders();
    }
  }, 2 * 60 * 1000); // 2 minutos

  // ─── Init ──────────────────────────────────────────────────────────────────

  checkAuth();
})();
