/* ─── Dispatcher (Admin Dashboard) JavaScript ────────────────────────────── */

(function () {
  'use strict';

  // ─── State ──────────────────────────────────────────────────────────────────
  let token = localStorage.getItem('token') || '';
  let currentUser = null;
  let orders = [];
  let drivers = [];
  let currentFilter = '';
  let currentSearch = '';
  let currentPage = 1;
  let totalPages = 1;
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

  // ─── Loading Spinner ────────────────────────────────────────────────────────

  let spinnerEl = null;

  function showLoading() {
    if (spinnerEl) return;
    spinnerEl = document.createElement('div');
    spinnerEl.className = 'spinner-overlay';
    spinnerEl.innerHTML = '<div class="spinner"></div>';
    document.body.appendChild(spinnerEl);
  }

  function hideLoading() {
    if (spinnerEl) {
      spinnerEl.remove();
      spinnerEl = null;
    }
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

  // ─── Notification Sound ─────────────────────────────────────────────────────

  let audioCtx = null;

  function playNotificationSound() {
    try {
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      // Play a pleasant two-tone chime
      const now = audioCtx.currentTime;

      // First tone
      const osc1 = audioCtx.createOscillator();
      const gain1 = audioCtx.createGain();
      osc1.type = 'sine';
      osc1.frequency.value = 587.33; // D5
      gain1.gain.setValueAtTime(0.3, now);
      gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
      osc1.connect(gain1);
      gain1.connect(audioCtx.destination);
      osc1.start(now);
      osc1.stop(now + 0.3);

      // Second tone (higher, slightly delayed)
      const osc2 = audioCtx.createOscillator();
      const gain2 = audioCtx.createGain();
      osc2.type = 'sine';
      osc2.frequency.value = 880; // A5
      gain2.gain.setValueAtTime(0.3, now + 0.15);
      gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.5);
      osc2.connect(gain2);
      gain2.connect(audioCtx.destination);
      osc2.start(now + 0.15);
      osc2.stop(now + 0.5);
    } catch (e) {
      // Silently fail if AudioContext is not available
    }
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

  // ─── Colombian Phone Validation & Formatting ─────────────────────────────

  /**
   * Normalizes and validates a Colombian phone number.
   * Accepts formats like: 3001234567, 300 123 4567, +573001234567, 573001234567, 03001234567
   * Returns the formatted number as +57XXXXXXXXXX or null if invalid.
   */
  function formatColombianPhone(raw) {
    if (!raw) return null;
    // Remove all non-digit characters except leading +
    let cleaned = String(raw).trim().replace(/[^\d+]/g, '');
    // Remove leading + if present
    if (cleaned.startsWith('+')) {
      cleaned = cleaned.substring(1);
    }
    // Remove leading country code 57 if present
    if (cleaned.startsWith('57') && cleaned.length === 12) {
      cleaned = cleaned.substring(2);
    }
    // Remove leading 0 (some people dial 0 + number)
    if (cleaned.startsWith('0') && cleaned.length === 11) {
      cleaned = cleaned.substring(1);
    }
    // Colombian mobile numbers: 10 digits starting with 3
    // Colombian landline numbers: 10 digits (area code + 7 digits), area codes start with non-3
    if (cleaned.length !== 10) {
      return null;
    }
    // Mobile numbers must start with 3, landlines start with other digits (1-8 for area codes)
    if (!/^[1-8]\d{9}$/.test(cleaned) && !/^3\d{9}$/.test(cleaned)) {
      return null;
    }
    return '+57' + cleaned;
  }

  /**
   * Validates a Colombian phone number. Returns true if valid, false otherwise.
   */
  function isValidColombianPhone(raw) {
    return formatColombianPhone(raw) !== null;
  }

  /**
   * Shows inline validation error on a phone input field.
   */
  function showPhoneError(input, message) {
    // Add error styling to the wrapper if it exists, otherwise to input
    const wrapper = input.closest('.phone-input-wrapper');
    if (wrapper) {
      wrapper.classList.add('input-error');
    } else {
      input.classList.add('input-error');
    }
    const formGroup = input.closest('.form-group');
    let errorEl = formGroup.querySelector('.phone-error');
    if (!errorEl) {
      errorEl = document.createElement('span');
      errorEl.className = 'phone-error';
      formGroup.appendChild(errorEl);
    }
    errorEl.textContent = message;
  }

  /**
   * Clears inline validation error from a phone input field.
   */
  function clearPhoneError(input) {
    const wrapper = input.closest('.phone-input-wrapper');
    if (wrapper) {
      wrapper.classList.remove('input-error');
    } else {
      input.classList.remove('input-error');
    }
    const formGroup = input.closest('.form-group');
    if (formGroup) {
      const errorEl = formGroup.querySelector('.phone-error');
      if (errorEl) errorEl.remove();
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
        token = data.token;
        localStorage.setItem('token', token);
        currentUser = data.user;
        showApp();
      } else if (res.status === 429) {
        // Account locked
        loginError.className = 'login-error login-error-locked';
        loginError.innerHTML = '<strong>&#128274; Cuenta bloqueada</strong><br>' + (data.error || 'Demasiados intentos. Intenta mas tarde.');
        submitBtn.disabled = true;
        // Re-enable after lockout
        const retryMs = (data.retry_after_minutes || 15) * 60 * 1000;
        setTimeout(() => {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Iniciar Sesion';
          loginError.textContent = '';
          loginError.className = 'login-error';
        }, retryMs);
        // Show countdown
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
        // Show attempts remaining
        let msg = data.error || 'Error al iniciar sesion';
        if (data.attempts_remaining != null) {
          loginError.className = 'login-error login-error-warning';
        }
        loginError.textContent = msg;
      }
    } catch (err) {
      loginError.textContent = 'Error de conexion';
    } finally {
      if (!loginError.classList.contains('login-error-locked')) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Iniciar Sesion';
      }
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
      btnRefresh.textContent = '⟳ Cargando...';
      try {
        await loadData();
        showToast('Datos actualizados', 'success');
      } catch {
        showToast('Error al refrescar', 'error');
      } finally {
        btnRefresh.disabled = false;
        btnRefresh.textContent = '↻ Refrescar';
      }
    });
  }

  // ─── Pop-out Map ─────────────────────────────────────────────────────────────

  const btnPopoutMap = document.getElementById('btn-popout-map');
  if (btnPopoutMap) {
    btnPopoutMap.addEventListener('click', function () {
      var w = window.open('/map-fullscreen.html', 'mapa-proyeccion', 'width=1280,height=800,menubar=no,toolbar=no,location=no,status=no');
      if (w) {
        showToast('Mapa abierto en ventana separada', 'success');
      } else {
        showToast('Permite ventanas emergentes para proyectar el mapa', 'warning');
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
      viewMapa.classList.toggle('hidden', tab !== 'mapa');
      viewRepartidores.classList.toggle('hidden', tab !== 'repartidores');
      viewReportes.classList.toggle('hidden', tab !== 'reportes');
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
      let url = '/api/orders?page=' + currentPage + '&limit=50';
      if (currentFilter) url += '&status=' + currentFilter;
      if (currentSearch) url += '&search=' + encodeURIComponent(currentSearch);
      const res = await apiFetch(url);
      if (res.ok) {
        const data = await res.json();
        // Support both paginated (admin) and array (driver) responses
        if (data.orders) {
          orders = data.orders;
          totalPages = data.pagination.pages;
          currentPage = data.pagination.page;
        } else {
          orders = data;
          totalPages = 1;
        }
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
      const dName = getDriverName(order.driver_id);
      const card = document.createElement('div');
      card.className = 'order-card';
      card.innerHTML = `
        <div>
          <span class="order-code">${escapeHtml(order.code)}</span>
          <span class="badge badge-${escapeHtml(order.status)}">${escapeHtml(statusLabel(order.status))}</span>
        </div>
        <div class="order-info">
          <div class="order-customer">${escapeHtml(order.customer_name)}</div>
          <div class="order-addresses">
            <strong>Recogida:</strong> ${escapeHtml(order.pickup_address || '-')} &rarr; <strong>Entrega:</strong> ${escapeHtml(order.dropoff_address || '-')}
          </div>
          <div class="order-meta">
            ${dName ? '<span>Repartidor: ' + escapeHtml(dName) + '</span>' : ''}
            <span>${escapeHtml(formatTime(order.created_at))}</span>
            ${order.amount ? '<span>$' + escapeHtml(String(order.amount)) + '</span>' : ''}
          </div>
        </div>
        <div class="order-actions">
          ${order.status === 'pending' ? '<button class="btn btn-primary btn-sm" data-assign="' + order.id + '">Asignar Repartidor</button>' : ''}
          ${['assigned', 'picked_up', 'on_the_way'].includes(order.status) ? '<button class="btn btn-outline btn-sm" data-route="' + order.id + '">Ver Ruta</button>' : ''}
          <button class="btn btn-outline btn-sm" data-copy-link="${escapeHtml(order.code)}">Copiar Link</button>
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
    ordersList.querySelectorAll('[data-route]').forEach((btn) => {
      btn.addEventListener('click', () => showOrderRoute(parseInt(btn.dataset.route)));
    });
    ordersList.querySelectorAll('[data-copy-link]').forEach((btn) => {
      btn.addEventListener('click', () => copyTrackingLink(btn.dataset.copyLink));
    });

    // Render pagination controls
    renderPagination();
  }

  function renderPagination() {
    let paginationEl = document.getElementById('orders-pagination');
    if (!paginationEl) {
      paginationEl = document.createElement('div');
      paginationEl.id = 'orders-pagination';
      paginationEl.className = 'pagination';
      ordersList.parentElement.appendChild(paginationEl);
    }

    if (totalPages <= 1) {
      paginationEl.innerHTML = '';
      return;
    }

    let html = '';
    html += `<button class="btn btn-outline btn-sm" ${currentPage <= 1 ? 'disabled' : ''} data-page="${currentPage - 1}">&laquo; Anterior</button>`;
    html += `<span class="pagination-info">Pagina ${currentPage} de ${totalPages}</span>`;
    html += `<button class="btn btn-outline btn-sm" ${currentPage >= totalPages ? 'disabled' : ''} data-page="${currentPage + 1}">Siguiente &raquo;</button>`;

    paginationEl.innerHTML = html;

    paginationEl.querySelectorAll('[data-page]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const page = parseInt(btn.dataset.page);
        if (page >= 1 && page <= totalPages) {
          currentPage = page;
          loadOrders();
        }
      });
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
      currentPage = 1;
      loadOrders();
    });
  });

  // ─── Search Orders ─────────────────────────────────────────────────────────

  const searchInput = document.getElementById('search-orders');
  let searchTimeout = null;
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        currentSearch = searchInput.value.trim();
        currentPage = 1;
        loadOrders();
      }, 400); // debounce 400ms
    });
  }

  // ─── Create Order ──────────────────────────────────────────────────────────

  btnNewOrder.addEventListener('click', () => modalNewOrder.classList.remove('hidden'));
  btnCancelOrderForm.addEventListener('click', () => modalNewOrder.classList.add('hidden'));

  formNewOrder.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(formNewOrder);
    const rawPhone = fd.get('customer_phone');
    const phoneInput = formNewOrder.querySelector('[name="customer_phone"]');

    // Validate Colombian phone number if provided
    if (rawPhone && rawPhone.trim()) {
      const formatted = formatColombianPhone(rawPhone);
      if (!formatted) {
        showPhoneError(phoneInput, 'Ingresa un numero colombiano valido (ej: 3001234567)');
        return;
      }
      clearPhoneError(phoneInput);
    } else {
      clearPhoneError(phoneInput);
    }

    const body = {
      customer_name: fd.get('customer_name'),
      customer_phone: rawPhone && rawPhone.trim() ? formatColombianPhone(rawPhone) : '',
      pickup_address: fd.get('pickup_address'),
      dropoff_address: fd.get('dropoff_address'),
      items: fd.get('items'),
      notes: fd.get('notes'),
      amount: parseFloat(fd.get('amount')) || 0,
      payment_method: fd.get('payment_method'),
    };
    try {
      showLoading();
      const res = await apiFetch('/api/orders', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      hideLoading();
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
      hideLoading();
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
          <h3>${escapeHtml(d.name)}</h3>
          <span class="badge badge-${d.status === 'available' ? 'delivered' : d.status === 'busy' ? 'assigned' : 'cancelled'}">
            <span class="status-dot ${statusClass}"></span> ${escapeHtml(statusText)}
          </span>
        </div>
        <div class="driver-card-details">
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
    const rawPhone = fd.get('phone');
    const phoneInput = formNewDriver.querySelector('[name="phone"]');

    // Validate Colombian phone number if provided
    if (rawPhone && rawPhone.trim()) {
      const formatted = formatColombianPhone(rawPhone);
      if (!formatted) {
        showPhoneError(phoneInput, 'Ingresa un numero colombiano valido (ej: 3001234567)');
        return;
      }
      clearPhoneError(phoneInput);
    } else {
      clearPhoneError(phoneInput);
    }

    const body = {
      name: fd.get('name'),
      email: fd.get('email'),
      password: fd.get('password'),
      phone: rawPhone && rawPhone.trim() ? formatColombianPhone(rawPhone) : '',
      vehicle: fd.get('vehicle'),
      plate: fd.get('plate'),
    };
    try {
      showLoading();
      const res = await apiFetch('/api/drivers', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      hideLoading();
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
      hideLoading();
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
            .bindPopup('Recogida: ' + escapeHtml(o.pickup_address || o.code))
            .addTo(map);
        }
        if (o.dropoff_lat && o.dropoff_lng) {
          L.circleMarker([o.dropoff_lat, o.dropoff_lng], { radius: 6, color: '#ef4444', fillOpacity: 0.8 })
            .bindPopup('Entrega: ' + escapeHtml(o.dropoff_address || o.code))
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
    }).bindPopup(`<strong>${escapeHtml(d.name)}</strong><br>Vehiculo: ${escapeHtml(d.vehicle || '-')}<br>Velocidad: ${d.speed || 0} km/h`);
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
      const marker = L.circleMarker([data.lat, data.lng], {
        radius: 10,
        color: '#22c55e',
        fillColor: '#22c55e',
        fillOpacity: 0.8,
      }).bindPopup(`<strong>${escapeHtml(data.name)}</strong><br>Velocidad: ${data.speed || 0} km/h`);
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
      playNotificationSound();
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
      } else {
        showToast('Error al cargar el resumen', 'error');
      }
    } catch {
      showToast('Error de conexion', 'error');
    }
  });

  // ─── Auto Refresh ──────────────────────────────────────────────────────────

  setInterval(() => {
    if (currentUser) {
      loadStats();
    }
  }, 30000);

  // ─── Init ──────────────────────────────────────────────────────────────────

  checkAuth();
})();
