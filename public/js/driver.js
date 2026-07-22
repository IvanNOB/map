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

  // ═══════════════════════════════════════════════════════════════════════════════
  // FEATURE 2: DISTANCE/TIME ETA CACHE
  // ═══════════════════════════════════════════════════════════════════════════════
  const etaCache = {}; // key: "orderId_lat_lng" => { ts, distanceKm, minutes }

  // ═══════════════════════════════════════════════════════════════════════════════
  // FEATURE 10: ANIMATED DASHED ROUTE LINE STATE
  // ═══════════════════════════════════════════════════════════════════════════════
  let routeAnimInterval = null;
  let routeDashOffset = 0;


  // ─── OSRM Routing ──────────────────────────────────────────────────────────
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


  // ═══════════════════════════════════════════════════════════════════════════════
  // FEATURE 10: ANIMATED DASHED ROUTE LINE
  // Draw the fastest route with animated "marching ants" dashes
  // ═══════════════════════════════════════════════════════════════════════════════
  async function updateDriverRoute(curLat, curLng) {
    if (!map) return;
    const active = orders.find(function (o) { return ['assigned', 'picked_up', 'on_the_way'].includes(o.status); });
    if (!active) {
      if (driverRoutePolyline) { map.removeLayer(driverRoutePolyline); driverRoutePolyline = null; }
      if (routeAnimInterval) { clearInterval(routeAnimInterval); routeAnimInterval = null; }
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
    if (routeAnimInterval) { clearInterval(routeAnimInterval); routeAnimInterval = null; }

    driverRoutePolyline = L.polyline(route.latlngs, {
      color: toPickup ? '#22c55e' : '#3b82f6',
      weight: 5,
      opacity: 0.8,
      dashArray: '12, 8',
      dashOffset: '0'
    }).addTo(map);

    // Animate the dashes ("marching ants" effect)
    routeDashOffset = 0;
    routeAnimInterval = setInterval(function () {
      routeDashOffset -= 1;
      if (driverRoutePolyline && driverRoutePolyline._path) {
        driverRoutePolyline._path.style.strokeDashoffset = routeDashOffset + 'px';
      }
    }, 100);
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

  // ═══════════════════════════════════════════════════════════════════════════════
  // FEATURE 5: AUTO DARK/LIGHT MODE
  // Apply theme based on time of day unless user manually set a preference.
  // ═══════════════════════════════════════════════════════════════════════════════
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
    var btn = document.getElementById('btn-theme');
    if (btn) btn.textContent = theme === 'light' ? '☀️ Cambiar tema' : '🌙 Cambiar tema';
  }

  function autoThemeCheck() {
    if (localStorage.getItem('theme_manual') === 'true') return;
    var hour = new Date().getHours();
    var autoTheme = (hour >= 6 && hour < 18) ? 'light' : 'dark';
    applyTheme(autoTheme);
  }

  // Apply on load
  if (localStorage.getItem('theme_manual') === 'true') {
    applyTheme(localStorage.getItem('theme') || 'dark');
  } else {
    autoThemeCheck();
  }
  // Re-check every 60 seconds
  setInterval(autoThemeCheck, 60000);

  document.addEventListener('click', function (e) {
    if (e.target && e.target.id === 'btn-theme') {
      var cur = document.documentElement.getAttribute('data-theme');
      var next = cur === 'light' ? 'dark' : 'light';
      applyTheme(next);
      // Mark as manual preference
      localStorage.setItem('theme_manual', 'true');
    }
  });


  // ─── DOM References ─────────────────────────────────────────────────────────
  var loginScreen = document.getElementById('login-screen');
  var app = document.getElementById('app');
  var loginForm = document.getElementById('login-form');
  var loginError = document.getElementById('login-error');
  var driverName = document.getElementById('driver-name');
  var btnLogout = document.getElementById('btn-logout');
  var toastContainer = document.getElementById('toast-container');
  var driverOrders = document.getElementById('driver-orders');
  var toggleOnline = document.getElementById('toggle-online');
  var statusLabel = document.getElementById('status-label');
  var consentLocation = document.getElementById('consent-location');
  var btnShareLocation = document.getElementById('btn-share-location');
  var btnStopLocation = document.getElementById('btn-stop-location');
  var gpsReadout = document.getElementById('gps-readout');

  // ─── Helpers ────────────────────────────────────────────────────────────────

  function apiHeaders() {
    return {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token,
    };
  }

  async function apiFetch(url, opts) {
    opts = opts || {};
    opts.headers = Object.assign({}, apiHeaders(), opts.headers || {});
    var res = await fetch(url, opts);
    if (res.status === 401) {
      logout();
      throw new Error('No autorizado');
    }
    return res;
  }

  function showToast(message, type) {
    type = type || 'info';
    var toast = document.createElement('div');
    toast.className = 'toast ' + type;
    toast.textContent = message;
    toastContainer.appendChild(toast);
    setTimeout(function () { toast.remove(); }, 4000);
  }

  function statusLabelText(status) {
    var labels = {
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
    var actions = {
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


  // ═══════════════════════════════════════════════════════════════════════════════
  // FEATURE 1: VIBRATION + GHOST SOUND ON NEW ORDER
  // Play a spooky descending tone (600Hz→300Hz) and vibrate on order:assigned
  // ═══════════════════════════════════════════════════════════════════════════════
  function playGhostSound() {
    try {
      var AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      var ctx = new AudioContext();
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(600, ctx.currentTime);
      osc.frequency.linearRampToValueAtTime(300, ctx.currentTime + 0.5);
      gain.gain.setValueAtTime(0.4, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.6);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.6);
    } catch (e) { /* Web Audio not supported */ }
  }

  function vibrateNewOrder() {
    if (navigator.vibrate) {
      navigator.vibrate([200, 100, 200, 100, 400]);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // FEATURE 7: SOS BUTTON
  // Sends driver:sos socket event with current position, vibrates long
  // ═══════════════════════════════════════════════════════════════════════════════
  function triggerSOS() {
    var pos = lastPos || { lat: 0, lng: 0 };
    if (socket && socket.connected) {
      socket.emit('driver:sos', { lat: pos.lat, lng: pos.lng, timestamp: new Date().toISOString() });
    }
    showToast('SOS enviado a la central', 'warning');
    if (navigator.vibrate) navigator.vibrate(1000);
  }


  // ─── Auth ───────────────────────────────────────────────────────────────────

  async function checkAuth() {
    if (!token) {
      showLogin();
      return;
    }
    try {
      var res = await fetch('/api/auth/me', { headers: apiHeaders() });
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
    } catch (e) {
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
    initSOSButton();
    initBatteryMonitor();
    initActiveOrderBar();
    initWeeklyTab();
    scheduleEndOfDaySummary();
    showTutorialIfNeeded();
    // Request notification permission + subscribe to push
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
    if (window.enablePush) window.enablePush(token);
    // En el APK: pedir permiso de notificaciones nativas
    var ln = localNotifPlugin();
    if (ln && ln.requestPermissions) { try { ln.requestPermissions(); } catch (e) {} }
  }

  loginForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    loginError.textContent = '';
    var email = document.getElementById('login-email').value.trim();
    var password = document.getElementById('login-password').value;

    try {
      var res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, password: password }),
      });
      var data = await res.json();
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
    } catch (err) {
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

  btnLogout.addEventListener('click', async function () {
    try { await apiFetch('/api/auth/logout', { method: 'POST' }); } catch (e) {}
    logout();
  });


  // ─── Refresh Button ─────────────────────────────────────────────────────────

  var btnRefreshDriver = document.getElementById('btn-refresh-driver');
  if (btnRefreshDriver) {
    btnRefreshDriver.addEventListener('click', async function () {
      btnRefreshDriver.disabled = true;
      btnRefreshDriver.style.opacity = '0.5';
      btnRefreshDriver.style.transition = 'transform 0.3s';
      btnRefreshDriver.style.transform = 'rotate(360deg)';
      try {
        await loadOrders();
        await loadEarnings();
        showToast('Pedidos actualizados', 'success');
      } catch (e) {
        showToast('Error al refrescar', 'error');
      } finally {
        btnRefreshDriver.disabled = false;
        btnRefreshDriver.style.opacity = '1';
        btnRefreshDriver.style.transform = '';
      }
    });
  }


  // ─── Orders ─────────────────────────────────────────────────────────────────

  var lastOrdersJSON = '';

  async function loadOrders() {
    try {
      var res = await apiFetch('/api/orders');
      if (res.ok) {
        var newOrders = await res.json();
        var newJSON = JSON.stringify(newOrders);
        // Solo re-renderizar si los datos cambiaron
        if (newJSON === lastOrdersJSON) return;
        lastOrdersJSON = newJSON;
        orders = newOrders;
        lastRouteTs = 0;
        renderOrders();
        updateActiveOrderBar();
        if (lastPos) updateDriverRoute(lastPos.lat, lastPos.lng);
      }
    } catch (e) {}
  }

  function renderOrders() {
    driverOrders.innerHTML = '';
    var active = orders.filter(function (o) { return o.status !== 'delivered' && o.status !== 'cancelled'; });
    var delivered = orders.filter(function (o) { return o.status === 'delivered'; });

    // Update active orders count in stats
    var activeEl = document.getElementById('stat-active-orders');
    if (activeEl) activeEl.textContent = active.length;

    if (active.length === 0 && delivered.length === 0) {
      driverOrders.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:1rem;">No tienes pedidos asignados</p>';
      return;
    }

    active.forEach(function (order, idx) { renderOrderCard(order, idx); });

    if (delivered.length > 0) {
      var divider = document.createElement('h4');
      divider.textContent = 'Completados';
      divider.style.cssText = 'color:var(--text-muted);font-size:0.85rem;margin:1rem 0 0.5rem;';
      driverOrders.appendChild(divider);
      delivered.slice(0, 3).forEach(function (order) { renderOrderCard(order); });
    }

    renderOrderMarkers();
    // FEATURE 2: calculate ETA for active orders
    computeETAsForOrders(active);
    // FEATURE 11: mark urgent orders
    markUrgentOrders();
  }


  // Colores para diferenciar pedidos por orden de prioridad
  var orderColors = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899'];

  function renderOrderCard(order, idx) {
    var card = document.createElement('div');
    var colorIdx = (typeof idx === 'number') ? idx % orderColors.length : 0;
    var color = orderColors[colorIdx];
    card.className = 'driver-order-card';
    card.setAttribute('data-order-id', order.id);
    card.style.borderLeft = '4px solid ' + color;
    var action = nextAction(order.status);

    // Navigation target: go to pickup while assigned, to dropoff once picked up
    var navBtn = '';
    var toPickup = order.status === 'assigned';
    var navLat = toPickup ? order.pickup_lat : order.dropoff_lat;
    var navLng = toPickup ? order.pickup_lng : order.dropoff_lng;
    if (navLat && navLng) {
      var navUrl = 'https://www.google.com/maps/dir/?api=1&destination=' + navLat + ',' + navLng + '&travelmode=driving';
      navBtn = '<a class="btn btn-nav btn-sm" href="' + navUrl + '" target="_blank" rel="noopener">🧭 Navegar</a>';
    }

    // Contact the customer via WhatsApp / call
    var contactBtns = '';
    if (order.customer_phone) {
      var digits = String(order.customer_phone).replace(/[^0-9]/g, '');
      if (digits) {
        var waMsg = encodeURIComponent('Hola! Soy tu repartidor de Servicio Ghost con tu pedido ' + order.code + '.');
        contactBtns =
          '<a class="btn btn-whatsapp btn-sm" href="https://wa.me/' + digits + '?text=' + waMsg + '" target="_blank" rel="noopener">💬 WA</a>' +
          '<a class="btn btn-outline btn-sm" href="tel:' + digits + '">📞</a>';
      }
    }

    // Main action button (big)
    var mainActionHtml = '';
    if (action) {
      var actionClass = action.next === 'picked_up' ? 'action-pickup' : action.next === 'on_the_way' ? 'action-enroute' : 'action-deliver';
      var actionEmoji = action.next === 'picked_up' ? '📦 ' : action.next === 'on_the_way' ? '🛵 ' : '✅ ';
      mainActionHtml = '<button class="order-main-action ' + actionClass + '" data-order-id="' + order.id + '" data-next-status="' + action.next + '">' + actionEmoji + escapeHtml(action.label) + '</button>';
    }

    // FEATURE 2: ETA placeholder span
    var etaSpan = '<span class="data-eta" data-eta-order="' + order.id + '" style="font-size:0.72rem;color:var(--text-muted);display:block;margin-top:0.3rem;"></span>';

    card.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.4rem;">' +
        '<div style="display:flex;align-items:center;gap:0.4rem;">' +
          '<span style="background:' + color + ';color:#fff;font-weight:bold;font-size:0.7rem;width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;">' + (typeof idx === 'number' ? idx + 1 : '') + '</span>' +
          '<span class="order-code">' + escapeHtml(order.code) + '</span>' +
        '</div>' +
        '<span class="badge badge-' + escapeHtml(order.status) + '">' + escapeHtml(statusLabelText(order.status)) + '</span>' +
      '</div>' +
      '<div class="order-detail"><strong>' + escapeHtml(order.customer_name) + '</strong></div>' +
      '<div class="order-detail">🟢 ' + escapeHtml(order.pickup_address || '-') + '</div>' +
      '<div class="order-detail">🔴 ' + escapeHtml(order.dropoff_address || '-') + '</div>' +
      (order.amount ? '<div class="order-detail" style="color:var(--gold);font-weight:600;">💰 $' + escapeHtml(String(order.amount)) + '</div>' : '') +
      etaSpan +
      mainActionHtml +
      (order.status !== 'delivered' ? '<div class="order-secondary-actions">' + navBtn + contactBtns + '</div>' : '<span class="badge badge-delivered" style="margin-top:0.5rem;">✅ Completado</span>');

    driverOrders.appendChild(card);

    // Bind main action button
    var btn = card.querySelector('[data-order-id][data-next-status]');
    if (btn) {
      btn.addEventListener('click', function () { updateOrderStatus(btn.dataset.orderId, btn.dataset.nextStatus); });
    }

    // FEATURE 9: Swipe to change status
    if (action) {
      initSwipeOnCard(card, order.id, action.next);
    }
  }


  // ═══════════════════════════════════════════════════════════════════════════════
  // FEATURE 9: SWIPE TO CHANGE STATUS
  // If user swipes right >100px on a card, trigger next status change
  // ═══════════════════════════════════════════════════════════════════════════════
  function initSwipeOnCard(card, orderId, nextStatus) {
    var startX = 0;
    var startY = 0;
    var swiping = false;

    card.addEventListener('touchstart', function (e) {
      var touch = e.touches[0];
      startX = touch.clientX;
      startY = touch.clientY;
      swiping = true;
    }, { passive: true });

    card.addEventListener('touchmove', function (e) {
      if (!swiping) return;
      var touch = e.touches[0];
      var dx = touch.clientX - startX;
      var dy = Math.abs(touch.clientY - startY);
      // If vertical scroll is more dominant, cancel swipe
      if (dy > 30 && dy > Math.abs(dx)) { swiping = false; card.style.transform = ''; return; }
      if (dx > 0) {
        card.style.transform = 'translateX(' + Math.min(dx, 150) + 'px)';
        card.style.transition = 'none';
      }
    }, { passive: true });

    card.addEventListener('touchend', function (e) {
      if (!swiping) { card.style.transform = ''; return; }
      var touch = e.changedTouches[0];
      var dx = touch.clientX - startX;
      swiping = false;
      if (dx > 100) {
        // Green flash + slide out
        card.style.transition = 'transform 0.3s, background 0.3s';
        card.style.transform = 'translateX(300px)';
        card.style.background = 'rgba(34,197,94,0.3)';
        setTimeout(function () {
          updateOrderStatus(orderId, nextStatus);
        }, 300);
      } else {
        card.style.transition = 'transform 0.2s';
        card.style.transform = '';
      }
    }, { passive: true });
  }


  // ═══════════════════════════════════════════════════════════════════════════════
  // FEATURE 2: DISTANCE/TIME ON ORDER CARDS
  // Calculate ETA from driver's position to pickup/dropoff using OSRM. Cache 30s.
  // ═══════════════════════════════════════════════════════════════════════════════
  async function computeETAsForOrders(activeOrders) {
    if (!lastPos) return;
    for (var i = 0; i < activeOrders.length; i++) {
      var order = activeOrders[i];
      var toPickup = order.status === 'assigned';
      var tLat = toPickup ? order.pickup_lat : order.dropoff_lat;
      var tLng = toPickup ? order.pickup_lng : order.dropoff_lng;
      if (!tLat || !tLng) continue;

      var cacheKey = order.id + '_' + lastPos.lat.toFixed(3) + '_' + lastPos.lng.toFixed(3);
      var cached = etaCache[cacheKey];
      var now = Date.now();

      var result = null;
      if (cached && (now - cached.ts < 30000)) {
        result = cached;
      } else {
        var route = await osrmRoute(lastPos.lat, lastPos.lng, tLat, tLng);
        if (route) {
          result = { ts: now, distanceKm: route.distanceKm, minutes: route.minutes };
          etaCache[cacheKey] = result;
        }
      }

      if (result) {
        var etaEl = document.querySelector('[data-eta-order="' + order.id + '"]');
        if (etaEl) {
          etaEl.textContent = '~' + result.distanceKm.toFixed(1) + ' km · ~' + Math.round(result.minutes) + ' min';
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // FEATURE 11: URGENT ORDER PULSING RED
  // If order created_at >15 min ago and still assigned/picked_up, add pulse class
  // ═══════════════════════════════════════════════════════════════════════════════
  function markUrgentOrders() {
    var now = Date.now();
    orders.forEach(function (order) {
      if (!['assigned', 'picked_up'].includes(order.status)) return;
      if (!order.created_at) return;
      var created = new Date(order.created_at).getTime();
      if (isNaN(created)) return;
      var elapsedMin = (now - created) / 60000;
      if (elapsedMin > 15) {
        var card = document.querySelector('.driver-order-card[data-order-id="' + order.id + '"]');
        if (card) card.classList.add('order-urgent');
      }
    });
  }


  // ─── Upload Proof (photo) ───────────────────────────────────────────────────
  function uploadProof(orderId) {
    return new Promise(function (resolve, reject) {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.capture = 'environment';
      input.onchange = function () {
        var file = input.files && input.files[0];
        if (!file) { reject(new Error('No file')); return; }
        var reader = new FileReader();
        reader.onload = function (e) {
          var img = new Image();
          img.onload = async function () {
            var max = 800;
            var w = img.width, h = img.height;
            if (w > max) { h = Math.round(h * max / w); w = max; }
            var canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            canvas.getContext('2d').drawImage(img, 0, 0, w, h);
            var dataUrl = canvas.toDataURL('image/jpeg', 0.6);
            try {
              var res = await apiFetch('/api/orders/' + orderId + '/proof', {
                method: 'POST',
                body: JSON.stringify({ image: dataUrl }),
              });
              if (res.ok) { showToast('Foto de entrega subida', 'success'); resolve(true); }
              else { var er = await res.json(); showToast(er.error || 'Error al subir', 'error'); reject(new Error('Upload failed')); }
            } catch (err) { showToast('Error de conexion', 'error'); reject(err); }
          };
          img.src = e.target.result;
        };
        reader.readAsDataURL(file);
      };
      // If user cancels the file picker
      input.addEventListener('cancel', function () { reject(new Error('Cancelled')); });
      input.click();
    });
  }


  // ═══════════════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════════════
  // FEATURE 12: PHOTO OPTIONAL BEFORE DELIVERED
  // ═══════════════════════════════════════════════════════════════════════════════
  async function updateOrderStatus(orderId, status) {
    try {
      var res = await apiFetch('/api/orders/' + orderId + '/status', {
        method: 'POST',
        body: JSON.stringify({ status: status }),
      });
      if (res.ok) {
        showToast('Estado actualizado: ' + statusLabelText(status), 'success');
        loadOrders();
        loadEarnings();
      } else {
        var err = await res.json();
        showToast(err.error || 'Error al actualizar', 'error');
      }
    } catch (e) {
      showToast('Error de conexion', 'error');
    }
  }


  // ═══════════════════════════════════════════════════════════════════════════════
  // FEATURE 3: AUTO-START GPS WHEN GOING ONLINE
  // ═══════════════════════════════════════════════════════════════════════════════
  toggleOnline.addEventListener('change', function () {
    if (toggleOnline.checked) {
      statusLabel.textContent = 'En linea';
      statusLabel.style.color = 'var(--success)';
      // Auto-start GPS if not already sharing
      if (!sharing) {
        startSharing();
      }
    } else {
      statusLabel.textContent = 'Desconectado';
      statusLabel.style.color = 'var(--text-muted)';
      stopSharing();
    }
  });

  // ─── Location Sharing ──────────────────────────────────────────────────────

  consentLocation.addEventListener('change', function () {
    btnShareLocation.disabled = !consentLocation.checked;
  });
  // Auto-enable GPS button (consent is auto-accepted)
  btnShareLocation.disabled = false;

  btnShareLocation.addEventListener('click', startSharing);
  btnStopLocation.addEventListener('click', stopSharing);

  // ─── Wake Lock (keep screen on while sharing) ───────────────────────────────
  var wakeLock = null;
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
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && sharing) {
      acquireWakeLock();
      if (lastPos) postLocation(lastPos.lat, lastPos.lng, lastPos.speed);
    }
  });


  // ─── Capacitor (native Android) background geolocation, if available ─────────
  function bgPlugin() {
    return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BackgroundGeolocation) || null;
  }

  // Notificaciones NATIVAS del APK
  function localNotifPlugin() {
    return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications) || null;
  }
  async function notifyDriverDevice(title, body) {
    var ln = localNotifPlugin();
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

  function updateBgStatus() {
    // Removed - drivers already accept permissions and don't need this message
  }
  setTimeout(updateBgStatus, 1200);

  var bgWatcherId = null;
  var lastPos = null;
  var heartbeat = null;

  function postLocation(lat, lng, speed) {
    fetch('/api/location/ping', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ lat: lat, lng: lng, speed: speed || 0 }),
      keepalive: true,
    }).catch(function () {});
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeat = setInterval(function () {
      if (lastPos) postLocation(lastPos.lat, lastPos.lng, lastPos.speed);
    }, 15000);
  }
  function stopHeartbeat() {
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
  }


  function sendLocation(latitude, longitude, speed, heading, accuracy) {
    var now = new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
    var speedKmh = ((speed || 0) * 3.6).toFixed(0);
    var speedEl = document.getElementById('gps-speed');
    if (speedEl) speedEl.textContent = speedKmh + ' km/h';
    gpsReadout.textContent = 'Precision: ' + (accuracy || 0).toFixed(0) + 'm · ' + now;
    if (map) {
      var latlng = [latitude, longitude];
      if (positionMarker) positionMarker.setLatLng(latlng);
      else {
        positionMarker = L.marker(latlng, { icon: pinIcon('driver', '🛵') }).addTo(map);
        map.setView(latlng, 15);
      }
    }
    lastPos = { lat: latitude, lng: longitude, speed: speed || 0 };
    postLocation(latitude, longitude, speed);
    updateDriverRoute(latitude, longitude);
  }

  function startSharing() {
    if (!consentLocation.checked) return;

    var bg = bgPlugin();
    sharing = true;
    btnShareLocation.classList.add('hidden');
    btnStopLocation.classList.remove('hidden');
    startHeartbeat();
    updateBgStatus();

    if (bg) {
      bg.addWatcher({
        backgroundMessage: "Compartiendo tu ubicacion con la central",
        backgroundTitle: "Repartidor en linea",
        requestPermissions: true,
        stale: false,
        distanceFilter: 20,
      }, function (location, error) {
        if (error) {
          if (error.code === 'NOT_AUTHORIZED') {
            showToast('Activa el permiso de ubicacion en "Permitir todo el tiempo"', 'warning');
          }
          return;
        }
        if (location) sendLocation(location.latitude, location.longitude, location.speed, location.bearing, location.accuracy);
      }).then(function (id) { bgWatcherId = id; });
      showToast('Rastreo en segundo plano activado. Permite la ubicacion "todo el tiempo".', 'success');
      return;
    }

    // Web fallback
    if (!navigator.geolocation) { showToast('Geolocalizacion no disponible', 'error'); return; }
    showToast('Atencion: en el navegador la ubicacion se detiene si sales de la app. Instala la APK para segundo plano.', 'warning');
    acquireWakeLock();
    watchId = navigator.geolocation.watchPosition(
      function (pos) {
        var coords = pos.coords;
        sendLocation(coords.latitude, coords.longitude, coords.speed, coords.heading, coords.accuracy);
      },
      function (err) { showToast('Error de geolocalizacion: ' + err.message, 'error'); },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
    );
  }

  function stopSharing() {
    var bg = bgPlugin();
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

    fetch('/api/location/offline', { method: 'POST', headers: apiHeaders(), keepalive: true }).catch(function () {});
    if (socket && socket.connected) {
      socket.emit('driver:stop');
    }
  }


  // ─── Map ────────────────────────────────────────────────────────────────────

  function initMap() {
    if (map) return;
    map = L.map('driver-map').setView([4.6097, -74.0817], 13);
    window._driverMap = map; // Expose for invalidateSize from HTML
    var darkMatter = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; CartoDB', maxZoom: 19,
    });
    var satellite = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { attribution: 'Tiles &copy; Esri', maxZoom: 19 }
    );
    darkMatter.addTo(map);
    L.control.layers({ '🌑 Dark Ghost': darkMatter, '🛰️ Satelital': satellite }, null, { position: 'topright' }).addTo(map);

    // Center on me button
    var CenterControl = L.Control.extend({
      options: { position: 'topleft' },
      onAdd: function () {
        var btn = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
        btn.innerHTML = '<a href="#" title="Centrar en mi ubicacion" style="display:flex;align-items:center;justify-content:center;width:34px;height:34px;font-size:1.2rem;text-decoration:none;background:var(--panel,#1a1e2b);color:#fff;border-radius:4px;">📍</a>';
        L.DomEvent.disableClickPropagation(btn);
        btn.querySelector('a').addEventListener('click', function (e) {
          e.preventDefault();
          if (lastPos && map) map.setView([lastPos.lat, lastPos.lng], 16);
          else showToast('Activa el GPS primero', 'warning');
        });
        return btn;
      }
    });
    map.addControl(new CenterControl());

    renderOrderMarkers();

    // Forzar que Leaflet recalcule el tamaño del contenedor
    setTimeout(function() { if (map) map.invalidateSize(); }, 100);
    setTimeout(function() { if (map) map.invalidateSize(); }, 500);
    setTimeout(function() { if (map) map.invalidateSize(); }, 1500);
  }

  // Show pickup (green) and dropoff (red) markers for active orders
  function renderOrderMarkers() {
    if (!map) return;
    orderMarkers.forEach(function (m) { map.removeLayer(m); });
    orderMarkers = [];
    var bounds = [];
    orders.forEach(function (o) {
      if (!['assigned', 'picked_up', 'on_the_way'].includes(o.status)) return;
      if (o.pickup_lat && o.pickup_lng) {
        var m = L.marker([o.pickup_lat, o.pickup_lng], { icon: pinIcon('pickup', '🟢') })
          .bindPopup('🟢 Recogida ' + escapeHtml(o.code) + '<br>' + escapeHtml(o.pickup_address || '')).addTo(map);
        orderMarkers.push(m); bounds.push([o.pickup_lat, o.pickup_lng]);
      }
      if (o.dropoff_lat && o.dropoff_lng) {
        var m2 = L.marker([o.dropoff_lat, o.dropoff_lng], { icon: pinIcon('dropoff', '🔴') })
          .bindPopup('🔴 Entrega ' + escapeHtml(o.code) + '<br>' + escapeHtml(o.dropoff_address || '')).addTo(map);
        orderMarkers.push(m2); bounds.push([o.dropoff_lat, o.dropoff_lng]);
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
    var today = new Date().toISOString().slice(0, 10);
    try {
      var res = await fetch('/api/reports/my-earnings?from=' + today + '&to=' + today, { headers: apiHeaders() });
      if (!res.ok) return;
      var e = await res.json();
      var v = document.getElementById('earn-today');
      var d = document.getElementById('earn-deliveries');
      var p = document.getElementById('earn-pct');
      if (v) v.textContent = '$' + Number(e.earning || 0).toLocaleString();
      if (d) d.textContent = (e.deliveries || 0) + ' entregas';
      if (p) p.textContent = 'Comision ' + (e.commission_pct || 0) + '%';
    } catch (err) {}
  }


  function initSocket() {
    if (socket) return;
    socket = io({ auth: { token: token } });
    socket.on('connect', function () {
      console.log('Socket conectado (repartidor)');
      // Initialize Walkie-Talkie
      if (window._initWalkie && currentUser) {
        window._initWalkie(socket, currentUser.id);
      }
      // Expose socket for walkie and SOS
      window._driverSocket = socket;
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // FEATURE 1: VIBRATION + GHOST SOUND ON NEW ORDER (order:assigned)
    // ═══════════════════════════════════════════════════════════════════════════
    socket.on('order:assigned', function (order) {
      // Vibrate phone
      vibrateNewOrder();
      // Play ghost sound
      playGhostSound();

      if (window.ghostAlert) window.ghostAlert({ title: '👻 ¡Nuevo domicilio asignado!', body: order && order.code ? '📦 ' + order.code + ' - ¡A rodar!' : '¡Tienes un nuevo pedido!' });
      notifyDriverDevice('👻 ¡SERVICIOS GHOST!', order && order.code ? '📦 Nuevo domicilio: ' + order.code + ' - ¡A entregar!' : '¡Tienes un nuevo pedido asignado!');
      loadOrders();
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // FEATURE: COMPETITIVE ORDER ACCEPTANCE (order:available)
    // All drivers get alerted, first to accept gets the order
    // ═══════════════════════════════════════════════════════════════════════════
    socket.on('order:available', function (order) {
      console.log('Nuevo pedido disponible:', order && order.code);
      // Vibrate + sound
      vibrateNewOrder();
      playGhostSound();
      // Show accept modal
      showAvailableOrderModal(order);
      // Browser notification
      notifyDriverDevice('🚨 ¡Pedido disponible!', order && order.code ? order.code + ' - ' + (order.dropoff_address || '¡Acepta rapido!') : '¡Hay un nuevo pedido!');
    });

    // Another driver took the order
    socket.on('order:taken', function (data) {
      // Remove from queue and dismiss modal if showing this order
      dismissAvailableOrderIfShowing(data.order_id);
      if (data.driver_name) {
        showToast(data.driver_name + ' tomo el pedido ' + (data.code || ''), 'info');
      }
    });

    // Cliente confirmo/envio su ubicacion
    socket.on('order:address', function (data) {
      showToast('📍 Cliente envio su ubicacion: ' + (data.dropoff_address || 'GPS'), 'success');
      if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
      // Recargar pedidos para ver la nueva direccion y recalcular ruta
      lastOrdersJSON = '';
      loadOrders();
    });

    socket.on('chat:message', function (msg) {
      dchatMessages.push(msg);
      renderDriverChat();
      if (msg.sender_role === 'admin') {
        if (window.ghostAlert) window.ghostAlert({ title: '💬 Mensaje de Central Ghost', body: msg.body || '' });
        notifyDriverDevice('💬 Central Ghost dice:', msg.body || 'Tienes un nuevo mensaje');
        var chatPanel = document.getElementById('panel-chat');
        if (chatPanel && chatPanel.classList.contains('hidden')) {
          var badge = document.getElementById('chat-badge');
          if (badge) {
            var count = parseInt(badge.textContent || '0') + 1;
            badge.textContent = count;
            badge.classList.add('show');
          }
        }
      }
    });

    // Orden actualizada (push en vez de polling)
    socket.on('order:status', function () {
      lastOrdersJSON = '';
      loadOrders();
      loadEarnings();
    });

    socket.on('notification', function (data) {
      var title = '👻 Servicios Ghost';
      var body = '';
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

    socket.on('disconnect', function () {
      console.log('Socket desconectado');
    });
  }


  // ─── Competitive Order Acceptance (modal + accept logic) ──────────────────

  var availableOrdersQueue = [];
  var currentAvailableOrder = null;
  var acceptingOrderId = null;

  function showAvailableOrderModal(order) {
    if (!order) return;
    availableOrdersQueue.push(order);
    // If no modal is showing, show this one
    if (!currentAvailableOrder) {
      displayNextAvailableOrder();
    }
  }

  function displayNextAvailableOrder() {
    if (availableOrdersQueue.length === 0) {
      currentAvailableOrder = null;
      var modal = document.getElementById('modal-available-order');
      if (modal) modal.classList.add('hidden');
      return;
    }
    currentAvailableOrder = availableOrdersQueue.shift();
    var modal = document.getElementById('modal-available-order');
    if (!modal) {
      // Create modal dynamically if not in HTML
      createAvailableOrderModal();
      modal = document.getElementById('modal-available-order');
    }

    document.getElementById('avail-order-code').textContent = currentAvailableOrder.code || '';
    document.getElementById('avail-order-customer').textContent = currentAvailableOrder.customer_name || '';
    document.getElementById('avail-order-pickup').textContent = currentAvailableOrder.pickup_address || '-';
    document.getElementById('avail-order-dropoff').textContent = currentAvailableOrder.dropoff_address || '-';
    document.getElementById('avail-order-items').textContent = currentAvailableOrder.items || '-';
    document.getElementById('avail-order-amount').textContent = currentAvailableOrder.amount ? ('$' + Number(currentAvailableOrder.amount).toLocaleString()) : '-';

    var btnAccept = document.getElementById('btn-accept-available');
    if (btnAccept) {
      btnAccept.disabled = false;
      btnAccept.textContent = '👻 ACEPTAR PEDIDO';
    }

    modal.classList.remove('hidden');

    // Auto-dismiss after 60 seconds
    if (modal._autoTimer) clearTimeout(modal._autoTimer);
    modal._autoTimer = setTimeout(function () {
      dismissAvailableOrderIfShowing(currentAvailableOrder && currentAvailableOrder.id);
      displayNextAvailableOrder();
    }, 60000);
  }

  function dismissAvailableOrderIfShowing(orderId) {
    // Remove from queue
    availableOrdersQueue = availableOrdersQueue.filter(function (o) { return o.id !== orderId; });
    // If currently showing this order, dismiss
    if (currentAvailableOrder && currentAvailableOrder.id === orderId) {
      currentAvailableOrder = null;
      var modal = document.getElementById('modal-available-order');
      if (modal) {
        if (modal._autoTimer) clearTimeout(modal._autoTimer);
        modal.classList.add('hidden');
      }
      // Show next if any
      setTimeout(displayNextAvailableOrder, 300);
    }
  }

  async function acceptAvailableOrder() {
    if (!currentAvailableOrder) return;
    var orderId = currentAvailableOrder.id;
    if (acceptingOrderId === orderId) return;
    acceptingOrderId = orderId;

    var btnAccept = document.getElementById('btn-accept-available');
    if (btnAccept) {
      btnAccept.disabled = true;
      btnAccept.textContent = 'Aceptando...';
    }

    try {
      var res = await apiFetch('/api/orders/' + orderId + '/accept', { method: 'POST' });
      if (res.ok) {
        showToast('👻 ¡Pedido aceptado! Es tuyo.', 'success');
        vibrateNewOrder();
        dismissAvailableOrderIfShowing(orderId);
        displayNextAvailableOrder();
        lastOrdersJSON = '';
        loadOrders();
        loadEarnings();
      } else {
        var err = await res.json();
        if (res.status === 409) {
          showToast('Otro repartidor ya tomo este pedido', 'warning');
          dismissAvailableOrderIfShowing(orderId);
          displayNextAvailableOrder();
        } else {
          showToast(err.error || 'Error al aceptar', 'error');
          if (btnAccept) { btnAccept.disabled = false; btnAccept.textContent = '👻 ACEPTAR PEDIDO'; }
        }
      }
    } catch (e) {
      showToast('Error de conexion', 'error');
      if (btnAccept) { btnAccept.disabled = false; btnAccept.textContent = '👻 ACEPTAR PEDIDO'; }
    } finally {
      acceptingOrderId = null;
    }
  }

  function createAvailableOrderModal() {
    var overlay = document.createElement('div');
    overlay.id = 'modal-available-order';
    overlay.className = 'avail-modal-overlay hidden';
    overlay.innerHTML = '<div class="avail-modal">' +
      '<div class="avail-modal-header"><span class="avail-pulse"></span><h3>🚨 Nuevo Pedido Disponible!</h3></div>' +
      '<div class="avail-modal-body">' +
        '<div class="avail-code" id="avail-order-code">ORD-XXXX</div>' +
        '<div class="avail-details">' +
          '<div class="avail-row"><span>Cliente:</span><span id="avail-order-customer">--</span></div>' +
          '<div class="avail-row"><span>Recoger:</span><span id="avail-order-pickup">--</span></div>' +
          '<div class="avail-row"><span>Entregar:</span><span id="avail-order-dropoff">--</span></div>' +
          '<div class="avail-row"><span>Articulos:</span><span id="avail-order-items">--</span></div>' +
          '<div class="avail-row"><span>Valor:</span><span id="avail-order-amount" style="color:#10b981;font-weight:700;">--</span></div>' +
        '</div>' +
      '</div>' +
      '<div class="avail-modal-actions">' +
        '<button id="btn-accept-available" class="avail-btn-accept">👻 ACEPTAR PEDIDO</button>' +
        '<button id="btn-ignore-available" class="avail-btn-ignore">Ignorar</button>' +
      '</div>' +
      '<div style="text-align:center;font-size:0.7rem;color:#9ca3af;padding:0.5rem;">Se oculta en 60 segundos</div>' +
    '</div>';
    document.body.appendChild(overlay);

    // Add styles
    var style = document.createElement('style');
    style.textContent = '.avail-modal-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.8);display:flex;align-items:center;justify-content:center;z-index:99999;padding:1rem;animation:avFadeIn .2s ease}' +
      '.avail-modal-overlay.hidden{display:none}' +
      '@keyframes avFadeIn{from{opacity:0}to{opacity:1}}' +
      '.avail-modal{background:#1a1d27;border-radius:16px;width:100%;max-width:380px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.5);animation:avSlideUp .3s ease;border:1px solid rgba(16,185,129,0.4)}' +
      '@keyframes avSlideUp{from{transform:translateY(30px);opacity:0}to{transform:translateY(0);opacity:1}}' +
      '.avail-modal-header{background:linear-gradient(135deg,#10b981,#059669);padding:1rem 1.2rem;display:flex;align-items:center;gap:0.7rem}' +
      '.avail-modal-header h3{margin:0;color:#fff;font-size:1.05rem;font-weight:700}' +
      '.avail-pulse{width:12px;height:12px;border-radius:50%;background:#fff;animation:avPulse 1.5s infinite;flex-shrink:0}' +
      '@keyframes avPulse{0%{box-shadow:0 0 0 0 rgba(255,255,255,0.7)}70%{box-shadow:0 0 0 10px rgba(255,255,255,0)}100%{box-shadow:0 0 0 0 rgba(255,255,255,0)}}' +
      '.avail-modal-body{padding:1.2rem}' +
      '.avail-code{font-size:1.3rem;font-weight:800;color:#3b82f6;text-align:center;margin-bottom:1rem;letter-spacing:1px}' +
      '.avail-details{display:flex;flex-direction:column;gap:0.5rem}' +
      '.avail-row{display:flex;justify-content:space-between;gap:0.5rem;font-size:0.85rem}' +
      '.avail-row span:first-child{color:#9ca3af;flex-shrink:0}' +
      '.avail-row span:last-child{text-align:right;word-break:break-word;color:#e5e7eb}' +
      '.avail-modal-actions{padding:0 1.2rem 1rem;display:flex;flex-direction:column;gap:0.5rem}' +
      '.avail-btn-accept{width:100%;padding:0.9rem;font-size:1.05rem;font-weight:700;background:linear-gradient(135deg,#10b981,#059669);color:#fff;border:none;border-radius:10px;cursor:pointer;letter-spacing:0.5px}' +
      '.avail-btn-accept:disabled{opacity:0.5;cursor:not-allowed}' +
      '.avail-btn-ignore{width:100%;padding:0.6rem;font-size:0.85rem;background:transparent;color:#9ca3af;border:1px solid #374151;border-radius:10px;cursor:pointer}';
    document.head.appendChild(style);

    // Bind events
    document.getElementById('btn-accept-available').addEventListener('click', acceptAvailableOrder);
    document.getElementById('btn-ignore-available').addEventListener('click', function () {
      showToast('Pedido ignorado', 'info');
      dismissAvailableOrderIfShowing(currentAvailableOrder && currentAvailableOrder.id);
      displayNextAvailableOrder();
    });
  }

  // ─── Auto Refresh (cada 30s como fallback — Socket.IO es la fuente principal) ──

  var syncDot = null;
  setInterval(async function () {
    if (currentUser) {
      syncDot = syncDot || document.getElementById('sync-dot');
      try {
        await loadOrders();
        await loadEarnings();
        if (syncDot) syncDot.style.background = '#22c55e';
      } catch (e) {
        if (syncDot) syncDot.style.background = '#ef4444';
      }
    }
  }, 30000);


  // ═══════════════════════════════════════════════════════════════════════════════
  // FEATURE 6: PERSISTENT ACTIVE ORDER BAR
  // A fixed bar below the header showing current active order code + status + dest
  // ═══════════════════════════════════════════════════════════════════════════════
  function initActiveOrderBar() {
    if (document.getElementById('active-order-bar')) return;
    var bar = document.createElement('div');
    bar.id = 'active-order-bar';
    bar.style.cssText = 'display:none;padding:0.4rem 0.8rem;background:var(--panel);border-bottom:1px solid var(--border);font-size:0.78rem;font-weight:600;color:var(--gold);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0;';
    // Insert after the header
    var header = document.querySelector('.drv-header');
    if (header && header.nextSibling) {
      header.parentNode.insertBefore(bar, header.nextSibling);
    }
  }

  function updateActiveOrderBar() {
    var bar = document.getElementById('active-order-bar');
    if (!bar) return;
    var active = orders.find(function (o) { return ['assigned', 'picked_up', 'on_the_way'].includes(o.status); });
    if (!active) {
      bar.style.display = 'none';
      return;
    }
    var dest = active.status === 'assigned' ? (active.pickup_address || 'Recogida') : (active.dropoff_address || 'Entrega');
    bar.textContent = '📦 ' + (active.code || '') + ' · ' + statusLabelText(active.status) + ' → ' + dest;
    bar.style.display = 'block';
  }


  // ═══════════════════════════════════════════════════════════════════════════════
  // FEATURE 7: SOS BUTTON (init)
  // Red circular button fixed at bottom-right of map, sends driver:sos event
  // ═══════════════════════════════════════════════════════════════════════════════
  function initSOSButton() {
    if (document.getElementById('sos-btn')) return;
    var mapSection = document.querySelector('.drv-map-section');
    if (!mapSection) return;
    var btn = document.createElement('button');
    btn.id = 'sos-btn';
    btn.textContent = 'SOS';
    btn.style.cssText = 'position:absolute;bottom:80px;right:12px;z-index:900;width:50px;height:50px;border-radius:50%;background:#ef4444;color:#fff;font-weight:900;font-size:0.8rem;border:3px solid #fff;cursor:pointer;box-shadow:0 4px 12px rgba(239,68,68,0.5);';
    btn.addEventListener('click', triggerSOS);
    mapSection.appendChild(btn);
  }


  // ═══════════════════════════════════════════════════════════════════════════════
  // FEATURE 8: BATTERY LOW INDICATOR
  // Use navigator.getBattery() to show warning when <20%
  // ═══════════════════════════════════════════════════════════════════════════════
  function initBatteryMonitor() {
    if (!navigator.getBattery) return;
    var warningEl = null;

    function ensureWarningEl() {
      if (warningEl) return warningEl;
      warningEl = document.createElement('div');
      warningEl.id = 'battery-warning';
      warningEl.style.cssText = 'display:none;padding:0.3rem 0.8rem;background:#fbbf24;color:#000;font-size:0.72rem;font-weight:600;text-align:center;flex-shrink:0;';
      var stats = document.querySelector('.drv-stats');
      if (stats && stats.nextSibling) {
        stats.parentNode.insertBefore(warningEl, stats.nextSibling);
      } else if (stats) {
        stats.parentNode.appendChild(warningEl);
      }
      return warningEl;
    }

    function checkBattery(battery) {
      var el = ensureWarningEl();
      var level = Math.round(battery.level * 100);
      if (level < 20 && !battery.charging) {
        el.textContent = '⚡ Bateria baja: ' + level + '%';
        el.style.display = 'block';
      } else {
        el.style.display = 'none';
      }
    }

    navigator.getBattery().then(function (battery) {
      checkBattery(battery);
      battery.addEventListener('levelchange', function () { checkBattery(battery); });
      battery.addEventListener('chargingchange', function () { checkBattery(battery); });
      // Also check every 60s
      setInterval(function () { checkBattery(battery); }, 60000);
    }).catch(function () {});
  }


  // ═══════════════════════════════════════════════════════════════════════════════
  // FEATURE 4: WEEKLY HISTORY TAB ("📊 Mi Semana")
  // Third tab showing total earnings, deliveries, avg delivery time for the week
  // ═══════════════════════════════════════════════════════════════════════════════
  function initWeeklyTab() {
    // Add a third tab button
    var tabsContainer = document.querySelector('.drv-tabs');
    if (!tabsContainer || document.getElementById('tab-weekly')) return;

    var weekTab = document.createElement('button');
    weekTab.className = 'drv-tab';
    weekTab.id = 'tab-weekly';
    weekTab.setAttribute('data-panel', 'panel-weekly');
    weekTab.textContent = '📊 Mi Semana';
    tabsContainer.appendChild(weekTab);

    // Create the panel
    var bottom = document.querySelector('.drv-bottom');
    if (!bottom) return;
    var panel = document.createElement('div');
    panel.id = 'panel-weekly';
    panel.className = 'drv-panel hidden';
    panel.innerHTML = '<div id="weekly-stats" style="padding:0.5rem;"><p style="color:var(--text-muted);text-align:center;">Cargando datos de la semana...</p></div>';
    bottom.appendChild(panel);

    // Bind tab click (same logic as other tabs in driver.html)
    weekTab.addEventListener('click', function () {
      document.querySelectorAll('.drv-tab').forEach(function (t) { t.classList.remove('active'); });
      weekTab.classList.add('active');
      document.querySelectorAll('.drv-panel').forEach(function (p) { p.classList.add('hidden'); });
      panel.classList.remove('hidden');
      loadWeeklyStats();
    });
  }

  async function loadWeeklyStats() {
    var container = document.getElementById('weekly-stats');
    if (!container || !currentUser) return;

    // Calculate Monday of this week
    var now = new Date();
    var day = now.getDay(); // 0=Sun
    var diffToMon = (day === 0 ? 6 : day - 1);
    var monday = new Date(now);
    monday.setDate(now.getDate() - diffToMon);
    var fromStr = monday.toISOString().slice(0, 10);
    var toStr = now.toISOString().slice(0, 10);

    try {
      var res = await fetch('/api/reports/my-earnings?from=' + fromStr + '&to=' + toStr, { headers: apiHeaders() });
      if (!res.ok) { container.innerHTML = '<p style="color:var(--text-muted);text-align:center;">Error cargando datos</p>'; return; }
      var data = await res.json();

      var earning = Number(data.earning || 0).toLocaleString();
      var deliveries = data.deliveries || 0;
      var avgTime = data.avg_delivery_minutes ? Math.round(data.avg_delivery_minutes) + ' min' : 'N/A';

      container.innerHTML =
        '<div style="display:flex;gap:0.8rem;flex-wrap:wrap;justify-content:center;padding:1rem 0;">' +
          '<div style="text-align:center;flex:1;min-width:100px;padding:1rem;background:var(--bg-alt);border-radius:12px;border:1px solid var(--border);">' +
            '<div style="font-size:1.4rem;font-weight:700;color:var(--gold);">$' + earning + '</div>' +
            '<div style="font-size:0.7rem;color:var(--text-muted);margin-top:0.3rem;">GANANCIA SEMANAL</div>' +
          '</div>' +
          '<div style="text-align:center;flex:1;min-width:100px;padding:1rem;background:var(--bg-alt);border-radius:12px;border:1px solid var(--border);">' +
            '<div style="font-size:1.4rem;font-weight:700;color:var(--success);">' + deliveries + '</div>' +
            '<div style="font-size:0.7rem;color:var(--text-muted);margin-top:0.3rem;">ENTREGAS</div>' +
          '</div>' +
          '<div style="text-align:center;flex:1;min-width:100px;padding:1rem;background:var(--bg-alt);border-radius:12px;border:1px solid var(--border);">' +
            '<div style="font-size:1.4rem;font-weight:700;color:var(--primary);">' + avgTime + '</div>' +
            '<div style="font-size:0.7rem;color:var(--text-muted);margin-top:0.3rem;">PROMEDIO ENTREGA</div>' +
          '</div>' +
        '</div>';
    } catch (e) {
      container.innerHTML = '<p style="color:var(--text-muted);text-align:center;">Error de conexion</p>';
    }
  }


  // ═══════════════════════════════════════════════════════════════════════════════
  // FEATURE 13: END-OF-DAY SUMMARY
  // At 9PM (21:00) show a modal with today's stats if not already shown today
  // ═══════════════════════════════════════════════════════════════════════════════
  function scheduleEndOfDaySummary() {
    // Check every 60 seconds if it's 21:xx and hasn't shown yet today
    setInterval(function () {
      var now = new Date();
      if (now.getHours() !== 21) return;
      var dateKey = 'eod_shown_' + now.toISOString().slice(0, 10);
      if (localStorage.getItem(dateKey)) return;

      // Show the end-of-day modal
      localStorage.setItem(dateKey, 'true');
      showEndOfDaySummary();
    }, 60000);
  }

  async function showEndOfDaySummary() {
    var today = new Date().toISOString().slice(0, 10);
    var earning = '0';
    var deliveries = 0;
    var hoursOnline = 'N/A';

    try {
      var res = await fetch('/api/reports/my-earnings?from=' + today + '&to=' + today, { headers: apiHeaders() });
      if (res.ok) {
        var data = await res.json();
        earning = Number(data.earning || 0).toLocaleString();
        deliveries = data.deliveries || 0;
        hoursOnline = data.hours_online ? data.hours_online.toFixed(1) + 'h' : 'N/A';
      }
    } catch (e) {}

    // Create modal overlay
    var overlay = document.createElement('div');
    overlay.id = 'eod-modal';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.7);backdrop-filter:blur(4px);';
    overlay.innerHTML =
      '<div style="background:var(--panel);border:1px solid var(--border);border-radius:16px;padding:1.5rem;max-width:320px;width:90%;text-align:center;">' +
        '<h3 style="margin:0 0 0.8rem;color:var(--gold);">🌙 Resumen del Dia</h3>' +
        '<div style="display:flex;gap:0.6rem;margin-bottom:1rem;">' +
          '<div style="flex:1;padding:0.8rem;background:var(--bg-alt);border-radius:10px;"><div style="font-size:1.2rem;font-weight:700;color:var(--gold);">$' + earning + '</div><div style="font-size:0.65rem;color:var(--text-muted);">Ganancias</div></div>' +
          '<div style="flex:1;padding:0.8rem;background:var(--bg-alt);border-radius:10px;"><div style="font-size:1.2rem;font-weight:700;color:var(--success);">' + deliveries + '</div><div style="font-size:0.65rem;color:var(--text-muted);">Entregas</div></div>' +
          '<div style="flex:1;padding:0.8rem;background:var(--bg-alt);border-radius:10px;"><div style="font-size:1.2rem;font-weight:700;color:var(--primary);">' + hoursOnline + '</div><div style="font-size:0.65rem;color:var(--text-muted);">En linea</div></div>' +
        '</div>' +
        '<button id="eod-close" style="padding:0.6rem 1.5rem;border:none;border-radius:10px;background:var(--gold);color:#000;font-weight:700;font-size:0.9rem;cursor:pointer;">Cerrar</button>' +
      '</div>';
    document.body.appendChild(overlay);
    document.getElementById('eod-close').addEventListener('click', function () { overlay.remove(); });
  }


  // ═══════════════════════════════════════════════════════════════════════════════
  // FEATURE 14: FIRST-USE TUTORIAL
  // On first login show an overlay with 3 slides
  // ═══════════════════════════════════════════════════════════════════════════════
  function showTutorialIfNeeded() {
    if (localStorage.getItem('tutorial_done') === 'true') return;

    var slides = [
      { emoji: '📍', text: 'Activa tu GPS para que la central sepa donde estas en todo momento.' },
      { emoji: '👆', text: 'Desliza a la derecha sobre un pedido para cambiar su estado rapidamente.' },
      { emoji: '💬', text: 'Usa el Chat para comunicarte directamente con la central de despacho.' }
    ];
    var currentSlide = 0;

    var overlay = document.createElement('div');
    overlay.id = 'tutorial-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.85);backdrop-filter:blur(6px);';

    function renderSlide() {
      var s = slides[currentSlide];
      var isLast = currentSlide === slides.length - 1;
      overlay.innerHTML =
        '<div style="background:var(--panel);border:1px solid var(--border);border-radius:20px;padding:2rem 1.5rem;max-width:300px;width:85%;text-align:center;">' +
          '<div style="font-size:3rem;margin-bottom:0.8rem;">' + s.emoji + '</div>' +
          '<p style="color:var(--text);font-size:0.9rem;margin:0 0 1.5rem;line-height:1.4;">' + s.text + '</p>' +
          '<div style="display:flex;gap:0.6rem;justify-content:center;">' +
            '<button id="tut-skip" style="padding:0.5rem 1rem;border:1px solid var(--border);border-radius:10px;background:transparent;color:var(--text-muted);font-size:0.8rem;cursor:pointer;">Saltar</button>' +
            '<button id="tut-next" style="padding:0.5rem 1.2rem;border:none;border-radius:10px;background:var(--gold);color:#000;font-weight:700;font-size:0.8rem;cursor:pointer;">' + (isLast ? 'Empezar' : 'Siguiente →') + '</button>' +
          '</div>' +
          '<div style="margin-top:1rem;display:flex;gap:0.3rem;justify-content:center;">' +
            slides.map(function (_, i) {
              return '<span style="width:8px;height:8px;border-radius:50%;background:' + (i === currentSlide ? 'var(--gold)' : 'var(--border)') + ';"></span>';
            }).join('') +
          '</div>' +
        '</div>';

      document.getElementById('tut-skip').addEventListener('click', closeTutorial);
      document.getElementById('tut-next').addEventListener('click', function () {
        if (currentSlide < slides.length - 1) {
          currentSlide++;
          renderSlide();
        } else {
          closeTutorial();
        }
      });
    }

    function closeTutorial() {
      localStorage.setItem('tutorial_done', 'true');
      overlay.remove();
    }

    renderSlide();
    document.body.appendChild(overlay);
  }


  // ═══════════════════════════════════════════════════════════════════════════════
  // FEATURE 11: URGENT ORDER PULSING RED (CSS injection)
  // Inject CSS keyframes for order-urgent class
  // ═══════════════════════════════════════════════════════════════════════════════
  (function injectUrgentCSS() {
    var style = document.createElement('style');
    style.textContent =
      '@keyframes urgent-pulse { 0%,100% { background: transparent; } 50% { background: rgba(239,68,68,0.15); } }' +
      '.order-urgent { animation: urgent-pulse 1.5s infinite !important; border-left-color: #ef4444 !important; }';
    document.head.appendChild(style);
  })();

  // ─── Init ──────────────────────────────────────────────────────────────────

  checkAuth();
})();
