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

  // ─── Auth ───────────────────────────────────────────────────────────────────

  async function checkAuth() {
    if (!token) {
      showLogin();
      return;
    }
    try {
      const res = await fetch('/api/auth/me', { headers: apiHeaders() });
      if (res.ok) {
        currentUser = await res.json();
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
      if (tab === 'mapa') {
        initMap();
      }
      if (tab === 'repartidores') {
        loadDrivers();
      }
    });
  });

  // ─── Data Loading ───────────────────────────────────────────────────────────

  async function loadData() {
    await Promise.all([loadOrders(), loadStats(), loadDrivers()]);
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
    if (orders.length === 0) {
      ordersList.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:2rem;">No hay pedidos</p>';
      return;
    }
    orders.forEach((order) => {
      const driverName = getDriverName(order.driver_id);
      const card = document.createElement('div');
      card.className = 'order-card';
      card.innerHTML = `
        <div>
          <span class="order-code">${order.code}</span>
          <span class="badge badge-${order.status}">${statusLabel(order.status)}</span>
        </div>
        <div class="order-info">
          <div class="order-customer">${order.customer_name}</div>
          <div class="order-addresses">
            <strong>Recogida:</strong> ${order.pickup_address || '-'} &rarr; <strong>Entrega:</strong> ${order.dropoff_address || '-'}
          </div>
          <div class="order-meta">
            ${driverName ? '<span>Repartidor: ' + driverName + '</span>' : ''}
            <span>${formatTime(order.created_at)}</span>
            ${order.amount ? '<span>$' + order.amount + '</span>' : ''}
          </div>
        </div>
        <div class="order-actions">
          ${order.status === 'pending' ? '<button class="btn btn-primary btn-sm" data-assign="' + order.id + '">Asignar Repartidor</button>' : ''}
          ${['pending', 'assigned'].includes(order.status) ? '<button class="btn btn-danger btn-sm" data-cancel="' + order.id + '">Cancelar</button>' : ''}
        </div>
      `;
      ordersList.appendChild(card);
    });

    // Event delegation for order actions
    ordersList.querySelectorAll('[data-assign]').forEach((btn) => {
      btn.addEventListener('click', () => openAssignModal(parseInt(btn.dataset.assign)));
    });
    ordersList.querySelectorAll('[data-cancel]').forEach((btn) => {
      btn.addEventListener('click', () => cancelOrder(parseInt(btn.dataset.cancel)));
    });
  }

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

  btnNewOrder.addEventListener('click', () => modalNewOrder.classList.remove('hidden'));
  btnCancelOrderForm.addEventListener('click', () => modalNewOrder.classList.add('hidden'));

  formNewOrder.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(formNewOrder);
    const body = {
      customer_name: fd.get('customer_name'),
      customer_phone: fd.get('customer_phone'),
      pickup_address: fd.get('pickup_address'),
      dropoff_address: fd.get('dropoff_address'),
      items: fd.get('items'),
      notes: fd.get('notes'),
      amount: parseFloat(fd.get('amount')) || 0,
      payment_method: fd.get('payment_method'),
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
    try {
      const res = await apiFetch('/api/orders/' + assigningOrderId + '/assign', {
        method: 'POST',
        body: JSON.stringify({ driver_id: driverId }),
      });
      if (res.ok) {
        showToast('Repartidor asignado', 'success');
        modalAssign.classList.add('hidden');
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
          <h3>${d.name}</h3>
          <span class="badge badge-${d.status === 'available' ? 'delivered' : d.status === 'busy' ? 'assigned' : 'cancelled'}">
            <span class="status-dot ${statusClass}"></span> ${statusText}
          </span>
        </div>
        <div class="driver-card-details">
          ${d.vehicle ? '<div>Vehiculo: ' + d.vehicle + '</div>' : ''}
          ${d.plate ? '<div>Placa: ' + d.plate + '</div>' : ''}
          ${d.phone ? '<div>Tel: ' + d.phone + '</div>' : ''}
          ${d.email ? '<div>Email: ' + d.email + '</div>' : ''}
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
      return;
    }
    map = L.map('map').setView([4.6097, -74.0817], 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);

    // Add existing driver markers
    drivers.forEach((d) => {
      if (d.lat && d.lng && d.status !== 'offline') {
        addDriverMarker(d);
      }
    });

    // Add active order markers
    orders.forEach((o) => {
      if (['assigned', 'picked_up', 'on_the_way'].includes(o.status)) {
        if (o.pickup_lat && o.pickup_lng) {
          L.circleMarker([o.pickup_lat, o.pickup_lng], { radius: 6, color: '#3b82f6', fillOpacity: 0.8 })
            .bindPopup('Recogida: ' + (o.pickup_address || o.code))
            .addTo(map);
        }
        if (o.dropoff_lat && o.dropoff_lng) {
          L.circleMarker([o.dropoff_lat, o.dropoff_lng], { radius: 6, color: '#ef4444', fillOpacity: 0.8 })
            .bindPopup('Entrega: ' + (o.dropoff_address || o.code))
            .addTo(map);
        }
      }
    });
  }

  function addDriverMarker(d) {
    if (!d.lat || !d.lng) return;
    const marker = L.circleMarker([d.lat, d.lng], {
      radius: 10,
      color: '#22c55e',
      fillColor: '#22c55e',
      fillOpacity: 0.8,
    }).bindPopup(`<strong>${d.name}</strong><br>Vehiculo: ${d.vehicle || '-'}<br>Velocidad: ${d.speed || 0} km/h`);
    marker.addTo(map);
    driverMarkers[d.id] = marker;
  }

  function updateDriverMarker(data) {
    if (!map) return;
    if (driverMarkers[data.id]) {
      driverMarkers[data.id].setLatLng([data.lat, data.lng]);
      driverMarkers[data.id].setPopupContent(
        `<strong>${data.name}</strong><br>Velocidad: ${data.speed || 0} km/h`
      );
    } else {
      const marker = L.circleMarker([data.lat, data.lng], {
        radius: 10,
        color: '#22c55e',
        fillColor: '#22c55e',
        fillOpacity: 0.8,
      }).bindPopup(`<strong>${data.name}</strong><br>Velocidad: ${data.speed || 0} km/h`);
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
    });

    socket.on('order:new', (order) => {
      showToast('Nuevo pedido: ' + order.code, 'info');
      loadOrders();
      loadStats();
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

    socket.on('disconnect', () => {
      console.log('Socket desconectado');
    });
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
