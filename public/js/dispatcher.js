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

  // ─── SOS Alert Sound (urgent siren-like) ────────────────────────────────────
  function playSOSSound() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      // Play 3 alternating tones like a siren
      for (let i = 0; i < 3; i++) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination);
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(800, ctx.currentTime + i * 0.4);
        o.frequency.linearRampToValueAtTime(400, ctx.currentTime + i * 0.4 + 0.2);
        o.frequency.linearRampToValueAtTime(800, ctx.currentTime + i * 0.4 + 0.4);
        g.gain.setValueAtTime(0.3, ctx.currentTime + i * 0.4);
        g.gain.setValueAtTime(0, ctx.currentTime + i * 0.4 + 0.4);
        o.start(ctx.currentTime + i * 0.4);
        o.stop(ctx.currentTime + i * 0.4 + 0.4);
      }
    } catch (e) {}
  }

  // ─── SOS Alert Modal ────────────────────────────────────────────────────────
  function showSOSAlert(data) {
    // Remove previous SOS modal if exists
    var prev = document.getElementById('sos-alert-modal');
    if (prev) prev.remove();

    var overlay = document.createElement('div');
    overlay.id = 'sos-alert-modal';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(239,68,68,0.15);backdrop-filter:blur(4px);animation:pulse 1s infinite;';
    overlay.innerHTML =
      '<div style="background:var(--panel);border:2px solid #ef4444;border-radius:16px;padding:1.5rem;max-width:360px;width:90%;text-align:center;box-shadow:0 0 40px rgba(239,68,68,0.4);">' +
        '<div style="font-size:3rem;margin-bottom:0.5rem;">🚨</div>' +
        '<h2 style="color:#ef4444;margin:0 0 0.5rem;font-size:1.3rem;">SOS — Emergencia</h2>' +
        '<p style="font-size:1rem;margin:0 0 0.3rem;"><strong>' + escapeHtml(data.name || 'Repartidor') + '</strong></p>' +
        '<p style="color:var(--text-muted);font-size:0.85rem;margin:0 0 1rem;">necesita ayuda urgente</p>' +
        (data.lat && data.lng ? '<p style="font-size:0.75rem;color:var(--text-muted);margin:0 0 0.5rem;">📍 ' + Number(data.lat).toFixed(5) + ', ' + Number(data.lng).toFixed(5) + '</p>' : '') +
        '<p style="font-size:0.75rem;color:var(--text-muted);margin:0 0 1rem;">' + new Date(data.timestamp || Date.now()).toLocaleTimeString('es-CO') + '</p>' +
        '<div style="display:flex;gap:0.5rem;justify-content:center;">' +
          (data.lat && data.lng ? '<a href="https://www.google.com/maps?q=' + data.lat + ',' + data.lng + '" target="_blank" rel="noopener" class="btn btn-primary" style="font-size:0.85rem;">🗺️ Ver en Google Maps</a>' : '') +
          '<button id="sos-dismiss" class="btn btn-outline" style="font-size:0.85rem;">Entendido</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    document.getElementById('sos-dismiss').addEventListener('click', function () { overlay.remove(); });
    // Auto-dismiss after 2 minutes
    setTimeout(function () { if (overlay.parentNode) overlay.remove(); }, 120000);
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
    autoCleanOldOrders();
    // Request notification permission + subscribe to push
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
    if (window.enablePush) window.enablePush(token);
  }

  // ─── Auto-limpieza diaria de pedidos viejos ─────────────────────────────────
  // Al iniciar sesión, archiva pedidos entregados/cancelados de días anteriores
  async function autoCleanOldOrders() {
    const todayStr = new Date().toISOString().slice(0, 10);
    const cleanKey = 'auto_clean_' + todayStr;
    // Solo limpiar una vez por día
    if (localStorage.getItem(cleanKey)) return;
    try {
      const res = await apiFetch('/api/orders/auto-clean', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        localStorage.setItem(cleanKey, 'true');
        if (data.archived > 0) {
          showToast('📦 Se archivaron ' + data.archived + ' pedidos de dias anteriores', 'info');
        }
      }
    } catch (e) { /* silently fail */ }
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

  // ─── Refresh Button ─────────────────────────────────────────────────────────

  const btnRefresh = document.getElementById('btn-refresh');
  if (btnRefresh) {
    btnRefresh.addEventListener('click', async () => {
      btnRefresh.disabled = true;
      btnRefresh.style.opacity = '0.5';
      btnRefresh.style.animation = 'spin 0.8s linear infinite';
      try {
        await loadData();
        showToast('Datos actualizados', 'success');
      } catch {
        showToast('Error al refrescar', 'error');
      } finally {
        btnRefresh.disabled = false;
        btnRefresh.style.opacity = '1';
        btnRefresh.style.animation = '';
      }
    });
  }

  // ─── Tab Navigation ─────────────────────────────────────────────────────────

  const tabBtns = document.querySelectorAll('.tab-btn');
  tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      tabBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      viewPedidos.classList.toggle('hidden', tab !== 'pedidos');
      viewRepartidores.classList.toggle('hidden', tab !== 'repartidores');
      viewReportes.classList.toggle('hidden', tab !== 'reportes');
      const viewConfig = document.getElementById('view-config');
      if (viewConfig) viewConfig.classList.toggle('hidden', tab !== 'config');
      const viewActividad = document.getElementById('view-actividad');
      if (viewActividad) viewActividad.classList.toggle('hidden', tab !== 'actividad');
      if (tab === 'pedidos') {
        initMap();
        loadDrivers().then(() => { refreshDriverMarkers(); renderChatContacts(); });
      }
      if (tab === 'repartidores') {
        loadDrivers();
      }
      if (tab === 'config') {
        loadConfig();
        initZoneMap();
        loadZones();
        loadBranches();
        initPlaceMap();
        loadPlaces();
        loadRestaurants();
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
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { attribution: '&copy; CartoDB', maxZoom: 19 }).addTo(zoneMap);
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

  // ─── Branches (multi-sucursal) ──────────────────────────────────────────────
  let branches = [];
  async function loadBranches() {
    try {
      const res = await apiFetch('/api/branches');
      if (!res.ok) return;
      branches = await res.json();
      renderBranchList();
      populateBranchSelect();
    } catch {}
  }
  function renderBranchList() {
    const box = document.getElementById('branch-list');
    if (!box) return;
    if (branches.length === 0) { box.innerHTML = '<p style="color:var(--text-muted);font-size:0.83rem;">Sin sucursales.</p>'; return; }
    box.innerHTML = branches.map((b) =>
      '<div style="display:flex;justify-content:space-between;align-items:center;padding:0.4rem 0.6rem;border:1px solid var(--border);border-radius:8px;margin-bottom:0.3rem;">' +
      '<span>🏢 ' + escapeHtml(b.name) + (b.address ? ' — ' + escapeHtml(b.address) : '') + '</span>' +
      '<button class="btn btn-danger btn-sm" data-branch-del="' + b.id + '">Eliminar</button></div>'
    ).join('');
    box.querySelectorAll('[data-branch-del]').forEach((el) => {
      el.addEventListener('click', async () => {
        try { const r = await apiFetch('/api/branches/' + el.dataset.branchDel, { method: 'DELETE' }); if (r.ok) { showToast('Sucursal eliminada', 'success'); loadBranches(); } } catch {}
      });
    });
  }
  function populateBranchSelect() {
    const sel = document.getElementById('order-branch');
    if (!sel) return;
    sel.innerHTML = '<option value="">— Manual —</option>' +
      branches.map((b) => '<option value="' + b.id + '">' + escapeHtml(b.name) + '</option>').join('');
  }
  function branchName(id) {
    const b = branches.find((x) => x.id === id);
    return b ? b.name : 'Sucursal';
  }

  // ─── Restaurants (management) ───────────────────────────────────────────────
  let restaurants = [];
  async function loadRestaurants() {
    try {
      const res = await apiFetch('/api/restaurants');
      if (!res.ok) return;
      restaurants = await res.json();
      renderRestaurantList();
    } catch {}
  }
  function restaurantName(id) {
    const r = restaurants.find((x) => x.id === id);
    return r ? r.name : 'Restaurante';
  }
  function renderRestaurantList() {
    const box = document.getElementById('restaurant-list');
    if (!box) return;
    if (restaurants.length === 0) { box.innerHTML = '<p style="color:var(--text-muted);font-size:0.83rem;">Sin restaurantes registrados.</p>'; return; }
    box.innerHTML = restaurants.map((r) => {
      const phoneDigits = r.phone ? String(r.phone).replace(/[^\d]/g, '') : '';
      const waBtn = phoneDigits ? '<a class="btn btn-whatsapp btn-sm" href="https://wa.me/' + phoneDigits + '" target="_blank" rel="noopener">💬 WhatsApp</a>' : '';
      return '<div style="display:flex;justify-content:space-between;align-items:center;gap:0.5rem;padding:0.4rem 0.6rem;border:1px solid var(--border);border-radius:8px;margin-bottom:0.3rem;">' +
      '<span style="flex:1;">🍴 ' + escapeHtml(r.name) + ' <span style="color:var(--text-muted);font-size:0.8rem;">(' + escapeHtml(r.email) + ')</span>' +
      (r.phone ? ' <span style="font-size:0.75rem;">📱 ' + escapeHtml(r.phone) + '</span>' : '') + '</span>' +
      waBtn +
      '<button class="btn btn-danger btn-sm" data-rest-del="' + r.id + '">Eliminar</button></div>';
    }).join('');
    box.querySelectorAll('[data-rest-del]').forEach((el) => {
      el.addEventListener('click', async () => {
        if (!confirm('¿Eliminar este restaurante?')) return;
        try { const res = await apiFetch('/api/restaurants/' + el.dataset.restDel, { method: 'DELETE' }); if (res.ok) { showToast('Restaurante eliminado', 'success'); loadRestaurants(); } } catch {}
      });
    });
  }
  const btnAddRestaurant = document.getElementById('btn-add-restaurant');
  if (btnAddRestaurant) {
    btnAddRestaurant.addEventListener('click', async () => {
      const body = {
        name: document.getElementById('r-name').value.trim(),
        email: document.getElementById('r-email').value.trim(),
        password: document.getElementById('r-password').value,
        phone: document.getElementById('r-phone').value.trim(),
        address: document.getElementById('r-address').value.trim(),
      };
      const lat = parseFloat(document.getElementById('r-lat').value);
      const lng = parseFloat(document.getElementById('r-lng').value);
      if (!isNaN(lat)) body.lat = lat;
      if (!isNaN(lng)) body.lng = lng;
      if (!body.name || !body.email || !body.password) { showToast('Nombre, email y contraseña son obligatorios', 'warning'); return; }
      try {
        const res = await apiFetch('/api/restaurants', { method: 'POST', body: JSON.stringify(body) });
        const data = await res.json();
        if (res.ok) {
          showToast('Restaurante creado', 'success');
          ['r-name', 'r-email', 'r-password', 'r-phone', 'r-address', 'r-lat', 'r-lng'].forEach((id) => { document.getElementById(id).value = ''; });
          loadRestaurants();
        } else showToast(data.error || 'Error al crear', 'error');
      } catch { showToast('Error de conexion', 'error'); }
    });
  }
  const btnRGeocode = document.getElementById('btn-r-geocode');
  if (btnRGeocode) {
    btnRGeocode.addEventListener('click', async () => {
      const addr = document.getElementById('r-address').value.trim();
      if (!addr) { showToast('Escribe una direccion primero', 'warning'); return; }
      showToast('Buscando direccion...', 'info');
      const r = await geocode(addr);
      if (r) {
        document.getElementById('r-lat').value = r.lat.toFixed(6);
        document.getElementById('r-lng').value = r.lng.toFixed(6);
        showToast('Coordenadas encontradas', 'success');
      } else showToast('No se encontro la direccion', 'warning');
    });
  }

  // ─── Places / Points of interest ────────────────────────────────────────────
  const PLACE_EMOJI = { local: '🏪', restaurante: '🍽️', farmacia: '💊', cliente: '🏠', otro: '📍' };
  let places = [];
  let editingPlaceId = null;
  let placeMap = null;
  let placeNewMarker = null;
  let placeNewCenter = null;
  let placeMarkersConfig = [];
  let placeMarkersMain = [];

  function placeIcon(category) {
    const emoji = PLACE_EMOJI[category] || '📍';
    return L.divIcon({
      className: '',
      html: '<div style="font-size:22px;line-height:1;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5));">' + emoji + '</div>',
      iconSize: [24, 24],
      iconAnchor: [12, 22],
      popupAnchor: [0, -20],
    });
  }

  function initPlaceMap() {
    if (placeMap) { placeMap.invalidateSize(); return; }
    placeMap = L.map('place-map').setView([4.6097, -74.0817], 12);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { attribution: '&copy; CartoDB', maxZoom: 19 }).addTo(placeMap);
    placeMap.on('click', (e) => {
      setPlaceCoords(e.latlng.lat, e.latlng.lng, true);
    });
    setTimeout(() => placeMap.invalidateSize(), 200);
  }

  // Set the place coordinates (from map click, typing, or geocoding) and move the marker
  function setPlaceCoords(lat, lng, fromMap) {
    placeNewCenter = { lat: lat, lng: lng };
    const latI = document.getElementById('place-lat');
    const lngI = document.getElementById('place-lng');
    if (latI) latI.value = Number(lat).toFixed(6);
    if (lngI) lngI.value = Number(lng).toFixed(6);
    if (placeMap) {
      if (placeNewMarker) placeNewMarker.setLatLng([lat, lng]);
      else placeNewMarker = L.marker([lat, lng]).addTo(placeMap);
      if (!fromMap) placeMap.setView([lat, lng], 15);
    }
  }

  async function loadPlaces() {
    try {
      const res = await apiFetch('/api/places');
      if (!res.ok) return;
      places = await res.json();
      renderPlaceList();
      populatePlaceSelect();
      drawPlacesConfig();
      drawPlacesOnMainMap();
    } catch {}
  }

  function renderPlaceList() {
    const box = document.getElementById('place-list');
    if (!box) return;
    if (places.length === 0) { box.innerHTML = '<p style="color:var(--text-muted);font-size:0.83rem;">Sin lugares guardados.</p>'; return; }
    box.innerHTML = places.map((p) =>
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:0.5rem;padding:0.4rem 0.6rem;border:1px solid var(--border);border-radius:8px;margin-bottom:0.3rem;">' +
      '<span style="flex:1;">' + (PLACE_EMOJI[p.category] || '📍') + ' ' + escapeHtml(p.name) + (p.address ? ' — ' + escapeHtml(p.address) : '') + '</span>' +
      '<button class="btn btn-outline btn-sm" data-place-edit="' + p.id + '">Editar</button>' +
      '<button class="btn btn-danger btn-sm" data-place-del="' + p.id + '">Eliminar</button></div>'
    ).join('');
    box.querySelectorAll('[data-place-del]').forEach((el) => {
      el.addEventListener('click', async () => {
        try { const r = await apiFetch('/api/places/' + el.dataset.placeDel, { method: 'DELETE' }); if (r.ok) { showToast('Lugar eliminado', 'success'); if (editingPlaceId === parseInt(el.dataset.placeDel)) resetPlaceForm(); loadPlaces(); } } catch {}
      });
    });
    box.querySelectorAll('[data-place-edit]').forEach((el) => {
      el.addEventListener('click', () => editPlace(parseInt(el.dataset.placeEdit)));
    });
  }

  // Load a place into the form for editing
  function editPlace(id) {
    const p = places.find((x) => x.id === id);
    if (!p) return;
    editingPlaceId = id;
    document.getElementById('place-name').value = p.name || '';
    document.getElementById('place-category').value = p.category || 'otro';
    document.getElementById('place-address').value = p.address || '';
    setPlaceCoords(p.lat, p.lng, false);
    const btn = document.getElementById('btn-add-place');
    if (btn) btn.textContent = 'Guardar cambios';
    const cancel = document.getElementById('btn-cancel-place');
    if (cancel) cancel.classList.remove('hidden');
    showToast('Editando: ' + p.name, 'info');
  }

  function resetPlaceForm() {
    editingPlaceId = null;
    document.getElementById('place-name').value = '';
    document.getElementById('place-address').value = '';
    document.getElementById('place-lat').value = '';
    document.getElementById('place-lng').value = '';
    document.getElementById('place-category').value = 'local';
    if (placeNewMarker && placeMap) { placeMap.removeLayer(placeNewMarker); placeNewMarker = null; }
    placeNewCenter = null;
    const btn = document.getElementById('btn-add-place');
    if (btn) btn.textContent = 'Agregar lugar';
    const cancel = document.getElementById('btn-cancel-place');
    if (cancel) cancel.classList.add('hidden');
  }

  function populatePlaceSelect() {
    const sel = document.getElementById('order-place');
    if (!sel) return;
    sel.innerHTML = '<option value="">— Ninguno —</option>' +
      places.map((p) => '<option value="' + p.id + '">' + (PLACE_EMOJI[p.category] || '📍') + ' ' + escapeHtml(p.name) + '</option>').join('');
  }

  function drawPlacesConfig() {
    if (!placeMap) return;
    placeMarkersConfig.forEach((m) => placeMap.removeLayer(m));
    placeMarkersConfig = [];
    places.forEach((p) => {
      const m = L.marker([p.lat, p.lng], { icon: placeIcon(p.category) }).bindPopup(escapeHtml(p.name)).addTo(placeMap);
      placeMarkersConfig.push(m);
    });
  }

  function drawPlacesOnMainMap() {
    if (!map) return;
    placeMarkersMain.forEach((m) => map.removeLayer(m));
    placeMarkersMain = [];
    places.forEach((p) => {
      const m = L.marker([p.lat, p.lng], { icon: placeIcon(p.category) })
        .bindPopup('<strong>' + escapeHtml(p.name) + '</strong><br>' + (PLACE_EMOJI[p.category] || '') + ' ' + escapeHtml(p.category) + (p.address ? '<br>' + escapeHtml(p.address) : ''))
        .addTo(map);
      placeMarkersMain.push(m);
    });
  }

  const btnAddPlace = document.getElementById('btn-add-place');
  if (btnAddPlace) {
    btnAddPlace.addEventListener('click', async () => {
      const name = document.getElementById('place-name').value.trim();
      const category = document.getElementById('place-category').value;
      const address = document.getElementById('place-address').value.trim();
      // Prefer typed coordinates; otherwise use the marker placed on the map
      const latVal = parseFloat(document.getElementById('place-lat').value);
      const lngVal = parseFloat(document.getElementById('place-lng').value);
      let lat = !isNaN(latVal) ? latVal : (placeNewCenter ? placeNewCenter.lat : NaN);
      let lng = !isNaN(lngVal) ? lngVal : (placeNewCenter ? placeNewCenter.lng : NaN);
      if (!name) { showToast('Escribe un nombre', 'warning'); return; }
      if (isNaN(lat) || isNaN(lng)) { showToast('Indica la ubicacion: clic en el mapa, coordenadas o buscar direccion', 'warning'); return; }
      try {
        const editing = editingPlaceId != null;
        const res = await apiFetch('/api/places' + (editing ? '/' + editingPlaceId : ''), {
          method: editing ? 'PUT' : 'POST',
          body: JSON.stringify({ name, category, address, lat, lng }),
        });
        if (res.ok) {
          showToast(editing ? 'Lugar actualizado' : 'Lugar agregado', 'success');
          resetPlaceForm();
          loadPlaces();
        } else showToast('Error al guardar lugar', 'error');
      } catch { showToast('Error de conexion', 'error'); }
    });
  }

  const btnCancelPlace = document.getElementById('btn-cancel-place');
  if (btnCancelPlace) btnCancelPlace.addEventListener('click', resetPlaceForm);

  // Typing coordinates manually moves the marker
  ['place-lat', 'place-lng'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', () => {
      const lat = parseFloat(document.getElementById('place-lat').value);
      const lng = parseFloat(document.getElementById('place-lng').value);
      if (!isNaN(lat) && !isNaN(lng)) setPlaceCoords(lat, lng, false);
    });
  });

  // Find coordinates from the address (geocoding)
  const btnPlaceGeocode = document.getElementById('btn-place-geocode');
  if (btnPlaceGeocode) {
    btnPlaceGeocode.addEventListener('click', async () => {
      const addr = document.getElementById('place-address').value.trim();
      if (!addr) { showToast('Escribe una direccion primero', 'warning'); return; }
      showToast('Buscando direccion...', 'info');
      const r = await geocode(addr);
      if (r) { setPlaceCoords(r.lat, r.lng, false); showToast('Ubicacion encontrada', 'success'); }
      else showToast('No se encontro la direccion', 'warning');
    });
  }

  // When a saved place is chosen in the new-order form, fill pickup fields
  const orderPlaceSel = document.getElementById('order-place');
  if (orderPlaceSel) {
    orderPlaceSel.addEventListener('change', () => {
      const p = places.find((x) => String(x.id) === orderPlaceSel.value);
      if (!p) return;
      const pickAddr = document.getElementById('pickup_address');
      if (pickAddr) pickAddr.value = p.name || p.address;
      document.getElementById('pickup_lat').value = p.lat;
      document.getElementById('pickup_lng').value = p.lng;
      if (typeof placePickerMarker === 'function' && pickerMap) {
        placePickerMarker('pickup', p.lat, p.lng);
        pickerMap.setView([p.lat, p.lng], 14);
        pickerStep = 'dropoff';
      }
      showToast('Recogida fijada en ' + p.name, 'info');
    });
  }
  const btnAddBranch = document.getElementById('btn-add-branch');
  if (btnAddBranch) {
    btnAddBranch.addEventListener('click', async () => {
      const name = document.getElementById('branch-name').value.trim();
      const address = document.getElementById('branch-address').value.trim();
      if (!name) { showToast('Escribe un nombre', 'warning'); return; }
      try {
        const res = await apiFetch('/api/branches', { method: 'POST', body: JSON.stringify({ name, address }) });
        if (res.ok) { showToast('Sucursal agregada', 'success'); document.getElementById('branch-name').value = ''; document.getElementById('branch-address').value = ''; loadBranches(); }
        else showToast('Error al agregar', 'error');
      } catch { showToast('Error de conexion', 'error'); }
    });
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
  let appSettings = { fare_base: 3000, fare_per_km: 1500, driver_commission_pct: 80, currency: '$', agency_name: 'Servicio Ghost' };

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

  // ─── Change own password ────────────────────────────────────────────────────
  const btnChangePassword = document.getElementById('btn-change-password');
  if (btnChangePassword) {
    btnChangePassword.addEventListener('click', async () => {
      const current = document.getElementById('cfg-current-password').value;
      const next = document.getElementById('cfg-new-password').value;
      if (!current || !next) { showToast('Completa ambos campos', 'warning'); return; }
      if (next.length < 6) { showToast('La nueva contraseña debe tener al menos 6 caracteres', 'warning'); return; }
      try {
        const res = await apiFetch('/api/auth/change-password', {
          method: 'POST',
          body: JSON.stringify({ current_password: current, new_password: next }),
        });
        const data = await res.json();
        if (res.ok) {
          showToast('Contraseña cambiada correctamente', 'success');
          document.getElementById('cfg-current-password').value = '';
          document.getElementById('cfg-new-password').value = '';
        } else {
          showToast(data.error || 'Error al cambiar contraseña', 'error');
        }
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
  const chatUnread = {};  // driverId -> count of unread messages

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
      const unread = chatUnread[d.id] > 0
        ? '<span class="cc-unread">' + (chatUnread[d.id] > 9 ? '9+' : chatUnread[d.id]) + '</span>'
        : '';
      const hasUnread = chatUnread[d.id] > 0 ? ' has-unread' : '';
      return '<div class="chat-contact ' + active + hasUnread + '" data-driver="' + d.id + '">' +
        '<span class="cc-dot ' + online + '"></span>' + escapeHtml(d.name) + unread + '</div>';
    }).join('');
    box.querySelectorAll('[data-driver]').forEach((el) => {
      el.addEventListener('click', () => openChat(parseInt(el.dataset.driver)));
    });
  }

  async function openChat(driverId) {
    chatActiveDriver = driverId;
    chatUnread[driverId] = 0;
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

  // ─── Enviar notificacion (aviso) a repartidores ─────────────────────────────
  const btnNotify = document.getElementById('btn-notify');
  if (btnNotify) {
    btnNotify.addEventListener('click', async () => {
      const target = chatActiveDriver;
      const who = target ? (getDriverName(target) || 'el repartidor') : 'TODOS los repartidores';
      const msg = prompt('Escribe el aviso para ' + who + ':');
      if (msg == null) return;
      const body = msg.trim();
      if (!body) { showToast('Escribe un mensaje', 'warning'); return; }
      try {
        const res = await apiFetch('/api/push/notify', {
          method: 'POST',
          body: JSON.stringify({ driver_id: target || 'all', title: 'Aviso de Despacho', body }),
        });
        const data = await res.json();
        if (res.ok) showToast('Aviso enviado a ' + data.sent + ' repartidor(es)', 'success');
        else showToast(data.error || 'No se pudo enviar el aviso', 'error');
      } catch { showToast('Error de conexion', 'error'); }
    });
  }

  // ─── Data Loading ───────────────────────────────────────────────────────────

  async function loadData() {
    await Promise.all([loadOrders(), loadStats(), loadDrivers(), loadSettings(), loadZones(), loadBranches(), loadPlaces(), loadRestaurants()]);
    // The map now lives in the default "Pedidos y Mapa" console view, so init it on load.
    initMap();
    refreshDriverMarkers();
    renderChatContacts();
    renderRestaurantWaPanel();
  }

  // Render restaurant WhatsApp buttons in main panel
  function renderRestaurantWaPanel() {
    const box = document.getElementById('restaurant-wa-list');
    if (!box) return;
    if (!restaurants || restaurants.length === 0) {
      box.innerHTML = '<span style="color:var(--text-muted);font-size:0.75rem;">Sin restaurantes</span>';
      return;
    }
    box.innerHTML = restaurants.map(r => {
      const phoneDigits = r.phone ? String(r.phone).replace(/[^\d]/g, '') : '';
      if (!phoneDigits) return '<span style="font-size:0.75rem;color:var(--text-muted);">' + escapeHtml(r.name) + ' (sin tel)</span>';
      return '<a href="https://wa.me/' + phoneDigits + '" target="_blank" rel="noopener" style="display:flex;align-items:center;gap:0.4rem;padding:0.3rem 0.5rem;border:1px solid var(--border);border-radius:6px;text-decoration:none;color:var(--text);font-size:0.75rem;">' +
        '<span style="color:#25d366;">💬</span> ' + escapeHtml(r.name) + '</a>';
    }).join('');
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
      card.className = 'order-card order-clickable status-' + order.status;
      card.dataset.orderId = order.id;
      card.title = 'Clic para ver este pedido en el mapa';
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
          ${order.status === 'pending' ? nearestHintHtml(order) : ''}
          <div class="order-meta">
            ${dName ? '<span>Repartidor: ' + escapeHtml(dName) + '</span>' : ''}
            <span>${escapeHtml(formatTime(order.created_at))}</span>
            ${order.amount ? '<span>$' + escapeHtml(String(order.amount)) + '</span>' : ''}
            ${order.estimated_distance_km ? '<span>📏 ' + escapeHtml(String(order.estimated_distance_km)) + ' km</span>' : ''}
            ${order.scheduled_at ? '<span title="Programado">📅 ' + escapeHtml(formatTime(order.scheduled_at)) + '</span>' : ''}
            ${order.branch_id ? '<span>🏢 ' + escapeHtml(branchName(order.branch_id)) + '</span>' : ''}
            ${order.restaurant_id ? '<span title="Enviado por restaurante">🍴 ' + escapeHtml(restaurantName(order.restaurant_id)) + '</span>' : ''}
          </div>
        </div>
        <div class="order-actions">
          ${order.status !== 'cancelled' ? '<button class="btn btn-outline btn-sm" data-edit="' + order.id + '">✏️ Editar</button>' : ''}
          ${order.status === 'pending' ? '<button class="btn btn-primary btn-sm" data-assign="' + order.id + '">Asignar</button>' : ''}
          ${order.status === 'pending' ? '<button class="btn btn-outline btn-sm" data-auto="' + order.id + '" title="Asignar al repartidor disponible mas cercano">⚡ Auto-asignar</button>' : ''}
          ${['assigned', 'picked_up', 'on_the_way'].includes(order.status) ? '<button class="btn btn-warning btn-sm" data-reassign="' + order.id + '">🔄 Reasignar</button>' : ''}
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
    ordersList.querySelectorAll('[data-reassign]').forEach((btn) => {
      btn.addEventListener('click', () => openAssignModal(parseInt(btn.dataset.reassign)));
    });
    ordersList.querySelectorAll('[data-edit]').forEach((btn) => {
      btn.addEventListener('click', () => openEditOrder(parseInt(btn.dataset.edit)));
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

    // Clic en la tarjeta (no en un boton) -> volar al pedido en el mapa
    ordersList.querySelectorAll('.order-card').forEach((card) => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('button, a, input, textarea, select')) return;
        focusOrderOnMap(parseInt(card.dataset.orderId));
      });
    });

    renderOrderPins();
  }

  // ─── Enfocar un pedido en el mapa (despacho rápido) ──────────────────────────
  let orderHighlight = null;
  function focusOrderOnMap(orderId) {
    const o = orders.find((x) => x.id === orderId);
    if (!o) return;

    // Marcar la tarjeta seleccionada
    ordersList.querySelectorAll('.order-card.selected').forEach((c) => c.classList.remove('selected'));
    const card = ordersList.querySelector('[data-order-id="' + orderId + '"]');
    if (card) card.classList.add('selected');

    if (!map) initMap();

    const pts = [];
    if (o.pickup_lat && o.pickup_lng) pts.push([o.pickup_lat, o.pickup_lng]);
    if (o.dropoff_lat && o.dropoff_lng) pts.push([o.dropoff_lat, o.dropoff_lng]);

    if (pts.length === 0) {
      showToast('Este pedido aun no tiene ubicacion en el mapa', 'warning');
      return;
    }

    // Anillo de resaltado sobre el punto de recogida (o entrega)
    if (orderHighlight) { map.removeLayer(orderHighlight); orderHighlight = null; }
    orderHighlight = L.circleMarker(pts[0], {
      radius: 24, color: '#f59e0b', weight: 3, fillColor: '#f59e0b', fillOpacity: 0.15,
    }).addTo(map);

    if (pts.length === 1) {
      map.setView(pts[0], 16);
    } else {
      try { map.fitBounds(pts, { padding: [60, 60], maxZoom: 16 }); } catch (e) {}
    }
  }

  // ─── WhatsApp notify ─────────────────────────────────────────────────────
  function sendWhatsApp(phone, code) {
    const digits = String(phone).replace(/[^0-9]/g, '');
    const url = location.origin + '/customer.html?code=' + encodeURIComponent(code);
    const msg = [
      '*SERVICIOS GHOST*',
      '',
      'En Servicios Ghost no nos detenemos y seguimos evolucionando para ti! Queremos contarte que hemos activado un nuevo sistema de seguimiento de pedidos.',
      '',
      'A partir de ahora, tendras el control total de tus entregas:',
      '- Mayor tranquilidad: Sabras exactamente el estado de tu domicilio.',
      '- Maxima seguridad: Todo monitoreado directamente por nuestra central logistica.',
      '- Rapidez garantizada: Rompemos las barreras del tiempo con tecnologia premium.',
      '',
      'Sigue tu pedido *' + code + '* en tiempo real aqui:',
      url,
      '',
      'Tienes un antojo o necesitas despachar en tu negocio? Pruebalo ya mismo! Tu entrega esta en las mejores manos.',
      '',
      'Guarda nuestro contacto y pide al instante: 321 428 6626',
    ].join('\n');
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

  // Sugiere el repartidor disponible mas cercano al punto de recogida (eficiencia)
  function nearestHintHtml(order) {
    if (order.pickup_lat == null || order.pickup_lng == null) return '';
    let best = null, bestKm = Infinity;
    drivers.forEach((d) => {
      if (d.status === 'offline' || d.lat == null || d.lng == null) return;
      const km = haversineKm(order.pickup_lat, order.pickup_lng, d.lat, d.lng);
      if (km < bestKm) { bestKm = km; best = d; }
    });
    if (!best) return '<div class="near-driver none">⚠️ Sin repartidores en linea</div>';
    return '<div class="near-driver">🛵 Mas cercano: <strong>' + escapeHtml(best.name) +
      '</strong> · ' + bestKm.toFixed(1) + ' km</div>';
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

  // Fetch fastest driving route geometry from OSRM (free, no key)
  async function osrmRoute(lat1, lng1, lat2, lng2) {
    try {
      const url = `https://router.project-osrm.org/route/v1/driving/${lng1},${lat1};${lng2},${lat2}?overview=full&geometries=geojson`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = await res.json();
      const r = data.routes && data.routes[0];
      if (!r) return null;
      const latlngs = r.geometry.coordinates.map((c) => [c[1], c[0]]); // [lng,lat] -> [lat,lng]
      return { distanceKm: r.distance / 1000, minutes: r.duration / 60, latlngs };
    } catch (e) {
      return null;
    }
  }

  let fareReqSeq = 0;
  async function updateFareHint() {
    const plat = parseFloat(document.getElementById('pickup_lat').value);
    const plng = parseFloat(document.getElementById('pickup_lng').value);
    const dlat = parseFloat(document.getElementById('dropoff_lat').value);
    const dlng = parseFloat(document.getElementById('dropoff_lng').value);
    const hint = document.getElementById('fare-hint');
    if (pickerLine) { pickerMap.removeLayer(pickerLine); pickerLine = null; }
    if (isNaN(plat) || isNaN(dlat)) { hint.textContent = ''; return; }

    const base = Number(appSettings.fare_base) || 3000;
    const perKm = Number(appSettings.fare_per_km) || 1500;
    const seq = ++fareReqSeq;

    // Show a straight-line estimate immediately
    let km = haversineKm(plat, plng, dlat, dlng);
    hint.innerHTML = `📏 Distancia: <strong>${km.toFixed(1)} km</strong> · 🛣️ calculando ruta...`;
    pickerLine = L.polyline([[plat, plng], [dlat, dlng]], { color: '#f59e0b', weight: 2, dashArray: '6,8' }).addTo(pickerMap);

    // Then fetch the real road route (fastest)
    const route = await osrmRoute(plat, plng, dlat, dlng);
    if (seq !== fareReqSeq) return; // a newer request superseded this one
    let minutesTxt = '';
    if (route) {
      km = route.distanceKm;
      minutesTxt = ` · ⏱️ <strong>${Math.round(route.minutes)} min</strong>`;
      if (pickerLine) pickerMap.removeLayer(pickerLine);
      pickerLine = L.polyline(route.latlngs, { color: '#3b82f6', weight: 5, opacity: 0.8 }).addTo(pickerMap);
      try { pickerMap.fitBounds(pickerLine.getBounds(), { padding: [30, 30] }); } catch (e) {}
    }

    const fare = Math.round((base + km * perKm) / 500) * 500;
    hint.innerHTML = `📏 Distancia: <strong>${km.toFixed(1)} km</strong>${minutesTxt} · 💰 Tarifa sugerida: <strong>$${fare.toLocaleString()}</strong>`;
    const amountInput = formNewOrder.querySelector('[name="amount"]');
    if (amountInput && (!amountInput.value || amountInput.value === '0')) amountInput.value = fare;
    if (!isWithinCoverage(dlat, dlng)) {
      hint.innerHTML += '<div style="color:var(--danger);margin-top:4px;">⚠️ La entrega esta fuera de las zonas de cobertura.</div>';
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

  let editingOrderId = null;

  function ensurePickerMap() {
    if (!pickerMap) {
      pickerMap = L.map('picker-map').setView([4.6097, -74.0817], 12);
      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; CartoDB', maxZoom: 19,
      }).addTo(pickerMap);
      pickerMap.on('click', (e) => {
        if (pickerStep === 'pickup') { placePickerMarker('pickup', e.latlng.lat, e.latlng.lng); pickerStep = 'dropoff'; }
        else { placePickerMarker('dropoff', e.latlng.lat, e.latlng.lng); pickerStep = 'pickup'; }
      });
    }
    pickerMap.invalidateSize();
  }

  function setOrderModalMode(editing) {
    const title = document.getElementById('order-modal-title');
    const btn = document.getElementById('btn-submit-order');
    if (title) title.textContent = editing ? '✏️ Editar Pedido' : 'Nuevo Pedido';
    if (btn) btn.textContent = editing ? 'Guardar cambios' : 'Crear Pedido';
  }

  function openOrderModal() {
    editingOrderId = null;
    setOrderModalMode(false);
    formNewOrder.reset();
    modalNewOrder.classList.remove('hidden');
    resetPicker();
    loadCustomers();
    setTimeout(ensurePickerMap, 200);
  }

  // Reutiliza el mismo formulario para EDITAR un pedido existente
  function openEditOrder(orderId) {
    const o = orders.find((x) => x.id === orderId);
    if (!o) return;
    editingOrderId = orderId;
    setOrderModalMode(true);
    formNewOrder.reset();
    modalNewOrder.classList.remove('hidden');
    resetPicker();
    loadCustomers();

    const setVal = (name, val) => {
      const el = formNewOrder.querySelector('[name="' + name + '"]');
      if (el) el.value = (val == null ? '' : val);
    };
    setVal('customer_name', o.customer_name);
    setVal('customer_phone', o.customer_phone);
    setVal('pickup_address', o.pickup_address);
    setVal('dropoff_address', o.dropoff_address);
    setVal('items', o.items);
    setVal('notes', o.notes);
    setVal('amount', o.amount);
    setVal('payment_method', o.payment_method);
    document.getElementById('pickup_lat').value = o.pickup_lat != null ? o.pickup_lat : '';
    document.getElementById('pickup_lng').value = o.pickup_lng != null ? o.pickup_lng : '';
    document.getElementById('dropoff_lat').value = o.dropoff_lat != null ? o.dropoff_lat : '';
    document.getElementById('dropoff_lng').value = o.dropoff_lng != null ? o.dropoff_lng : '';

    setTimeout(() => {
      ensurePickerMap();
      if (o.pickup_lat && o.pickup_lng) placePickerMarker('pickup', o.pickup_lat, o.pickup_lng);
      if (o.dropoff_lat && o.dropoff_lng) placePickerMarker('dropoff', o.dropoff_lat, o.dropoff_lng);
    }, 250);
  }

  btnNewOrder.addEventListener('click', openOrderModal);
  btnCancelOrderForm.addEventListener('click', () => {
    modalNewOrder.classList.add('hidden');
    editingOrderId = null;
    setOrderModalMode(false);
  });

  // ─── Clear orders ───────────────────────────────────────────────────────────
  const btnClearOrders = document.getElementById('btn-clear-orders');
  const modalClear = document.getElementById('modal-clear');
  if (btnClearOrders && modalClear) {
    btnClearOrders.addEventListener('click', () => modalClear.classList.remove('hidden'));
    document.getElementById('btn-cancel-clear').addEventListener('click', () => modalClear.classList.add('hidden'));
    modalClear.querySelectorAll('[data-clear]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const which = btn.dataset.clear;
        const labels = { delivered: 'entregados', cancelled: 'cancelados', all: 'TODOS los' };
        if (!confirm(`¿Eliminar ${labels[which]} pedidos de forma permanente? Esta accion no se puede deshacer.`)) return;
        try {
          const res = await apiFetch('/api/orders/clear', { method: 'POST', body: JSON.stringify({ which }) });
          const data = await res.json();
          if (res.ok) {
            showToast(`${data.deleted} pedido(s) eliminado(s)`, 'success');
            modalClear.classList.add('hidden');
            loadOrders();
            loadStats();
            if (map) renderOrderPins();
          } else {
            showToast(data.error || 'Error al limpiar', 'error');
          }
        } catch { showToast('Error de conexion', 'error'); }
      });
    });
  }

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

  // ─── Importar datos desde mensaje de WhatsApp (admin) ────────────────────────

  function parseOrderMessage(text) {
    const res = { name: '', phone: '', address: '', items: '', payment: '', amount: '' };
    if (!text) return res;
    const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
    
    // Detectar teléfono en cualquier parte del texto
    const phoneMatch = text.match(/(\+?\d[\d\s().-]{6,}\d)/);
    if (phoneMatch) res.phone = phoneMatch[1].replace(/[^\d+]/g, '');

    // Etiquetas comunes en mensajes de clientes colombianos
    const labels = {
      name: /^(a\s*nombre\s*(de)?|nombre|cliente|name|para)\s*[:\-]\s*(.+)/i,
      phone: /^(n[uú]mero\s*(de\s*)?tel[eé]fono|tel[eé]fono|tel|cel(ular)?|whatsapp|wa|n[uú]mero|numero|contacto)\s*[:\-]\s*(.+)/i,
      address: /^(direcci[oó]n|direccion|dir|domicilio|barrio|entrega|destino|env[ií]o|entregar\s*en|llevar\s*a)\s*[:\-]\s*(.+)/i,
      items: /^(pedido|orden|productos?|art[ií]culos?|items?|llevar|enviar|descripci[oó]n|detalle)\s*[:\-]\s*(.+)/i,
      payment: /^(m[eé]todo\s*(de\s*)?pago|pago|forma\s*(de\s*)?pago|pagar\s*con)\s*[:\-]\s*(.+)/i,
      amount: /^(valor|monto|total|precio|costo)\s*[:\-]\s*(.+)/i,
    };

    const remaining = [];
    lines.forEach(line => {
      if (/^(reenviado|importante|anexar|siguientes datos)/i.test(line)) return;
      let matched = false;
      for (const key in labels) {
        const m = line.match(labels[key]);
        if (m) {
          const val = m[m.length - 1].trim();
          if (key === 'phone') res.phone = val.replace(/[^\d+]/g, '');
          else if (key === 'payment') res.payment = val;
          else if (key === 'amount') res.amount = val.replace(/[^\d.,]/g, '');
          else if (!res[key]) res[key] = val;
          matched = true; break;
        }
      }
      if (!matched) remaining.push(line);
    });

    const addrKw = /(calle|cra|carrera|av\b|avenida|diagonal|transversal|\bkr\b|\bcl\b|#|barrio|conjunto|edificio|manzana|casa|apto|vereda|sector)/i;
    const isPhoneLine = l => l.replace(/[^\d]/g, '').length >= 7 && /^[\d\s+().-]+$/.test(l);
    if (!res.address) {
      const a = remaining.find(l => addrKw.test(l) && !isPhoneLine(l));
      if (a) res.address = a;
    }
    if (!res.name) {
      const c = remaining.find(l => l !== res.address && /[a-záéíóúñ]/i.test(l) && !/\d{4,}/.test(l) && !isPhoneLine(l) && l.split(' ').length <= 5);
      if (c) res.name = c;
    }
    if (!res.items) {
      const left = remaining.filter(l => l !== res.address && l !== res.name && !isPhoneLine(l));
      if (left.length) res.items = left.join(', ');
    }
    return res;
  }

  function applyParsedOrder(text) {
    const p = parseOrderMessage(text);
    if (p.name) document.getElementById('customer_name').value = p.name;
    if (p.phone) document.getElementById('customer_phone').value = p.phone;
    if (p.address) document.getElementById('dropoff_address').value = p.address;
    const itemsField = formNewOrder.querySelector('[name="items"]');
    if (p.items && itemsField) itemsField.value = p.items;
    if (p.payment) {
      const paySelect = formNewOrder.querySelector('[name="payment_method"]');
      if (paySelect) {
        paySelect.value = /(bancolombia|nequi|daviplata|transferencia|pse|banco|consignaci)/i.test(p.payment) ? 'card' : 'cash';
      }
    }
    if (p.amount) {
      const amountField = formNewOrder.querySelector('[name="amount"]');
      if (amountField) amountField.value = parseFloat(p.amount.replace(/,/g, '')) || 0;
    }
    const got = [p.name, p.phone, p.address, p.items, p.payment, p.amount].filter(Boolean).length;
    showToast(got ? '✅ ' + got + ' datos importados. Revisa y crea el pedido.' : 'No se reconocieron datos, llénalos manual.', got ? 'success' : 'warning');
  }

  const btnPasteOrder = document.getElementById('btn-paste-order');
  const btnParseOrder = document.getElementById('btn-parse-order');
  const orderImport = document.getElementById('order-import');

  if (btnPasteOrder) {
    btnPasteOrder.addEventListener('click', async () => {
      try {
        const txt = await navigator.clipboard.readText();
        if (orderImport) orderImport.value = txt;
        applyParsedOrder(txt);
      } catch (e) {
        showToast('No se pudo leer el portapapeles. Pega el texto manualmente.', 'warning');
      }
    });
  }
  if (btnParseOrder) {
    btnParseOrder.addEventListener('click', () => {
      if (orderImport) applyParsedOrder(orderImport.value);
    });
  }

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
      branch_id: fd.get('branch_id') ? parseInt(fd.get('branch_id')) : undefined,
    };
    try {
      const editing = editingOrderId != null;
      const res = await apiFetch(editing ? '/api/orders/' + editingOrderId : '/api/orders', {
        method: editing ? 'PUT' : 'POST',
        body: JSON.stringify(body),
      });
      if (res.ok) {
        showToast(editing ? 'Pedido actualizado' : 'Pedido creado exitosamente', 'success');
        modalNewOrder.classList.add('hidden');
        editingOrderId = null;
        setOrderModalMode(false);
        formNewOrder.reset();
        resetPicker();
        loadOrders();
        loadStats();
      } else {
        const err = await res.json();
        showToast(err.error || 'Error al guardar pedido', 'error');
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
        const notifyGroup = document.getElementById('notify-group-wa');
        if (notifyGroup && notifyGroup.checked) notifyGroupWhatsApp(order, driver ? driver.name : '');
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
        notifyGroupWhatsApp(data.order, data.driver_name || '');
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
    const msg = [
      '*SERVICIOS GHOST*',
      '',
      'En Servicios Ghost no nos detenemos y seguimos evolucionando para ti! Queremos contarte que hemos activado un nuevo sistema de seguimiento de pedidos.',
      '',
      'A partir de ahora, tendras el control total de tus entregas:',
      '- Mayor tranquilidad: Sabras exactamente el estado de tu domicilio.',
      '- Maxima seguridad: Todo monitoreado directamente por nuestra central logistica.',
      '- Rapidez garantizada: Rompemos las barreras del tiempo con tecnologia premium.',
      '',
      'Sigue tu pedido *' + order.code + '* en tiempo real aqui:',
      url,
      '',
      'Tienes un antojo o necesitas despachar en tu negocio? Pruebalo ya mismo! Tu entrega esta en las mejores manos.',
      '',
      'Guarda nuestro contacto y pide al instante: 321 428 6626',
    ].join('\n');
    window.open('https://wa.me/' + digits + '?text=' + encodeURIComponent(msg), '_blank');
  }

  // Enviar al grupo de WhatsApp de Servicio Ghost
  function notifyGroupWhatsApp(order, driverName) {
    if (!order) return;
    const today = new Date().toLocaleDateString('es-CO', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const phone = order.customer_phone ? String(order.customer_phone).replace(/[^0-9+]/g, '') : 'No registrado';
    // Buscar el nombre del lugar guardado si las coordenadas coinciden
    let negocio = order.pickup_address || 'No especificado';
    if (order.pickup_lat && order.pickup_lng && typeof places !== 'undefined') {
      const matchPlace = places.find(p => p.lat && p.lng && Math.abs(p.lat - order.pickup_lat) < 0.001 && Math.abs(p.lng - order.pickup_lng) < 0.001);
      if (matchPlace) negocio = matchPlace.name;
    }
    // Si parece coordenada (contiene ° o empieza con número y tiene N/S/E/W), buscar nombre
    if (/[\d°'"NSEW]/.test(negocio) && negocio.length > 15 && typeof places !== 'undefined' && places.length > 0) {
      const firstPlace = places.find(p => p.name);
      if (firstPlace && order.pickup_lat) {
        const matchP = places.find(p => p.lat && Math.abs(p.lat - order.pickup_lat) < 0.001);
        if (matchP) negocio = matchP.name;
      }
    }
    const dropoff = order.dropoff_address || 'No especificada';
    // Contar domicilios realizados hoy por este repartidor
    const driverId = order.driver_id;
    const todayStr = new Date().toISOString().slice(0, 10);
    const domiCount = orders.filter(o => o.driver_id === driverId && o.status !== 'cancelled' && o.created_at && o.created_at.slice(0, 10) === todayStr).length;
    const driverMention = driverName ? '@' + driverName : 'Por asignar';
    const msg = `⚡ SERVICIO GHOST ⚡\n${today}\n🛵 DOMI #${domiCount} del día\n👤 Repartidor: ${driverMention}\n🏢 Negocio: ${negocio}\n📍 Dirección: ${dropoff}\n📱 Celular: ${phone}`;
    // Copiar mensaje al portapapeles y abrir el grupo
    if (navigator.clipboard) {
      navigator.clipboard.writeText(msg).then(() => {
        showToast('Mensaje copiado. Pega en el grupo de WhatsApp.', 'success');
        window.open('https://chat.whatsapp.com/FO1HRzeU8YMGpsoJNyahlQ', '_blank');
      }).catch(() => {
        window.open('https://chat.whatsapp.com/FO1HRzeU8YMGpsoJNyahlQ', '_blank');
      });
    } else {
      window.open('https://chat.whatsapp.com/FO1HRzeU8YMGpsoJNyahlQ', '_blank');
    }
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
        <div class="order-actions" style="margin-top:0.6rem;">
          <button class="btn btn-outline btn-sm" data-edit-driver="${d.id}">Editar</button>
          <button class="btn btn-warning btn-sm" data-vibrate-driver="${d.id}" title="Enviar alerta para que active la ubicacion">📍 Activar UBI</button>
          <button class="btn btn-danger btn-sm" data-del-driver="${d.id}">Eliminar</button>
        </div>
      `;
      driversGrid.appendChild(card);
    });

    driversGrid.querySelectorAll('[data-edit-driver]').forEach((b) => {
      b.addEventListener('click', () => openEditDriver(parseInt(b.dataset.editDriver)));
    });
    driversGrid.querySelectorAll('[data-del-driver]').forEach((b) => {
      b.addEventListener('click', () => deleteDriver(parseInt(b.dataset.delDriver)));
    });
    driversGrid.querySelectorAll('[data-vibrate-driver]').forEach((b) => {
      b.addEventListener('click', () => vibrateDriver(parseInt(b.dataset.vibrateDriver)));
    });
  }

  // ─── Vibrar/alertar repartidor para que active ubicación ────────────────────
  async function vibrateDriver(driverId) {
    try {
      const res = await apiFetch('/api/push/notify', {
        method: 'POST',
        body: JSON.stringify({ driver_id: driverId, title: '📍 ACTIVA TU UBICACION', body: 'La central necesita tu ubicacion en tiempo real. Abre la app y activa el GPS.' }),
      });
      const data = await res.json();
      if (res.ok) {
        showToast('Alerta enviada al repartidor', 'success');
      } else {
        showToast(data.error || 'No se pudo enviar la alerta', 'error');
      }
    } catch { showToast('Error de conexion', 'error'); }
  }

  // ─── Edit / Delete driver ───────────────────────────────────────────────────
  function openEditDriver(id) {
    const d = drivers.find((x) => x.id === id);
    if (!d) return;
    document.getElementById('edit-driver-id').value = id;
    document.getElementById('edit-driver-name').value = d.name || '';
    document.getElementById('edit-driver-phone').value = d.phone || '';
    document.getElementById('edit-driver-vehicle').value = d.vehicle || '';
    document.getElementById('edit-driver-plate').value = d.plate || '';
    document.getElementById('edit-driver-password').value = '';
    document.getElementById('modal-edit-driver').classList.remove('hidden');
  }

  async function deleteDriver(id) {
    const d = drivers.find((x) => x.id === id);
    if (!confirm('¿Eliminar al repartidor ' + (d ? d.name : '') + '? Esta accion no se puede deshacer.')) return;
    try {
      const res = await apiFetch('/api/drivers/' + id, { method: 'DELETE' });
      if (res.ok) { showToast('Repartidor eliminado', 'success'); loadDrivers(); }
      else { const e = await res.json(); showToast(e.error || 'Error al eliminar', 'error'); }
    } catch { showToast('Error de conexion', 'error'); }
  }

  (function bindEditDriver() {
    const modal = document.getElementById('modal-edit-driver');
    if (!modal) return;
    document.getElementById('btn-cancel-edit-driver').addEventListener('click', () => modal.classList.add('hidden'));
    document.getElementById('btn-save-edit-driver').addEventListener('click', async () => {
      const id = document.getElementById('edit-driver-id').value;
      const body = {
        name: document.getElementById('edit-driver-name').value,
        phone: document.getElementById('edit-driver-phone').value,
        vehicle: document.getElementById('edit-driver-vehicle').value,
        plate: document.getElementById('edit-driver-plate').value,
      };
      const pwd = document.getElementById('edit-driver-password').value;
      if (pwd) body.password = pwd;
      try {
        const res = await apiFetch('/api/drivers/' + id, { method: 'PUT', body: JSON.stringify(body) });
        if (res.ok) { showToast('Repartidor actualizado', 'success'); modal.classList.add('hidden'); loadDrivers(); }
        else showToast('Error al actualizar', 'error');
      } catch { showToast('Error de conexion', 'error'); }
    });
  })();

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
      refreshDriverMarkers();
      return;
    }
    map = L.map('map').setView([4.6097, -74.0817], 12);

    const darkMatter = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; CartoDB', maxZoom: 19,
    });
    const satellite = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { attribution: 'Tiles &copy; Esri', maxZoom: 19 }
    );
    darkMatter.addTo(map);
    L.control.layers({ '🌑 Dark Ghost': darkMatter, '🛰️ Satelital': satellite }, null, { position: 'topright' }).addTo(map);

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
    if (typeof drawPlacesOnMainMap === 'function') drawPlacesOnMainMap();

    // Boton para proyectar mapa en ventana separada
    var PopoutControl = L.Control.extend({
      options: { position: 'topright' },
      onAdd: function () {
        var btn = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
        btn.innerHTML = '<a href="#" title="Proyectar mapa en otra pantalla" style="display:flex;align-items:center;justify-content:center;width:34px;height:34px;font-size:1.2rem;text-decoration:none;color:#333;background:#fff;">⤢</a>';
        L.DomEvent.disableClickPropagation(btn);
        btn.querySelector('a').addEventListener('click', function (e) {
          e.preventDefault();
          var w = window.open('/map-fullscreen.html', 'ghost-map-proyeccion', 'width=1280,height=800,menubar=no,toolbar=no,location=no,status=no');
          if (!w) showToast('Permite ventanas emergentes para proyectar', 'warning');
        });
        return btn;
      }
    });
    map.addControl(new PopoutControl());

    // Ensure the map sizes correctly inside the flex console layout
    setTimeout(() => { if (map) map.invalidateSize(); }, 200);
  }

  // Remove and re-add all driver markers from the current `drivers` array
  function refreshDriverMarkers() {
    if (!map) return;
    Object.keys(driverMarkers).forEach((id) => {
      map.removeLayer(driverMarkers[id]);
      delete driverMarkers[id];
    });
    drivers.forEach((d) => {
      if (d.lat && d.lng && d.status !== 'offline') addDriverMarker(d);
    });
    renderLivePeople();
    fitDriversBounds();
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
      .bindPopup(`<strong>${escapeHtml(d.name)}</strong><br>🛵 ${escapeHtml(d.vehicle || '-')}<br>Velocidad: ${Math.round(d.speed || 0)} km/h`)
      .bindTooltip(escapeHtml(d.name), { permanent: true, direction: 'top', offset: [0, -16], className: 'driver-label' });
    marker.addTo(map);
    driverMarkers[d.id] = marker;
  }

  function updateDriverMarker(data) {
    if (!map) return;
    if (driverMarkers[data.id]) {
      driverMarkers[data.id].setLatLng([data.lat, data.lng]);
      driverMarkers[data.id].setPopupContent(
        `<strong>${escapeHtml(data.name)}</strong><br>Velocidad: ${Math.round(data.speed || 0)} km/h`
      );
      if (driverMarkers[data.id].getTooltip()) driverMarkers[data.id].setTooltipContent(escapeHtml(data.name));
    } else {
      const marker = L.marker([data.lat, data.lng], { icon: ICON_DRIVER() })
        .bindPopup(`<strong>${escapeHtml(data.name)}</strong><br>Velocidad: ${Math.round(data.speed || 0)} km/h`)
        .bindTooltip(escapeHtml(data.name), { permanent: true, direction: 'top', offset: [0, -16], className: 'driver-label' });
      marker.addTo(map);
      driverMarkers[data.id] = marker;
    }
    renderLivePeople();
  }

  // ─── Live people panel (who is online right now) ────────────────────────────
  function renderLivePeople() {
    const box = document.getElementById('live-people-list');
    const countEl = document.getElementById('live-count');
    if (!box) return;
    const online = drivers.filter((d) => d.lat && d.lng && d.status !== 'offline');
    if (countEl) countEl.textContent = online.length;
    if (online.length === 0) {
      box.innerHTML = '<p class="live-empty">Nadie en línea por ahora.</p>';
      return;
    }
    box.innerHTML = online.map((d) =>
      '<div class="live-person" data-center="' + d.id + '">' +
        '<span class="live-avatar">🛵</span>' +
        '<div class="live-info">' +
          '<span class="live-name">' + escapeHtml(d.name) + '</span>' +
          '<span class="live-meta">' + escapeHtml(d.vehicle || 'Repartidor') + ' · ' + Math.round(d.speed || 0) + ' km/h</span>' +
        '</div>' +
        '<button class="btn btn-outline btn-sm live-go" data-center="' + d.id + '">Ver</button>' +
      '</div>'
    ).join('');
    box.querySelectorAll('[data-center]').forEach((el) => {
      el.addEventListener('click', (e) => { e.stopPropagation(); centerOnDriver(parseInt(el.dataset.center)); });
    });
  }

  function centerOnDriver(id) {
    const m = driverMarkers[id];
    if (m && map) { map.setView(m.getLatLng(), 16); m.openPopup(); }
  }

  function fitDriversBounds() {
    if (!map) return;
    const ms = Object.values(driverMarkers);
    if (ms.length === 0) return;
    try { map.fitBounds(L.featureGroup(ms).getBounds().pad(0.3), { maxZoom: 15 }); } catch (e) {}
  }

  (function () {
    const btnFitPeople = document.getElementById('btn-fit-people');
    if (btnFitPeople) btnFitPeople.addEventListener('click', fitDriversBounds);
  })();

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
      if (window.ghostAlert) window.ghostAlert({ beeps: 3 });
      playBeep();
      loadOrders().then(() => { if (order && order.id) focusOrderOnMap(order.id); });
      loadStats();
    });

    socket.on('chat:message', (msg) => {
      if (!chatThreads[msg.driver_id]) chatThreads[msg.driver_id] = [];
      chatThreads[msg.driver_id].push(msg);
      if (chatActiveDriver === msg.driver_id) {
        renderChatMessages(msg.driver_id);
      } else if (msg.sender_role === 'driver') {
        chatUnread[msg.driver_id] = (chatUnread[msg.driver_id] || 0) + 1;
        renderChatContacts();
        playBeep();
        showToast('Mensaje de ' + (getDriverName(msg.driver_id) || 'repartidor'), 'info');
      }
    });

    socket.on('order:status', (order) => {
      showToast('Pedido ' + order.code + ': ' + statusLabel(order.status), 'info');
      loadOrders();
      loadStats();
    });

    socket.on('order:address', (data) => {
      showToast('Cliente confirmo direccion: ' + data.code, 'success');
      if (window.ghostAlert) window.ghostAlert({ beeps: 2 });
      loadOrders();
    });

    socket.on('order:assigned', (order) => {
      loadOrders();
    });

    socket.on('driver:location', (data) => {
      updateDriverMarker(data);
      // Reflect live online status in the drivers list
      const d = drivers.find((x) => x.id === data.id);
      if (d) {
        d.lat = data.lat; d.lng = data.lng; d.speed = data.speed; d.status = 'available';
      } else {
        // Driver came online after page load — refresh the list
        loadDrivers();
        return;
      }
      const viewRep = document.getElementById('view-repartidores');
      if (viewRep && !viewRep.classList.contains('hidden')) renderDrivers();
    });

    socket.on('driver:offline', (data) => {
      const d = drivers.find((x) => x.id === data.id);
      if (d) d.status = 'offline';
      if (driverMarkers[data.id] && map) { map.removeLayer(driverMarkers[data.id]); delete driverMarkers[data.id]; }
      renderLivePeople();
      const viewRep = document.getElementById('view-repartidores');
      if (viewRep && !viewRep.classList.contains('hidden')) renderDrivers();
    });

    socket.on('driver:offline', (data) => {
      removeDriverMarker(data);
      loadDrivers();
    });

    // ─── SOS Alert from Driver ──────────────────────────────────────────────
    socket.on('driver:sos', (data) => {
      // Strong vibration
      if (navigator.vibrate) navigator.vibrate([500, 200, 500, 200, 500]);
      // Sound alert
      playSOSSound();
      // Browser notification
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification('🚨 SOS - ' + (data.name || 'Repartidor'), { body: 'Un repartidor necesita ayuda urgente!', requireInteraction: true });
      }
      // Toast
      showToast('🚨 SOS de ' + (data.name || 'Repartidor') + ' — Necesita ayuda!', 'error');
      // Show SOS modal
      showSOSAlert(data);
      // Mark on map
      if (map && data.lat && data.lng) {
        var sosMarker = L.circleMarker([data.lat, data.lng], {
          radius: 18, color: '#ef4444', fillColor: '#ef4444', fillOpacity: 0.4, weight: 3
        }).bindPopup('<strong>🚨 SOS</strong><br>' + escapeHtml(data.name || '') + '<br>' + new Date(data.timestamp).toLocaleTimeString('es-CO'));
        sosMarker.addTo(map);
        map.setView([data.lat, data.lng], 16);
        // Pulse the marker
        var pulseCount = 0;
        var pulseInterval = setInterval(function () {
          pulseCount++;
          sosMarker.setStyle({ fillOpacity: pulseCount % 2 === 0 ? 0.4 : 0.8 });
          if (pulseCount > 20) clearInterval(pulseInterval);
        }, 500);
        // Remove after 5 minutes
        setTimeout(function () { if (map) map.removeLayer(sosMarker); }, 300000);
      }
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
        // The map is in the "Pedidos y Mapa" console view
        tabBtns.forEach((b) => b.classList.remove('active'));
        document.querySelector('[data-tab="pedidos"]').classList.add('active');
        viewPedidos.classList.remove('hidden');
        viewRepartidores.classList.add('hidden');
        viewReportes.classList.add('hidden');
        const vChat = document.getElementById('view-chat'); if (vChat) vChat.classList.add('hidden');
        const vConfig = document.getElementById('view-config'); if (vConfig) vConfig.classList.add('hidden');
        const vAct = document.getElementById('view-actividad'); if (vAct) vAct.classList.add('hidden');
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
