/* ─── Dispatcher (Admin Dashboard) JavaScript ────────────────────────────── */

(function () {
  'use strict';

  // ─── State ──────────────────────────────────────────────────────────────────
  let token = localStorage.getItem('token') || '';
  let currentUser = null;
  let orders = [];
  let drivers = [];
  let currentFilter = '';
  let map = null;
  let driverMarkers = {};
  let socket = null;
  let assigningOrderId = null;

  // Map layers / markers
  let orderLayerGroup = null;
  let pickerMap = null;
  let pickerPickup = null;
  let pickerDropoff = null;
  let pickerLine = null;
  let pickerStep = 'pickup';
  // Charts
  let chartStatus = null;
  let chartRevenue = null;
  let chartHours = null;
  let chartRanking = null;
  let searchTerm = '';

  // ─── Pin icon helpers (colored pickup/dropoff/driver markers) ───────────────
  function pinIcon(kind, emoji) {
    return L.divIcon({
      className: '',
      html: '<div class="pin pin-' + kind + '"><span>' + emoji + '</span></div>',
      iconSize: [28, 28],
      iconAnchor: [14, kind === 'driver' ? 14 : 28],
      popupAnchor: [0, kind === 'driver' ? -14 : -28],
    });
  }
  const ICON_PICKUP = () => pinIcon('pickup', '🟢');
  const ICON_DROPOFF = () => pinIcon('dropoff', '🔴');
  const ICON_DRIVER = () => pinIcon('driver', '🛵');

  // ─── Notification sound (Web Audio, no file needed) ─────────────────────────
  function playBeep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.type = 'sine'; o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.4);
      o.start(); o.stop(ctx.currentTime + 0.4);
    } catch (e) { /* ignore */ }
  }

  // ─── Theme toggle ───────────────────────────────────────────────────────────
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
    const btn = document.getElementById('btn-theme');
    if (btn) btn.textContent = theme === 'light' ? '☀️' : '🌙';
  }
  (function initTheme() {
    applyTheme(localStorage.getItem('theme') || 'dark');
    document.addEventListener('click', (e) => {
      if (e.target && e.target.id === 'btn-theme') {
        const cur = document.documentElement.getAttribute('data-theme');
        applyTheme(cur === 'light' ? 'dark' : 'light');
      }
    });
  })();

  // ─── DOM References ─────────────────────────────────────────────────────────
  const loginScreen = document.getElementById('login-screen');
  const app = document.getElementById('app');
  const loginForm = document.getElementById('login-form');
  const loginError = document.getElementById('login-error');
  const userName = document.getElementById('user-name');
  const btnLogout = document.getElementById('btn-logout');
  const toastContainer = document.getElementById('toast-container');

  // Views
  const viewPedidos = document.getElementById('view-pedidos');
  const viewMapa = document.getElementById('view-mapa');
  const viewRepartidores = document.getElementById('view-repartidores');
  const viewReportes = document.getElementById('view-reportes');

  // Stats
  const statActive = document.getElementById('stat-active');
  const statDrivers = document.getElementById('stat-drivers');
  const statDeliveries = document.getElementById('stat-deliveries');
  const statRevenue = document.getElementById('stat-revenue');

  // Orders
  const ordersList = document.getElementById('orders-list');
  const btnNewOrder = document.getElementById('btn-new-order');
  const modalNewOrder = document.getElementById('modal-new-order');
  const formNewOrder = document.getElementById('form-new-order');
  const btnCancelOrderForm = document.getElementById('btn-cancel-order-form');

  // Drivers
  const driversGrid = document.getElementById('drivers-grid');
  const btnNewDriver = document.getElementById('btn-new-driver');
  const modalNewDriver = document.getElementById('modal-new-driver');
  const formNewDriver = document.getElementById('form-new-driver');
  const btnCancelDriverForm = document.getElementById('btn-cancel-driver-form');

  // Assign modal
  const modalAssign = document.getElementById('modal-assign-driver');
  const assignSelect = document.getElementById('assign-driver-select');
  const btnCancelAssign = document.getElementById('btn-cancel-assign');
  const btnConfirmAssign = document.getElementById('btn-confirm-assign');

  // Reports
  const btnExportCsv = document.getElementById('btn-export-csv');
  const btnExportPdf = document.getElementById('btn-export-pdf');
  const btnLoadSummary = document.getElementById('btn-load-summary');
  const reportsSummary = document.getElementById('reports-summary');
  const reportFrom = document.getElementById('report-from');
  const reportTo = document.getElementById('report-to');

  // Route polyline state
  let currentRoutePolyline = null;

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
    setTimeout(() => {
      toast.remove();
    }, 4000);
  }

  function statusLabel(status) {
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

  function formatTime(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    return d.toLocaleString('es-CO', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' });
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
    userName.textContent = currentUser.name;
    loadData();
    initSocket();
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
        token = data.token;
        localStorage.setItem('token', token);
        currentUser = data.user;
        showApp();
      } else {
        loginError.textContent = data.error || 'Error al iniciar sesion';
      }
    } catch (err) {
      loginError.textContent = 'Error de conexion';
    }
  });

  function logout() {
    token = '';
    localStorage.removeItem('token');
    currentUser = null;
    if (socket) { socket.disconnect(); socket = null; }
    showLogin();
  }

  btnLogout.addEventListener('click', async () => {
    try { await apiFetch('/api/auth/logout', { method: 'POST' }); } catch {}
    logout();
  });

  // ─── Tab Navigation ─────────────────────────────────────────────────────────

  const tabBtns = document.querySelectorAll('.tab-btn');
  tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      tabBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      viewPedidos.classList.toggle('hidden', tab !== 'pedidos');
      viewMapa.classList.toggle('hidden', tab !== 'mapa');
      viewRepartidores.classList.toggle('hidden', tab !== 'repartidores');
      viewReportes.classList.toggle('hidden', tab !== 'reportes');
      const viewChat = document.getElementById('view-chat');
      if (viewChat) viewChat.classList.toggle('hidden', tab !== 'chat');
      const viewConfig = document.getElementById('view-config');
      if (viewConfig) viewConfig.classList.toggle('hidden', tab !== 'config');
      const viewActividad = document.getElementById('view-actividad');
      if (viewActividad) viewActividad.classList.toggle('hidden', tab !== 'actividad');
      if (tab === 'mapa') {
        initMap();
      }
      if (tab === 'repartidores') {
        loadDrivers();
      }
      if (tab === 'chat') {
        renderChatContacts();
      }
      if (tab === 'config') {
        loadConfig();
        initZoneMap();
        loadZones();
      }
      if (tab === 'actividad') {
        loadActivity();
      }
    });
  });

  // ─── Coverage zones ─────────────────────────────────────────────────────────
  let zones = [];
  let zoneMap = null;
  let zoneNewMarker = null;
  let zoneNewCenter = null;
  let zoneCircles = [];

  function initZoneMap() {
    if (zoneMap) { zoneMap.invalidateSize(); return; }
    zoneMap = L.map('zone-map').setView([4.6097, -74.0817], 11);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap', maxZoom: 19 }).addTo(zoneMap);
    zoneMap.on('click', (e) => {
      zoneNewCenter = e.latlng;
      if (zoneNewMarker) zoneNewMarker.setLatLng(e.latlng);
      else zoneNewMarker = L.marker(e.latlng).addTo(zoneMap);
    });
    setTimeout(() => zoneMap.invalidateSize(), 200);
  }

  async function loadZones() {
    try {
      const res = await apiFetch('/api/zones');
      if (!res.ok) return;
      zones = await res.json();
      renderZoneList();
      drawZoneCircles();
      drawZonesOnMainMap();
    } catch {}
  }

  function renderZoneList() {
    const box = document.getElementById('zone-list');
    if (!box) return;
    if (zones.length === 0) { box.innerHTML = '<p style="color:var(--text-muted);font-size:0.83rem;">Sin zonas. La cobertura no se valida.</p>'; return; }
    box.innerHTML = zones.map((z) =>
      '<div style="display:flex;justify-content:space-between;align-items:center;padding:0.4rem 0.6rem;border:1px solid var(--border);border-radius:8px;margin-bottom:0.3rem;">' +
      '<span>📍 ' + escapeHtml(z.name) + ' (' + z.radius_km + ' km)</span>' +
      '<button class="btn btn-danger btn-sm" data-zone-del="' + z.id + '">Eliminar</button></div>'
    ).join('');
    box.querySelectorAll('[data-zone-del]').forEach((b) => {
      b.addEventListener('click', () => deleteZone(parseInt(b.dataset.zoneDel)));
    });
  }

  function drawZoneCircles() {
    if (!zoneMap) return;
    zoneCircles.forEach((c) => zoneMap.removeLayer(c));
    zoneCircles = [];
    zones.forEach((z) => {
      const c = L.circle([z.lat, z.lng], { radius: z.radius_km * 1000, color: '#22c55e', fillOpacity: 0.08 })
        .bindPopup(escapeHtml(z.name)).addTo(zoneMap);
      zoneCircles.push(c);
    });
  }

  let mainMapZoneCircles = [];
  function drawZonesOnMainMap() {
    if (!map) return;
    mainMapZoneCircles.forEach((c) => map.removeLayer(c));
    mainMapZoneCircles = [];
    zones.forEach((z) => {
      const c = L.circle([z.lat, z.lng], { radius: z.radius_km * 1000, color: '#22c55e', weight: 1, fillOpacity: 0.05, dashArray: '4,6' }).addTo(map);
      mainMapZoneCircles.push(c);
    });
  }

  const btnAddZone = document.getElementById('btn-add-zone');
  if (btnAddZone) {
    btnAddZone.addEventListener('click', async () => {
      const name = document.getElementById('zone-name').value.trim();
      const radius = parseFloat(document.getElementById('zone-radius').value);
      if (!name) { showToast('Escribe un nombre de zona', 'warning'); return; }
      if (!zoneNewCenter) { showToast('Haz clic en el mapa para fijar el centro', 'warning'); return; }
      if (!radius || radius <= 0) { showToast('Radio invalido', 'warning'); return; }
      try {
        const res = await apiFetch('/api/zones', {
          method: 'POST',
          body: JSON.stringify({ name, lat: zoneNewCenter.lat, lng: zoneNewCenter.lng, radius_km: radius }),
        });
        if (res.ok) {
          showToast('Zona agregada', 'success');
          document.getElementById('zone-name').value = '';
          if (zoneNewMarker) { zoneMap.removeLayer(zoneNewMarker); zoneNewMarker = null; }
          zoneNewCenter = null;
          loadZones();
        } else showToast('Error al agregar zona', 'error');
      } catch { showToast('Error de conexion', 'error'); }
    });
  }

  async function deleteZone(id) {
    try {
      const res = await apiFetch('/api/zones/' + id, { method: 'DELETE' });
      if (res.ok) { showToast('Zona eliminada', 'success'); loadZones(); }
    } catch {}
  }

  // Coverage check used by the order picker
  function isWithinCoverage(lat, lng) {
    if (zones.length === 0) return true; // no zones defined => no restriction
    return zones.some((z) => haversineKm(lat, lng, z.lat, z.lng) <= z.radius_km);
  }

  // ─── Activity log ───────────────────────────────────────────────────────────
  async function loadActivity() {
    const box = document.getElementById('activity-list');
    if (!box) return;
    try {
      const res = await apiFetch('/api/activity?limit=150');
      if (!res.ok) return;
      const rows = await res.json();
      if (rows.length === 0) { box.innerHTML = '<p style="color:var(--text-muted);padding:1rem;">Sin actividad registrada.</p>'; return; }
      box.innerHTML = rows.map((r) =>
        '<div class="activity-item">' +
        '<span class="ai-action">' + escapeHtml(r.action) + '</span>' +
        '<span class="ai-detail">' + escapeHtml(r.detail || '') + '</span>' +
        '<span class="ai-meta">' + escapeHtml(r.user_name || '-') + ' · ' + formatTime(r.created_at) + '</span>' +
        '</div>'
      ).join('');
    } catch {}
  }
  const btnRefreshActivity = document.getElementById('btn-refresh-activity');
  if (btnRefreshActivity) btnRefreshActivity.addEventListener('click', loadActivity);

  // ─── Proof of delivery (view) ───────────────────────────────────────────────
  async function viewProof(orderId) {
    try {
      const res = await apiFetch('/api/orders/' + orderId + '/proof');
      if (!res.ok) { showToast('Este pedido no tiene foto de entrega', 'warning'); return; }
      const data = await res.json();
      document.getElementById('proof-image').src = data.image;
      document.getElementById('modal-proof').classList.remove('hidden');
    } catch { showToast('Error al cargar la foto', 'error'); }
  }
  const btnCloseProof = document.getElementById('btn-close-proof');
  if (btnCloseProof) btnCloseProof.addEventListener('click', () => document.getElementById('modal-proof').classList.add('hidden'));

  // ─── Settings / Config ──────────────────────────────────────────────────────
  let appSettings = { fare_base: 3000, fare_per_km: 1500, driver_commission_pct: 80, currency: '$', agency_name: 'Agencia de Domicilios' };

  async function loadSettings() {
    try {
      const res = await apiFetch('/api/settings');
      if (res.ok) appSettings = await res.json();
    } catch {}
  }

  async function loadConfig() {
    await loadSettings();
    ['agency_name', 'fare_base', 'fare_per_km', 'driver_commission_pct'].forEach((k) => {
      const el = document.getElementById('cfg-' + k);
      if (el) el.value = appSettings[k];
    });
  }

  const btnSaveConfig = document.getElementById('btn-save-config');
  if (btnSaveConfig) {
    btnSaveConfig.addEventListener('click', async () => {
      const body = {
        agency_name: document.getElementById('cfg-agency_name').value,
        fare_base: document.getElementById('cfg-fare_base').value,
        fare_per_km: document.getElementById('cfg-fare_per_km').value,
        driver_commission_pct: document.getElementById('cfg-driver_commission_pct').value,
      };
      try {
        const res = await apiFetch('/api/settings', { method: 'PUT', body: JSON.stringify(body) });
        if (res.ok) { appSettings = await res.json(); showToast('Configuracion guardada', 'success'); }
        else showToast('Error al guardar', 'error');
      } catch { showToast('Error de conexion', 'error'); }
    });
  }

  // ─── Cierre de caja ─────────────────────────────────────────────────────────
  const btnLoadCash = document.getElementById('btn-load-cash');
  if (btnLoadCash) {
    const cashDate = document.getElementById('cash-date');
    if (cashDate) cashDate.value = new Date().toISOString().slice(0, 10);
    btnLoadCash.addEventListener('click', async () => {
      const date = cashDate.value || new Date().toISOString().slice(0, 10);
      try {
        const res = await apiFetch('/api/reports/cash?date=' + date);
        if (!res.ok) { showToast('Error al cargar caja', 'error'); return; }
        const data = await res.json();
        renderCash(data);
      } catch { showToast('Error de conexion', 'error'); }
    });
  }

  function money(n) { return (appSettings.currency || '$') + Number(n || 0).toLocaleString(); }

  function renderCash(data) {
    const box = document.getElementById('cash-table');
    if (!box) return;
    if (!data.drivers || data.drivers.length === 0) {
      box.innerHTML = '<p style="color:var(--text-muted);padding:1rem;">Sin entregas en esta fecha.</p>';
      return;
    }
    let html = '<table class="cash-table"><thead><tr>' +
      '<th>Repartidor</th><th>Entregas</th><th>Efectivo</th><th>Tarjeta</th><th>Total</th>' +
      '<th>Gana repartidor</th><th>Gana agencia</th></tr></thead><tbody>';
    data.drivers.forEach((d) => {
      html += '<tr><td>' + escapeHtml(d.driver_name) + '</td><td>' + d.deliveries + '</td>' +
        '<td>' + money(d.cash) + '</td><td>' + money(d.card) + '</td><td>' + money(d.total) + '</td>' +
        '<td>' + money(d.driver_earning) + '</td><td>' + money(d.agency_earning) + '</td></tr>';
    });
    const t = data.totals;
    html += '<tr class="total-row"><td>TOTAL (' + data.commission_pct + '% repartidor)</td><td>' + t.deliveries + '</td>' +
      '<td>' + money(t.cash) + '</td><td>' + money(t.card) + '</td><td>' + money(t.total) + '</td>' +
      '<td>' + money(t.driver_earning) + '</td><td>' + money(t.agency_earning) + '</td></tr>';
    html += '</tbody></table>';
    box.innerHTML = html;
  }

  // ─── Chat (admin <-> drivers) ───────────────────────────────────────────────
  let chatActiveDriver = null;
  const chatThreads = {}; // driverId -> [messages]

  function renderChatContacts() {
    const box = document.getElementById('chat-contacts');
    if (!box) return;
    if (drivers.length === 0) {
      box.innerHTML = '<div class="chat-empty">No hay repartidores</div>';
      return;
    }
    box.innerHTML = drivers.map((d) => {
      const online = d.status !== 'offline' ? 'online' : '';
      const active = chatActiveDriver === d.id ? 'active' : '';
      return '<div class="chat-contact ' + active + '" data-driver="' + d.id + '">' +
        '<span class="cc-dot ' + online + '"></span>' + escapeHtml(d.name) + '</div>';
    }).join('');
    box.querySelectorAll('[data-driver]').forEach((el) => {
      el.addEventListener('click', () => openChat(parseInt(el.dataset.driver)));
    });
  }

  async function openChat(driverId) {
    chatActiveDriver = driverId;
    renderChatContacts();
    const d = drivers.find((x) => x.id === driverId);
    document.getElementById('chat-header').textContent = d ? d.name : 'Repartidor';
    const input = document.getElementById('chat-input');
    const send = document.getElementById('chat-send');
    input.disabled = false; send.disabled = false;

    try {
      const res = await apiFetch('/api/chat/' + driverId);
      if (res.ok) {
        chatThreads[driverId] = await res.json();
        renderChatMessages(driverId);
      }
    } catch {}
  }

  function renderChatMessages(driverId) {
    const box = document.getElementById('chat-messages');
    const msgs = chatThreads[driverId] || [];
    if (msgs.length === 0) {
      box.innerHTML = '<div class="chat-empty">No hay mensajes. Saluda 👋</div>';
      return;
    }
    box.innerHTML = msgs.map((m) => {
      const mine = m.sender_role === 'admin';
      return '<div class="chat-msg ' + (mine ? 'mine' : 'theirs') + '">' +
        escapeHtml(m.body) +
        '<span class="cm-time">' + formatTime(m.created_at) + '</span></div>';
    }).join('');
    box.scrollTop = box.scrollHeight;
  }

  function sendChat() {
    const input = document.getElementById('chat-input');
    const body = input.value.trim();
    if (!body || !chatActiveDriver) return;
    socket.emit('chat:send', { driverId: chatActiveDriver, body });
    input.value = '';
  }

  document.getElementById('chat-send').addEventListener('click', sendChat);
  document.getElementById('chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat();
  });

  // ─── Data Loading ───────────────────────────────────────────────────────────

  async function loadData() {
    await Promise.all([loadOrders(), loadStats(), loadDrivers(), loadSettings(), loadZones()]);
  }

  async function loadStats() {
    try {
      const res = await apiFetch('/api/orders/stats');
      if (res.ok) {
        const s = await res.json();
        statActive.textContent = s.active_orders;
        statDrivers.textContent = s.available_drivers;
        statDeliveries.textContent = s.deliveries_today;
        statRevenue.textContent = '$' + (s.revenue_today || 0).toLocaleString();
      }
    } catch {}
  }

  async function loadOrders() {
    try {
      const url = currentFilter ? '/api/orders?status=' + currentFilter : '/api/orders';
      const res = await apiFetch(url);
      if (res.ok) {
        orders = await res.json();
        renderOrders();
      }
    } catch {}
  }

  async function loadDrivers() {
    try {
      const res = await apiFetch('/api/drivers');
      if (res.ok) {
        drivers = await res.json();
        renderDrivers();
      }
    } catch {}
  }

  // ─── Render Orders ──────────────────────────────────────────────────────────

  function renderOrders() {
    ordersList.innerHTML = '';

    // Apply client-side search over the loaded orders
    let list = orders;
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      list = orders.filter((o) =>
        (o.code && o.code.toLowerCase().includes(q)) ||
        (o.customer_name && o.customer_name.toLowerCase().includes(q)) ||
        (o.pickup_address && o.pickup_address.toLowerCase().includes(q)) ||
        (o.dropoff_address && o.dropoff_address.toLowerCase().includes(q))
      );
    }

    if (list.length === 0) {
      ordersList.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:2rem;">No hay pedidos</p>';
      renderOrderPins();
      return;
    }
    list.forEach((order) => {
      const dName = getDriverName(order.driver_id);
      const card = document.createElement('div');
      card.className = 'order-card';
      const waBtn = order.customer_phone
        ? '<button class="btn btn-whatsapp btn-sm" data-wa="' + escapeHtml(order.code) + '" data-phone="' + escapeHtml(order.customer_phone) + '">WhatsApp</button>'
        : '';
      card.innerHTML = `
        <div>
          <span class="order-code">${escapeHtml(order.code)}</span>
          <span class="badge badge-${escapeHtml(order.status)}">${escapeHtml(statusLabel(order.status))}</span>
        </div>
        <div class="order-info">
          <div class="order-customer">${escapeHtml(order.customer_name)}</div>
          <div class="order-addresses">
            <strong>🟢 Recogida:</strong> ${escapeHtml(order.pickup_address || '-')} &rarr; <strong>🔴 Entrega:</strong> ${escapeHtml(order.dropoff_address || '-')}
          </div>
          <div class="order-meta">
            ${dName ? '<span>Repartidor: ' + escapeHtml(dName) + '</span>' : ''}
            <span>${escapeHtml(formatTime(order.created_at))}</span>
            ${order.amount ? '<span>$' + escapeHtml(String(order.amount)) + '</span>' : ''}
            ${order.estimated_distance_km ? '<span>📏 ' + escapeHtml(String(order.estimated_distance_km)) + ' km</span>' : ''}
            ${order.scheduled_at ? '<span title="Programado">📅 ' + escapeHtml(formatTime(order.scheduled_at)) + '</span>' : ''}
          </div>
        </div>
        <div class="order-actions">
          ${order.status === 'pending' ? '<button class="btn btn-primary btn-sm" data-assign="' + order.id + '">Asignar</button>' : ''}
          ${order.status === 'pending' ? '<button class="btn btn-outline btn-sm" data-auto="' + order.id + '" title="Asignar al repartidor disponible mas cercano">⚡ Auto-asignar</button>' : ''}
          ${['assigned', 'picked_up', 'on_the_way'].includes(order.status) ? '<button class="btn btn-outline btn-sm" data-route="' + order.id + '">Ver Ruta</button>' : ''}
          ${order.status === 'delivered' ? '<button class="btn btn-outline btn-sm proof-thumb-btn" data-proof="' + order.id + '">📸 Foto</button>' : ''}
          <button class="btn btn-outline btn-sm" data-copy-link="${escapeHtml(order.code)}">Copiar Link</button>
          ${waBtn}
          ${['pending', 'assigned'].includes(order.status) ? '<button class="btn btn-danger btn-sm" data-cancel="' + order.id + '">Cancelar</button>' : ''}
        </div>
        ${order.rating ? '<div class="review-box">⭐ ' + escapeHtml(String(order.rating)) + '/5' + (order.review ? ' — &ldquo;' + escapeHtml(order.review) + '&rdquo;' : '') + '</div>' : ''}
      `;
      ordersList.appendChild(card);
    });

    // Event delegation for order actions
    ordersList.querySelectorAll('[data-assign]').forEach((btn) => {
      btn.addEventListener('click', () => openAssignModal(parseInt(btn.dataset.assign)));
    });
    ordersList.querySelectorAll('[data-auto]').forEach((btn) => {
      btn.addEventListener('click', () => autoAssign(parseInt(btn.dataset.auto)));
    });
    ordersList.querySelectorAll('[data-proof]').forEach((btn) => {
      btn.addEventListener('click', () => viewProof(parseInt(btn.dataset.proof)));
    });
    ordersList.querySelectorAll('[data-cancel]').forEach((btn) => {
      btn.addEventListener('click', () => cancelOrder(parseInt(btn.dataset.cancel)));
    });
    ordersList.querySelectorAll('[data-route]').forEach((btn) => {
      btn.addEventListener('click', () => showOrderRoute(parseInt(btn.dataset.route)));
    });
    ordersList.querySelectorAll('[data-copy-link]').forEach((btn) => {
      btn.addEventListener('click', () => copyTrackingLink(btn.dataset.copyLink));
    });
    ordersList.querySelectorAll('[data-wa]').forEach((btn) => {
      btn.addEventListener('click', () => sendWhatsApp(btn.dataset.phone, btn.dataset.wa));
    });

    renderOrderPins();
  }

  // ─── WhatsApp notify ─────────────────────────────────────────────────────
  function sendWhatsApp(phone, code) {
    const digits = String(phone).replace(/[^0-9]/g, '');
    const url = location.origin + '/customer.html?code=' + encodeURIComponent(code);
    const msg = `Hola! Puedes seguir tu pedido ${code} en tiempo real aqui: ${url}`;
    window.open('https://wa.me/' + digits + '?text=' + encodeURIComponent(msg), '_blank');
  }

  // ─── Order search ─────────────────────────────────────────────────────────
  (function bindSearch() {
    const input = document.getElementById('order-search');
    if (input) {
      input.addEventListener('input', () => {
        searchTerm = input.value.trim();
        renderOrders();
      });
    }
  })();

  function getDriverName(driverId) {
    if (!driverId) return '';
    const d = drivers.find((dr) => dr.id === driverId);
    return d ? d.name : 'Repartidor #' + driverId;
  }

  // ─── Filter ─────────────────────────────────────────────────────────────────

  document.querySelectorAll('.filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
      loadOrders();
    });
  });

  // ─── Create Order ──────────────────────────────────────────────────────────

  function haversineKm(a, b, c, d) {
    const R = 6371, toR = (x) => x * Math.PI / 180;
    const dLat = toR(c - a), dLng = toR(d - b);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a)) * Math.cos(toR(c)) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  function setPickerField(kind, lat, lng) {
    document.getElementById(kind + '_lat').value = lat;
    document.getElementById(kind + '_lng').value = lng;
  }

  function updateFareHint() {
    const plat = parseFloat(document.getElementById('pickup_lat').value);
    const plng = parseFloat(document.getElementById('pickup_lng').value);
    const dlat = parseFloat(document.getElementById('dropoff_lat').value);
    const dlng = parseFloat(document.getElementById('dropoff_lng').value);
    const hint = document.getElementById('fare-hint');
    if (pickerLine) { pickerMap.removeLayer(pickerLine); pickerLine = null; }
    if (!isNaN(plat) && !isNaN(dlat)) {
      const km = haversineKm(plat, plng, dlat, dlng);
      const base = Number(appSettings.fare_base) || 3000;
      const perKm = Number(appSettings.fare_per_km) || 1500;
      const fare = Math.round((base + km * perKm) / 500) * 500;
      hint.innerHTML = `📏 Distancia: <strong>${km.toFixed(1)} km</strong> · 💰 Tarifa sugerida: <strong>$${fare.toLocaleString()}</strong>`;
      const amountInput = formNewOrder.querySelector('[name="amount"]');
      if (amountInput && (!amountInput.value || amountInput.value === '0')) amountInput.value = fare;
      pickerLine = L.polyline([[plat, plng], [dlat, dlng]], { color: '#f59e0b', weight: 2, dashArray: '6,8' }).addTo(pickerMap);
      if (!isWithinCoverage(dlat, dlng)) {
        hint.innerHTML += '<div style="color:var(--danger);margin-top:4px;">⚠️ La entrega esta fuera de las zonas de cobertura.</div>';
      }
    } else {
      hint.textContent = '';
    }
  }

  function placePickerMarker(kind, lat, lng) {
    const icon = kind === 'pickup' ? ICON_PICKUP() : ICON_DROPOFF();
    const existing = kind === 'pickup' ? pickerPickup : pickerDropoff;
    if (existing) { existing.setLatLng([lat, lng]); }
    else {
      const m = L.marker([lat, lng], { icon, draggable: true }).addTo(pickerMap);
      m.on('dragend', () => { const p = m.getLatLng(); setPickerField(kind, p.lat, p.lng); updateFareHint(); });
      if (kind === 'pickup') pickerPickup = m; else pickerDropoff = m;
    }
    setPickerField(kind, lat, lng);
    updateFareHint();
  }

  function resetPicker() {
    if (pickerPickup) { pickerMap.removeLayer(pickerPickup); pickerPickup = null; }
    if (pickerDropoff) { pickerMap.removeLayer(pickerDropoff); pickerDropoff = null; }
    if (pickerLine) { pickerMap.removeLayer(pickerLine); pickerLine = null; }
    ['pickup_lat', 'pickup_lng', 'dropoff_lat', 'dropoff_lng'].forEach((id) => document.getElementById(id).value = '');
    document.getElementById('fare-hint').textContent = '';
    pickerStep = 'pickup';
  }

  async function geocode(address) {
    if (!address) return null;
    try {
      const res = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(address));
      const data = await res.json();
      if (data && data[0]) return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    } catch (e) { /* ignore */ }
    return null;
  }

  function openOrderModal() {
    modalNewOrder.classList.remove('hidden');
    resetPicker();
    loadCustomers();
    setTimeout(() => {
      if (!pickerMap) {
        pickerMap = L.map('picker-map').setView([4.6097, -74.0817], 12);
        L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
          attribution: 'Tiles &copy; Esri', maxZoom: 19,
        }).addTo(pickerMap);
        pickerMap.on('click', (e) => {
          if (pickerStep === 'pickup') { placePickerMarker('pickup', e.latlng.lat, e.latlng.lng); pickerStep = 'dropoff'; }
          else { placePickerMarker('dropoff', e.latlng.lat, e.latlng.lng); pickerStep = 'pickup'; }
        });
      }
      pickerMap.invalidateSize();
    }, 200);
  }

  btnNewOrder.addEventListener('click', openOrderModal);
  btnCancelOrderForm.addEventListener('click', () => modalNewOrder.classList.add('hidden'));

  // ─── Customer autocomplete ──────────────────────────────────────────────────
  let customersCache = [];
  async function loadCustomers() {
    try {
      const res = await apiFetch('/api/customers');
      if (!res.ok) return;
      customersCache = await res.json();
      const dl = document.getElementById('customers-list');
      if (dl) {
        dl.innerHTML = customersCache.map((c) =>
          '<option value="' + escapeHtml(c.name) + '"></option>'
        ).join('');
      }
    } catch {}
  }
  (function bindCustomerAutofill() {
    const nameInput = document.getElementById('customer_name');
    if (!nameInput) return;
    nameInput.addEventListener('change', () => {
      const match = customersCache.find(
        (c) => c.name.trim().toLowerCase() === nameInput.value.trim().toLowerCase()
      );
      if (!match) return;
      const phone = document.getElementById('customer_phone');
      const drop = document.getElementById('dropoff_address');
      const pick = document.getElementById('pickup_address');
      if (phone && !phone.value) phone.value = match.phone || '';
      if (drop && !drop.value) drop.value = match.last_dropoff || '';
      if (pick && !pick.value) pick.value = match.last_pickup || '';
      if ((pick && pick.value) || (drop && drop.value)) showToast('Datos del cliente autocompletados', 'info');
    });
  })();

  document.getElementById('btn-reset-pins').addEventListener('click', resetPicker);
  document.getElementById('btn-geocode').addEventListener('click', async () => {
    const pAddr = document.getElementById('pickup_address').value.trim();
    const dAddr = document.getElementById('dropoff_address').value.trim();
    showToast('Buscando direcciones...', 'info');
    const p = await geocode(pAddr);
    const d = await geocode(dAddr);
    if (p) placePickerMarker('pickup', p.lat, p.lng);
    if (d) placePickerMarker('dropoff', d.lat, d.lng);
    if (p || d) {
      const pts = [];
      if (p) pts.push([p.lat, p.lng]);
      if (d) pts.push([d.lat, d.lng]);
      pickerMap.fitBounds(pts, { padding: [40, 40], maxZoom: 15 });
      pickerStep = (p && d) ? 'pickup' : (p ? 'dropoff' : 'pickup');
    } else {
      showToast('No se encontraron las direcciones', 'warning');
    }
  });

  formNewOrder.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(formNewOrder);
    const num = (v) => { const n = parseFloat(v); return isNaN(n) ? undefined : n; };
    const body = {
      customer_name: fd.get('customer_name'),
      customer_phone: fd.get('customer_phone'),
      pickup_address: fd.get('pickup_address'),
      dropoff_address: fd.get('dropoff_address'),
      pickup_lat: num(fd.get('pickup_lat')),
      pickup_lng: num(fd.get('pickup_lng')),
      dropoff_lat: num(fd.get('dropoff_lat')),
      dropoff_lng: num(fd.get('dropoff_lng')),
      items: fd.get('items'),
      notes: fd.get('notes'),
      amount: parseFloat(fd.get('amount')) || 0,
      payment_method: fd.get('payment_method'),
      scheduled_at: fd.get('scheduled_at') ? fd.get('scheduled_at').replace('T', ' ') + ':00' : undefined,
    };
    try {
      const res = await apiFetch('/api/orders', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (res.ok) {
        showToast('Pedido creado exitosamente', 'success');
        modalNewOrder.classList.add('hidden');
        formNewOrder.reset();
        resetPicker();
        loadOrders();
        loadStats();
      } else {
        const err = await res.json();
        showToast(err.error || 'Error al crear pedido', 'error');
      }
    } catch {
      showToast('Error de conexion', 'error');
    }
  });

  // ─── Assign Driver ─────────────────────────────────────────────────────────

  function openAssignModal(orderId) {
    assigningOrderId = orderId;
    assignSelect.innerHTML = '';
    drivers.forEach((d) => {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = d.name + (d.status ? ' (' + d.status + ')' : '');
      assignSelect.appendChild(opt);
    });
    modalAssign.classList.remove('hidden');
  }

  btnCancelAssign.addEventListener('click', () => modalAssign.classList.add('hidden'));

  btnConfirmAssign.addEventListener('click', async () => {
    const driverId = parseInt(assignSelect.value);
    if (!driverId || !assigningOrderId) return;
    const notifyWa = document.getElementById('notify-wa');
    const wantWa = notifyWa ? notifyWa.checked : false;
    const orderId = assigningOrderId;
    try {
      const res = await apiFetch('/api/orders/' + orderId + '/assign', {
        method: 'POST',
        body: JSON.stringify({ driver_id: driverId }),
      });
      if (res.ok) {
        const order = await res.json();
        const driver = drivers.find((d) => d.id === driverId);
        showToast('Repartidor asignado', 'success');
        modalAssign.classList.add('hidden');
        if (wantWa) notifyCustomerWhatsApp(order, driver ? driver.name : '');
        loadOrders();
        loadStats();
      } else {
        const err = await res.json();
        showToast(err.error || 'Error al asignar', 'error');
      }
    } catch {
      showToast('Error de conexion', 'error');
    }
  });

  // Auto-assign to nearest available driver
  async function autoAssign(orderId) {
    try {
      const res = await apiFetch('/api/orders/' + orderId + '/auto-assign', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        showToast('Asignado automaticamente a ' + (data.driver_name || 'repartidor'), 'success');
        notifyCustomerWhatsApp(data.order, data.driver_name || '');
        loadOrders();
        loadStats();
      } else {
        showToast(data.error || 'No se pudo auto-asignar', 'warning');
      }
    } catch {
      showToast('Error de conexion', 'error');
    }
  }

  // Open WhatsApp compose with tracking link (customer notification)
  function notifyCustomerWhatsApp(order, driverName) {
    if (!order || !order.customer_phone) return;
    const digits = String(order.customer_phone).replace(/[^0-9]/g, '');
    if (!digits) return;
    const url = location.origin + '/customer.html?code=' + encodeURIComponent(order.code);
    let msg = 'Hola! Tu pedido ' + order.code + ' ya tiene repartidor';
    if (driverName) msg += ' (' + driverName + ')';
    msg += '. Sigue tu entrega en tiempo real aqui: ' + url;
    window.open('https://wa.me/' + digits + '?text=' + encodeURIComponent(msg), '_blank');
  }

  // ─── Cancel Order ──────────────────────────────────────────────────────────

  async function cancelOrder(orderId) {
    if (!confirm('Cancelar este pedido?')) return;
    try {
      const res = await apiFetch('/api/orders/' + orderId, { method: 'DELETE' });
      if (res.ok) {
        showToast('Pedido cancelado', 'warning');
        loadOrders();
        loadStats();
      } else {
        const err = await res.json();
        showToast(err.error || 'Error', 'error');
      }
    } catch {
      showToast('Error de conexion', 'error');
    }
  }

  // ─── Render Drivers ─────────────────────────────────────────────────────────

  function renderDrivers() {
    driversGrid.innerHTML = '';
    if (drivers.length === 0) {
      driversGrid.innerHTML = '<p style="color:var(--text-muted);padding:2rem;">No hay repartidores registrados</p>';
      return;
    }
    drivers.forEach((d) => {
      const statusClass = d.status === 'available' ? 'online' : d.status === 'busy' ? 'busy' : 'offline';
      const statusText = d.status === 'available' ? 'En linea' : d.status === 'busy' ? 'Ocupado' : 'Desconectado';
      const card = document.createElement('div');
      card.className = 'driver-card';
      card.innerHTML = `
        <div class="driver-card-header">
          <h3>${escapeHtml(d.name)}</h3>
          <span class="badge badge-${d.status === 'available' ? 'delivered' : d.status === 'busy' ? 'assigned' : 'cancelled'}">
            <span class="status-dot ${statusClass}"></span> ${escapeHtml(statusText)}
          </span>
        </div>
        <div class="driver-card-details">
          ${d.avg_rating ? '<div class="driver-rating">⭐ ' + escapeHtml(String(d.avg_rating)) + ' / 5</div>' : '<div style="color:var(--text-muted);font-size:0.8rem;">Sin calificaciones</div>'}
          ${d.deliveries != null ? '<div>📦 Entregas: ' + escapeHtml(String(d.deliveries)) + '</div>' : ''}
          ${d.vehicle ? '<div>Vehiculo: ' + escapeHtml(d.vehicle) + '</div>' : ''}
          ${d.plate ? '<div>Placa: ' + escapeHtml(d.plate) + '</div>' : ''}
          ${d.phone ? '<div>Tel: ' + escapeHtml(d.phone) + '</div>' : ''}
          ${d.email ? '<div>Email: ' + escapeHtml(d.email) + '</div>' : ''}
        </div>
      `;
      driversGrid.appendChild(card);
    });
  }

  // ─── Create Driver ─────────────────────────────────────────────────────────

  btnNewDriver.addEventListener('click', () => modalNewDriver.classList.remove('hidden'));
  btnCancelDriverForm.addEventListener('click', () => modalNewDriver.classList.add('hidden'));

  formNewDriver.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(formNewDriver);
    const body = {
      name: fd.get('name'),
      email: fd.get('email'),
      password: fd.get('password'),
      phone: fd.get('phone'),
      vehicle: fd.get('vehicle'),
      plate: fd.get('plate'),
    };
    try {
      const res = await apiFetch('/api/drivers', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (res.ok) {
        showToast('Repartidor creado exitosamente', 'success');
        modalNewDriver.classList.add('hidden');
        formNewDriver.reset();
        loadDrivers();
      } else {
        const err = await res.json();
        showToast(err.error || 'Error al crear repartidor', 'error');
      }
    } catch {
      showToast('Error de conexion', 'error');
    }
  });

  // ─── Map ────────────────────────────────────────────────────────────────────

  function initMap() {
    if (map) {
      map.invalidateSize();
      renderOrderPins();
      return;
    }
    map = L.map('map').setView([4.6097, -74.0817], 12);

    const streets = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap', maxZoom: 19,
    });
    const satellite = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { attribution: 'Tiles &copy; Esri', maxZoom: 19 }
    );
    satellite.addTo(map); // default to satellite as requested
    L.control.layers(
      { 'Satelital': satellite, 'Calles': streets },
      null,
      { position: 'topright' }
    ).addTo(map);

    // Legend
    const legend = L.control({ position: 'bottomleft' });
    legend.onAdd = function () {
      const div = L.DomUtil.create('div', 'map-legend');
      div.innerHTML =
        '<div class="lg-row"><span class="lg-dot lg-pickup"></span> Recogida</div>' +
        '<div class="lg-row"><span class="lg-dot lg-dropoff"></span> Entrega</div>' +
        '<div class="lg-row"><span class="lg-dot lg-driver"></span> Repartidor</div>';
      return div;
    };
    legend.addTo(map);

    orderLayerGroup = L.layerGroup().addTo(map);

    // Add existing driver markers
    drivers.forEach((d) => {
      if (d.lat && d.lng && d.status !== 'offline') {
        addDriverMarker(d);
      }
    });

    renderOrderPins();
    if (typeof drawZonesOnMainMap === 'function') drawZonesOnMainMap();
  }

  // Draw pickup (green) + dropoff (red) markers and a connecting line for active orders
  function renderOrderPins() {
    if (!map || !orderLayerGroup) return;
    orderLayerGroup.clearLayers();
    orders.forEach((o) => {
      if (!['pending', 'assigned', 'picked_up', 'on_the_way'].includes(o.status)) return;
      const hasPickup = o.pickup_lat && o.pickup_lng;
      const hasDropoff = o.dropoff_lat && o.dropoff_lng;
      if (hasPickup) {
        L.marker([o.pickup_lat, o.pickup_lng], { icon: ICON_PICKUP() })
          .bindPopup('<strong>' + escapeHtml(o.code) + '</strong><br>🟢 Recogida<br>' + escapeHtml(o.pickup_address || ''))
          .addTo(orderLayerGroup);
      }
      if (hasDropoff) {
        L.marker([o.dropoff_lat, o.dropoff_lng], { icon: ICON_DROPOFF() })
          .bindPopup('<strong>' + escapeHtml(o.code) + '</strong><br>🔴 Entrega<br>' + escapeHtml(o.dropoff_address || ''))
          .addTo(orderLayerGroup);
      }
      if (hasPickup && hasDropoff) {
        L.polyline([[o.pickup_lat, o.pickup_lng], [o.dropoff_lat, o.dropoff_lng]], {
          color: '#f59e0b', weight: 2, dashArray: '6,8', opacity: 0.7,
        }).addTo(orderLayerGroup);
      }
    });
  }

  function addDriverMarker(d) {
    if (!d.lat || !d.lng) return;
    const marker = L.marker([d.lat, d.lng], { icon: ICON_DRIVER() })
      .bindPopup(`<strong>${escapeHtml(d.name)}</strong><br>🛵 ${escapeHtml(d.vehicle || '-')}<br>Velocidad: ${d.speed || 0} km/h`);
    marker.addTo(map);
    driverMarkers[d.id] = marker;
  }

  function updateDriverMarker(data) {
    if (!map) return;
    if (driverMarkers[data.id]) {
      driverMarkers[data.id].setLatLng([data.lat, data.lng]);
      driverMarkers[data.id].setPopupContent(
        `<strong>${escapeHtml(data.name)}</strong><br>Velocidad: ${data.speed || 0} km/h`
      );
    } else {
      const marker = L.marker([data.lat, data.lng], { icon: ICON_DRIVER() })
        .bindPopup(`<strong>${escapeHtml(data.name)}</strong><br>Velocidad: ${data.speed || 0} km/h`);
      marker.addTo(map);
      driverMarkers[data.id] = marker;
    }
  }

  function removeDriverMarker(data) {
    if (!map) return;
    if (driverMarkers[data.id]) {
      map.removeLayer(driverMarkers[data.id]);
      delete driverMarkers[data.id];
    }
  }

  // ─── Socket.IO ──────────────────────────────────────────────────────────────

  function initSocket() {
    if (socket) return;
    socket = io({ auth: { token } });

    socket.on('connect', () => {
      console.log('Socket conectado');
      const dot = document.getElementById('conn-dot');
      if (dot) dot.classList.add('online');
    });

    socket.on('order:new', (order) => {
      showToast('Nuevo pedido: ' + order.code, 'info');
      playBeep();
      loadOrders();
      loadStats();
    });

    socket.on('chat:message', (msg) => {
      if (!chatThreads[msg.driver_id]) chatThreads[msg.driver_id] = [];
      chatThreads[msg.driver_id].push(msg);
      if (chatActiveDriver === msg.driver_id) {
        renderChatMessages(msg.driver_id);
      } else if (msg.sender_role === 'driver') {
        playBeep();
        showToast('Mensaje de ' + (getDriverName(msg.driver_id) || 'repartidor'), 'info');
      }
    });

    socket.on('order:status', (order) => {
      showToast('Pedido ' + order.code + ': ' + statusLabel(order.status), 'info');
      loadOrders();
      loadStats();
    });

    socket.on('order:assigned', (order) => {
      loadOrders();
    });

    socket.on('driver:location', (data) => {
      updateDriverMarker(data);
    });

    socket.on('driver:offline', (data) => {
      removeDriverMarker(data);
      loadDrivers();
    });

    socket.on('notification', (data) => {
      // Show browser notification
      if ('Notification' in window && Notification.permission === 'granted') {
        let title = 'Notificacion';
        let body = '';
        switch (data.type) {
          case 'order_new':
            title = 'Nuevo Pedido';
            body = data.data && data.data.code ? data.data.code : '';
            break;
          case 'order_delivered':
            title = 'Pedido Entregado';
            body = data.data && data.data.code ? data.data.code : '';
            break;
          case 'driver_offline':
            title = 'Repartidor Desconectado';
            body = data.data && data.data.name ? data.data.name : '';
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
      const dot = document.getElementById('conn-dot');
      if (dot) dot.classList.remove('online');
    });
  }

  // ─── Route Polyline ──────────────────────────────────────────────────────

  async function showOrderRoute(orderId) {
    try {
      const res = await apiFetch('/api/orders/' + orderId + '/route');
      if (res.ok) {
        const points = await res.json();
        if (points.length === 0) {
          showToast('No hay datos de ruta para este pedido', 'warning');
          return;
        }
        // Switch to map tab
        tabBtns.forEach((b) => b.classList.remove('active'));
        document.querySelector('[data-tab="mapa"]').classList.add('active');
        viewPedidos.classList.add('hidden');
        viewMapa.classList.remove('hidden');
        viewRepartidores.classList.add('hidden');
        viewReportes.classList.add('hidden');
        initMap();

        // Remove previous route polyline
        if (currentRoutePolyline) {
          map.removeLayer(currentRoutePolyline);
        }

        const latlngs = points.map((p) => [p.lat, p.lng]);
        currentRoutePolyline = L.polyline(latlngs, {
          color: '#3b82f6',
          weight: 4,
          opacity: 0.8,
        }).addTo(map);

        map.fitBounds(currentRoutePolyline.getBounds(), { padding: [30, 30] });
      } else {
        showToast('Error al cargar la ruta', 'error');
      }
    } catch {
      showToast('Error de conexion', 'error');
    }
  }

  // ─── Copy Tracking Link ────────────────────────────────────────────────────

  function copyTrackingLink(code) {
    const url = location.origin + '/customer.html?code=' + encodeURIComponent(code);
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(() => {
        showToast('Link de seguimiento copiado', 'success');
      }).catch(() => {
        showToast('No se pudo copiar el link', 'error');
      });
    } else {
      // Fallback
      const ta = document.createElement('textarea');
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showToast('Link de seguimiento copiado', 'success');
    }
  }

  // ─── Reports ───────────────────────────────────────────────────────────────

  btnExportCsv.addEventListener('click', () => {
    let url = '/api/reports/orders?format=csv';
    if (reportFrom.value) url += '&from=' + reportFrom.value;
    if (reportTo.value) url += '&to=' + reportTo.value;
    // Trigger download with auth
    downloadReport(url, 'reporte-pedidos.csv');
  });

  btnExportPdf.addEventListener('click', () => {
    let url = '/api/reports/orders?format=pdf';
    if (reportFrom.value) url += '&from=' + reportFrom.value;
    if (reportTo.value) url += '&to=' + reportTo.value;
    downloadReport(url, 'reporte-pedidos.pdf');
  });

  async function downloadReport(url, filename) {
    try {
      const res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
      if (res.ok) {
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(a.href);
        showToast('Reporte descargado', 'success');
      } else {
        showToast('Error al generar el reporte', 'error');
      }
    } catch {
      showToast('Error de conexion', 'error');
    }
  }

  btnLoadSummary.addEventListener('click', async () => {
    let url = '/api/reports/summary?';
    if (reportFrom.value) url += 'from=' + reportFrom.value + '&';
    if (reportTo.value) url += 'to=' + reportTo.value + '&';
    try {
      const res = await apiFetch(url);
      if (res.ok) {
        const data = await res.json();
        document.getElementById('summary-total-orders').textContent = data.total_orders || 0;
        document.getElementById('summary-total-revenue').textContent = '$' + (data.total_revenue || 0).toLocaleString();
        document.getElementById('summary-avg-time').textContent = data.avg_delivery_minutes ? Math.round(data.avg_delivery_minutes) : 0;
        const byStatus = data.orders_by_status || {};
        document.getElementById('summary-delivered').textContent = byStatus.delivered || 0;
        document.getElementById('summary-cancelled').textContent = byStatus.cancelled || 0;
        document.getElementById('summary-pending').textContent = byStatus.pending || 0;
        reportsSummary.classList.remove('hidden');
        renderCharts(data);
      } else {
        showToast('Error al cargar el resumen', 'error');
      }
    } catch {
      showToast('Error de conexion', 'error');
    }
  });

  // ─── Charts (Chart.js) ──────────────────────────────────────────────────────
  function renderCharts(data) {
    if (typeof Chart === 'undefined') return;
    document.getElementById('reports-charts').classList.remove('hidden');
    const labels = ['Pendiente', 'Asignado', 'Recogido', 'En Camino', 'Entregado', 'Cancelado'];
    const keys = ['pending', 'assigned', 'picked_up', 'on_the_way', 'delivered', 'cancelled'];
    const colors = ['#eab308', '#3b82f6', '#f97316', '#a855f7', '#22c55e', '#ef4444'];
    const byStatus = data.orders_by_status || {};
    const counts = keys.map((k) => byStatus[k] || 0);
    const textColor = getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#e8eaed';

    if (chartStatus) chartStatus.destroy();
    chartStatus = new Chart(document.getElementById('chart-status'), {
      type: 'doughnut',
      data: { labels, datasets: [{ data: counts, backgroundColor: colors, borderWidth: 0 }] },
      options: { plugins: { legend: { position: 'bottom', labels: { color: textColor, font: { size: 11 } } } } },
    });

    const delivered = byStatus.delivered || 0;
    const revenue = data.total_revenue || 0;
    if (chartRevenue) chartRevenue.destroy();
    chartRevenue = new Chart(document.getElementById('chart-revenue'), {
      type: 'bar',
      data: {
        labels: ['Total Pedidos', 'Entregados', 'Ingresos ($K)'],
        datasets: [{
          label: 'Resumen',
          data: [data.total_orders || 0, delivered, Math.round(revenue / 1000)],
          backgroundColor: ['#3b82f6', '#22c55e', '#a855f7'],
          borderRadius: 6,
        }],
      },
      options: {
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: textColor }, grid: { display: false } },
          y: { ticks: { color: textColor }, grid: { color: 'rgba(128,128,128,0.15)' } },
        },
      },
    });

    renderDashboardCharts(textColor);
  }

  // Advanced dashboard charts: orders by hour + driver ranking
  async function renderDashboardCharts(textColor) {
    if (typeof Chart === 'undefined') return;
    try {
      const res = await apiFetch('/api/reports/dashboard');
      if (!res.ok) return;
      const data = await res.json();

      const hours = data.orders_by_hour || [];
      if (chartHours) chartHours.destroy();
      chartHours = new Chart(document.getElementById('chart-hours'), {
        type: 'bar',
        data: {
          labels: hours.map((_, i) => i + 'h'),
          datasets: [{ label: 'Pedidos', data: hours, backgroundColor: '#3b82f6', borderRadius: 3 }],
        },
        options: {
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { color: textColor, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 }, grid: { display: false } },
            y: { ticks: { color: textColor, precision: 0 }, grid: { color: 'rgba(128,128,128,0.15)' } },
          },
        },
      });

      const rank = (data.driver_ranking || []).slice(0, 8);
      if (chartRanking) chartRanking.destroy();
      chartRanking = new Chart(document.getElementById('chart-ranking'), {
        type: 'bar',
        data: {
          labels: rank.map((r) => r.name),
          datasets: [{ label: 'Entregas', data: rank.map((r) => r.deliveries), backgroundColor: '#22c55e', borderRadius: 4 }],
        },
        options: {
          indexAxis: 'y',
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { color: textColor, precision: 0 }, grid: { color: 'rgba(128,128,128,0.15)' } },
            y: { ticks: { color: textColor }, grid: { display: false } },
          },
        },
      });
    } catch {}
  }

  // ─── Auto Refresh ──────────────────────────────────────────────────────────

  setInterval(() => {
    if (currentUser) {
      loadStats();
    }
  }, 30000);

  // ─── Init ──────────────────────────────────────────────────────────────────

  checkAuth();
})();
