/* ─── Restaurant Panel JavaScript ────────────────────────────────────────── */

(function () {
  'use strict';

  // ─── State ──────────────────────────────────────────────────────────────────
  let token = localStorage.getItem('token') || '';
  let currentUser = null;
  let orders = [];
  let currentFilter = '';
  let socket = null;

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
  const viewNuevo = document.getElementById('view-nuevo');
  const viewEstadisticas = document.getElementById('view-estadisticas');

  // Stats
  const statPending = document.getElementById('stat-pending');
  const statPreparing = document.getElementById('stat-preparing');
  const statReady = document.getElementById('stat-ready');
  const statRevenue = document.getElementById('stat-revenue');

  // Orders
  const ordersList = document.getElementById('orders-list');

  // New Order Form
  const formNewOrder = document.getElementById('form-new-order');

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

  function statusLabel(status) {
    const labels = {
      pending: 'Pendiente',
      confirmed: 'Confirmado',
      preparing: 'Preparando',
      ready_for_pickup: 'Listo para Recoger',
      assigned: 'Repartidor Asignado',
      picked_up: 'Recogido',
      on_the_way: 'En Camino',
      delivered: 'Entregado',
      cancelled: 'Cancelado',
    };
    return labels[status] || status;
  }

  function statusBadgeClass(status) {
    const map = {
      pending: 'pending',
      confirmed: 'assigned',
      preparing: 'picked_up',
      ready_for_pickup: 'on_the_way',
      assigned: 'assigned',
      picked_up: 'picked_up',
      on_the_way: 'on_the_way',
      delivered: 'delivered',
      cancelled: 'cancelled',
    };
    return map[status] || status;
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

  // ─── Notification Sound ─────────────────────────────────────────────────────

  let audioCtx = null;

  function playNotificationSound() {
    try {
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      const now = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.3, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.4);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now);
      osc.stop(now + 0.4);
    } catch (e) {
      // Silently fail
    }
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
        const data = await res.json();
        currentUser = data.user;
        if (currentUser.role !== 'restaurant') {
          showToast('Esta app es solo para restaurantes', 'error');
          logout();
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
    userName.textContent = currentUser.name;
    loadData();
    initSocket();
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.textContent = '';
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
        if (data.user.role !== 'restaurant') {
          loginError.textContent = 'Esta app es solo para restaurantes';
          return;
        }
        token = data.token;
        localStorage.setItem('token', token);
        currentUser = data.user;
        showApp();
      } else {
        loginError.textContent = data.error || 'Error al iniciar sesion';
      }
    } catch (err) {
      loginError.textContent = 'Error de conexion';
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Iniciar Sesion';
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
      viewNuevo.classList.toggle('hidden', tab !== 'nuevo');
      viewEstadisticas.classList.toggle('hidden', tab !== 'estadisticas');
      if (tab === 'estadisticas') {
        loadFullStats();
      }
    });
  });

  // ─── Data Loading ───────────────────────────────────────────────────────────

  async function loadData() {
    await Promise.all([loadOrders(), loadQuickStats()]);
  }

  async function loadQuickStats() {
    try {
      const res = await apiFetch('/api/restaurant/stats');
      if (res.ok) {
        const s = await res.json();
        statPending.textContent = s.pending_orders || 0;
        statPreparing.textContent = s.preparing_orders || 0;
        statReady.textContent = s.ready_orders || 0;
        statRevenue.textContent = '$' + (s.today.revenue || 0).toLocaleString();
      }
    } catch {}
  }

  async function loadFullStats() {
    try {
      const res = await apiFetch('/api/restaurant/stats');
      if (res.ok) {
        const s = await res.json();
        document.getElementById('stats-orders-today').textContent = s.today.orders || 0;
        document.getElementById('stats-deliveries-today').textContent = s.today.deliveries || 0;
        document.getElementById('stats-revenue-today').textContent = '$' + (s.today.revenue || 0).toLocaleString();
        document.getElementById('stats-orders-week').textContent = s.week.orders || 0;
        document.getElementById('stats-revenue-week').textContent = '$' + (s.week.revenue || 0).toLocaleString();
        document.getElementById('stats-avg-prep').textContent = s.avg_prep_minutes != null ? s.avg_prep_minutes + ' min' : '--';
      }
    } catch {}
  }

  async function loadOrders() {
    try {
      let url = '/api/restaurant/orders?limit=100';
      if (currentFilter) url += '&status=' + currentFilter;
      const res = await apiFetch(url);
      if (res.ok) {
        const data = await res.json();
        orders = data.orders || [];
        renderOrders();
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
      const card = document.createElement('div');
      card.className = 'order-card';
      card.innerHTML = `
        <div>
          <span class="order-code">${escapeHtml(order.code)}</span>
          <span class="badge badge-${statusBadgeClass(order.status)}">${escapeHtml(statusLabel(order.status))}</span>
        </div>
        <div class="order-info">
          <div class="order-customer">${escapeHtml(order.customer_name)}</div>
          <div class="order-addresses">
            <strong>Entrega:</strong> ${escapeHtml(order.dropoff_address || '-')}
          </div>
          <div class="order-meta">
            <span>${escapeHtml(order.items || '-')}</span>
            <span>${escapeHtml(formatTime(order.created_at))}</span>
            ${order.amount ? '<span>$' + escapeHtml(String(order.amount.toLocaleString())) + '</span>' : ''}
            ${order.driver_name ? '<span>Repartidor: ' + escapeHtml(order.driver_name) + '</span>' : ''}
          </div>
        </div>
        <div class="order-actions">
          ${getActionButtons(order)}
        </div>
      `;
      ordersList.appendChild(card);
    });

    // Event delegation
    ordersList.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => handleOrderAction(btn.dataset.action, parseInt(btn.dataset.id)));
    });
  }

  function getActionButtons(order) {
    let buttons = '';

    switch (order.status) {
      case 'pending':
        buttons += `<button class="btn btn-primary btn-sm" data-action="confirm" data-id="${order.id}">Confirmar Pedido</button>`;
        buttons += `<button class="btn btn-danger btn-sm" data-action="cancel" data-id="${order.id}">Rechazar</button>`;
        break;
      case 'confirmed':
        buttons += `<button class="btn btn-primary btn-sm" data-action="preparing" data-id="${order.id}">Empezar a Preparar</button>`;
        buttons += `<button class="btn btn-danger btn-sm" data-action="cancel" data-id="${order.id}">Cancelar</button>`;
        break;
      case 'preparing':
        buttons += `<button class="btn btn-primary btn-sm" data-action="ready" data-id="${order.id}">Marcar como Listo</button>`;
        break;
      case 'ready_for_pickup':
        buttons += `<span style="color:var(--success);font-weight:600;">Esperando repartidor...</span>`;
        break;
      case 'assigned':
        buttons += `<span style="color:var(--primary);font-size:0.85rem;">Repartidor en camino a recoger</span>`;
        break;
      case 'picked_up':
      case 'on_the_way':
        buttons += `<span style="color:var(--primary);font-size:0.85rem;">En ruta al cliente</span>`;
        break;
      case 'delivered':
        buttons += `<span style="color:var(--success);font-size:0.85rem;">Entregado</span>`;
        break;
      case 'cancelled':
        buttons += `<span style="color:var(--danger);font-size:0.85rem;">Cancelado</span>`;
        break;
    }

    // Copy tracking link for active orders
    if (!['cancelled', 'delivered'].includes(order.status)) {
      buttons += `<button class="btn btn-outline btn-sm" data-action="copy" data-id="${order.id}" data-code="${escapeHtml(order.code)}">Copiar Link</button>`;
    }

    return buttons;
  }

  async function handleOrderAction(action, orderId) {
    switch (action) {
      case 'confirm':
        await updateOrderStatus(orderId, 'confirmed');
        break;
      case 'preparing':
        await updateOrderStatus(orderId, 'preparing');
        break;
      case 'ready':
        await updateOrderStatus(orderId, 'ready_for_pickup');
        break;
      case 'cancel':
        if (confirm('Cancelar este pedido?')) {
          await cancelOrder(orderId);
        }
        break;
      case 'copy':
        const btn = ordersList.querySelector(`[data-action="copy"][data-id="${orderId}"]`);
        if (btn) copyTrackingLink(btn.dataset.code);
        break;
    }
  }

  async function updateOrderStatus(orderId, status) {
    try {
      const res = await apiFetch('/api/restaurant/orders/' + orderId + '/status', {
        method: 'POST',
        body: JSON.stringify({ status }),
      });
      if (res.ok) {
        const statusNames = {
          confirmed: 'Pedido confirmado',
          preparing: 'Preparando pedido',
          ready_for_pickup: 'Pedido listo para recoger',
        };
        showToast(statusNames[status] || 'Estado actualizado', 'success');
        loadOrders();
        loadQuickStats();
      } else {
        const err = await res.json();
        showToast(err.error || 'Error al actualizar', 'error');
      }
    } catch {
      showToast('Error de conexion', 'error');
    }
  }

  async function cancelOrder(orderId) {
    try {
      const res = await apiFetch('/api/restaurant/orders/' + orderId + '/cancel', {
        method: 'POST',
      });
      if (res.ok) {
        showToast('Pedido cancelado', 'warning');
        loadOrders();
        loadQuickStats();
      } else {
        const err = await res.json();
        showToast(err.error || 'Error al cancelar', 'error');
      }
    } catch {
      showToast('Error de conexion', 'error');
    }
  }

  function copyTrackingLink(code) {
    const url = location.origin + '/customer.html?code=' + encodeURIComponent(code);
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(() => {
        showToast('Link de seguimiento copiado', 'success');
      }).catch(() => {
        showToast('No se pudo copiar el link', 'error');
      });
    } else {
      const ta = document.createElement('textarea');
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showToast('Link de seguimiento copiado', 'success');
    }
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

  formNewOrder.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(formNewOrder);
    const body = {
      customer_name: fd.get('customer_name'),
      customer_phone: fd.get('customer_phone') || '',
      dropoff_address: fd.get('dropoff_address'),
      items: fd.get('items'),
      notes: fd.get('notes'),
      amount: parseFloat(fd.get('amount')) || 0,
      payment_method: fd.get('payment_method'),
    };

    try {
      const submitBtn = formNewOrder.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Creando...';

      const res = await apiFetch('/api/restaurant/orders', {
        method: 'POST',
        body: JSON.stringify(body),
      });

      if (res.ok) {
        const order = await res.json();
        showToast('Pedido ' + order.code + ' creado exitosamente', 'success');
        formNewOrder.reset();
        // Switch to pedidos tab
        tabBtns.forEach((b) => b.classList.remove('active'));
        document.querySelector('[data-tab="pedidos"]').classList.add('active');
        viewPedidos.classList.remove('hidden');
        viewNuevo.classList.add('hidden');
        viewEstadisticas.classList.add('hidden');
        loadOrders();
        loadQuickStats();
      } else {
        const err = await res.json();
        showToast(err.error || 'Error al crear pedido', 'error');
      }

      submitBtn.disabled = false;
      submitBtn.textContent = 'Crear Pedido';
    } catch {
      showToast('Error de conexion', 'error');
      const submitBtn = formNewOrder.querySelector('button[type="submit"]');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Crear Pedido';
    }
  });

  // ─── Socket.IO ──────────────────────────────────────────────────────────────

  function initSocket() {
    if (socket) return;
    socket = io({ auth: { token } });

    socket.on('connect', () => {
      console.log('Socket conectado (restaurante)');
    });

    // New order created (from admin)
    socket.on('order:new', (order) => {
      showToast('Nuevo pedido: ' + order.code, 'info');
      playNotificationSound();
      loadOrders();
      loadQuickStats();
    });

    // Order status updated
    socket.on('order:status', (order) => {
      loadOrders();
      loadQuickStats();
    });

    // Order assigned to a driver
    socket.on('order:assigned', (order) => {
      showToast('Repartidor asignado a pedido ' + order.code, 'success');
      playNotificationSound();
      loadOrders();
    });

    // Order picked up by driver
    socket.on('order:picked_up', (order) => {
      showToast('Pedido ' + order.code + ' recogido por el repartidor', 'info');
      loadOrders();
      loadQuickStats();
    });

    // Order ready notification (echo back)
    socket.on('order:ready', () => {
      loadOrders();
    });

    // Notifications
    socket.on('notification', (data) => {
      if ('Notification' in window && Notification.permission === 'granted') {
        let title = 'Notificacion';
        let body = '';
        switch (data.type) {
          case 'order_new':
            title = 'Nuevo Pedido';
            body = data.data && data.data.code ? data.data.code : '';
            break;
          case 'order_assigned':
            title = 'Repartidor Asignado';
            body = data.data && data.data.code ? data.data.code : '';
            break;
          case 'order_delivered':
            title = 'Pedido Entregado';
            body = data.data && data.data.code ? data.data.code : '';
            break;
        }
        new Notification(title, { body });
      }
    });

    socket.on('disconnect', () => {
      console.log('Socket desconectado');
    });
  }

  // ─── Auto Refresh ──────────────────────────────────────────────────────────

  setInterval(() => {
    if (currentUser) {
      loadQuickStats();
    }
  }, 30000);

  // ─── Init ──────────────────────────────────────────────────────────────────

  checkAuth();
})();
