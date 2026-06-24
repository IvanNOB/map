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

    renderOrderMarkers();
  }

  function renderOrderCard(order) {
    const card = document.createElement('div');
    card.className = 'driver-order-card';
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

    card.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem;">
        <span class="order-code">${escapeHtml(order.code)}</span>
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
            positionMarker = L.marker(latlng, { icon: pinIcon('driver', '🛵') }).addTo(map);
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
    const streets = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap', maxZoom: 19,
    });
    const satellite = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { attribution: 'Tiles &copy; Esri', maxZoom: 19 }
    );
    satellite.addTo(map);
    L.control.layers({ 'Satelital': satellite, 'Calles': streets }, null, { position: 'topright' }).addTo(map);
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
      showToast('Nuevo pedido asignado!', 'info');
      loadOrders();
    });

    socket.on('chat:message', (msg) => {
      dchatMessages.push(msg);
      renderDriverChat();
      if (msg.sender_role === 'admin') {
        showToast('Mensaje de Despacho', 'info');
      }
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

  // ─── Init ──────────────────────────────────────────────────────────────────

  checkAuth();
})();
