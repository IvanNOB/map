(function () {
  'use strict';

  let token = localStorage.getItem('rest_token') || '';
  let currentUser = null;
  let socket = null;

  const loginScreen = document.getElementById('login-screen');
  const app = document.getElementById('app');
  const loginForm = document.getElementById('login-form');
  const toastContainer = document.getElementById('toast-container');
  const ordersList = document.getElementById('orders-list');

  function apiHeaders() {
    return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
  }
  async function apiFetch(url, opts = {}) {
    opts.headers = Object.assign(apiHeaders(), opts.headers || {});
    const res = await fetch(url, opts);
    if (res.status === 401) { showLogin(); }
    return res;
  }

  function showToast(msg, type) {
    type = type || 'info';
    const t = document.createElement('div');
    t.className = 'toast ' + type;
    t.textContent = msg;
    toastContainer.appendChild(t);
    setTimeout(() => t.remove(), 4000);
  }
  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
  }
  function statusLabel(s) {
    return ({ pending: 'Pendiente', assigned: 'Asignado', picked_up: 'Recogido', on_the_way: 'En Camino', delivered: 'Entregado', cancelled: 'Cancelado' }[s] || s);
  }
  function fmt(ts) {
    if (!ts) return '';
    const d = new Date(ts.indexOf && ts.indexOf('T') === -1 ? ts.replace(' ', 'T') + 'Z' : ts);
    return isNaN(d.getTime()) ? '' : d.toLocaleString('es', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  function showLogin() {
    loginScreen.classList.remove('hidden');
    app.classList.add('hidden');
    token = '';
    localStorage.removeItem('rest_token');
  }
  function showApp() {
    loginScreen.classList.add('hidden');
    app.classList.remove('hidden');
    document.getElementById('rest-name').textContent = currentUser.name;
    loadOrders();
    initSocket();
  }

  async function checkAuth() {
    if (!token) { showLogin(); return; }
    try {
      const res = await fetch('/api/auth/me', { headers: apiHeaders() });
      if (res.ok) {
        currentUser = (await res.json()).user;
        if (currentUser.role !== 'restaurant') { showToast('Esta cuenta no es de restaurante', 'error'); showLogin(); return; }
        showApp();
      } else showLogin();
    } catch { showLogin(); }
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: document.getElementById('login-email').value, password: document.getElementById('login-password').value }),
      });
      const data = await res.json();
      if (res.ok) {
        token = data.token;
        localStorage.setItem('rest_token', token);
        currentUser = data.user;
        if (currentUser.role !== 'restaurant') { showToast('Esta cuenta no es de restaurante', 'error'); return; }
        showApp();
      } else showToast(data.error || 'Error al ingresar', 'error');
    } catch { showToast('Error de conexión', 'error'); }
  });

  document.getElementById('btn-logout').addEventListener('click', showLogin);

  // Geocode an address with Nominatim (free)
  async function geocode(address) {
    try {
      const res = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(address));
      const data = await res.json();
      if (data && data[0]) return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    } catch (e) {}
    return null;
  }

  document.getElementById('order-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const dropoff = document.getElementById('o-dropoff').value.trim();
    const body = {
      customer_name: document.getElementById('o-name').value.trim(),
      customer_phone: document.getElementById('o-phone').value.trim(),
      dropoff_address: dropoff,
      items: document.getElementById('o-items').value.trim(),
      amount: parseFloat(document.getElementById('o-amount').value) || 0,
      payment_method: document.getElementById('o-payment').value,
    };
    showToast('Enviando domicilio...', 'info');
    const geo = await geocode(dropoff);
    if (geo) { body.dropoff_lat = geo.lat; body.dropoff_lng = geo.lng; }
    try {
      const res = await apiFetch('/api/orders', { method: 'POST', body: JSON.stringify(body) });
      const data = await res.json();
      if (res.ok) {
        showToast('Domicilio enviado: ' + data.code, 'success');
        document.getElementById('order-form').reset();
        loadOrders();
      } else showToast(data.error || 'Error al enviar', 'error');
    } catch { showToast('Error de conexión', 'error'); }
  });

  async function loadOrders() {
    try {
      const res = await apiFetch('/api/orders');
      if (!res.ok) return;
      const orders = await res.json();
      if (orders.length === 0) { ordersList.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:1rem;">Aún no has enviado domicilios.</p>'; return; }
      ordersList.innerHTML = orders.map((o) =>
        '<div class="order-card status-' + escapeHtml(o.status) + '">' +
        '<div><span class="order-code">' + escapeHtml(o.code) + '</span>' +
        '<span class="badge badge-' + escapeHtml(o.status) + '">' + escapeHtml(statusLabel(o.status)) + '</span></div>' +
        '<div class="order-customer">' + escapeHtml(o.customer_name) + '</div>' +
        '<div class="order-addresses">🔴 ' + escapeHtml(o.dropoff_address || '') + '</div>' +
        '<div class="order-meta"><span>' + escapeHtml(fmt(o.created_at)) + '</span>' +
        (o.amount ? '<span>$' + escapeHtml(String(o.amount)) + '</span>' : '') + '</div>' +
        '</div>'
      ).join('');
    } catch {}
  }

  function initSocket() {
    if (socket) return;
    socket = io({ auth: { token } });
    socket.on('order:status', () => loadOrders());
    socket.on('order:assigned', () => loadOrders());
  }

  checkAuth();
})();
