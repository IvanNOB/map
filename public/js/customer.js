/* ─── Customer Tracking Page JavaScript ───────────────────────────────────── */

(function () {
  'use strict';

  // ─── State ──────────────────────────────────────────────────────────────────
  let map = null;
  let driverMarker = null;
  let routePolyline = null;
  let routePoints = [];
  let socket = null;
  let currentOrder = null;
  let dropoffLat = null;
  let dropoffLng = null;
  let pickupMarker = null;
  let dropoffMarker = null;
  let currentCode = null;

  // Theme
  (function () {
    var t = localStorage.getItem('theme') || 'dark';
    document.documentElement.setAttribute('data-theme', t);
  })();

  function pinIcon(kind, emoji) {
    return L.divIcon({
      className: '',
      html: '<div class="pin pin-' + kind + '"><span>' + emoji + '</span></div>',
      iconSize: [28, 28],
      iconAnchor: [14, kind === 'driver' ? 14 : 28],
      popupAnchor: [0, kind === 'driver' ? -14 : -28],
    });
  }

  // ─── DOM References ─────────────────────────────────────────────────────────
  const searchForm = document.getElementById('search-form');
  const orderCodeInput = document.getElementById('order-code-input');
  const trackingResults = document.getElementById('tracking-results');
  const trackingError = document.getElementById('tracking-error');
  const toastContainer = document.getElementById('toast-container');

  const trackCode = document.getElementById('track-code');
  const trackStatusBadge = document.getElementById('track-status-badge');
  const trackCustomer = document.getElementById('track-customer');
  const trackPickup = document.getElementById('track-pickup');
  const trackDropoff = document.getElementById('track-dropoff');
  const trackDriver = document.getElementById('track-driver');
  const trackVehicle = document.getElementById('track-vehicle');
  const trackDistance = document.getElementById('track-distance');
  const trackTime = document.getElementById('track-time');
  const trackEta = document.getElementById('track-eta');
  const trackEtaContainer = document.getElementById('track-eta-container');

  // ─── Helpers ────────────────────────────────────────────────────────────────

  function showToast(message, type) {
    type = type || 'info';
    var toast = document.createElement('div');
    toast.className = 'toast ' + type;
    toast.textContent = message;
    toastContainer.appendChild(toast);
    setTimeout(function () { toast.remove(); }, 4000);
  }

  function statusLabel(status) {
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

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Haversine formula: returns distance in km
  function haversineKm(lat1, lng1, lat2, lng2) {
    var R = 6371;
    var dLat = (lat2 - lat1) * Math.PI / 180;
    var dLng = (lng2 - lng1) * Math.PI / 180;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  function calculateEta(driverLat, driverLng) {
    if (dropoffLat == null || dropoffLng == null) return null;
    var dist = haversineKm(driverLat, driverLng, dropoffLat, dropoffLng);
    var avgSpeed = 25; // km/h
    return Math.round((dist / avgSpeed) * 60);
  }

  // ─── Map ────────────────────────────────────────────────────────────────────

  function initMap() {
    if (map) return;
    map = L.map('tracking-map').setView([4.6097, -74.0817], 13);
    var streets = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap', maxZoom: 19,
    });
    var satellite = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { attribution: 'Tiles &copy; Esri', maxZoom: 19 }
    );
    satellite.addTo(map);
    L.control.layers({ 'Satelital': satellite, 'Calles': streets }, null, { position: 'topright' }).addTo(map);

    // Legend
    var legend = L.control({ position: 'bottomleft' });
    legend.onAdd = function () {
      var div = L.DomUtil.create('div', 'map-legend');
      div.innerHTML =
        '<div class="lg-row"><span class="lg-dot lg-pickup"></span> Recogida</div>' +
        '<div class="lg-row"><span class="lg-dot lg-dropoff"></span> Entrega</div>' +
        '<div class="lg-row"><span class="lg-dot lg-driver"></span> Repartidor</div>';
      return div;
    };
    legend.addTo(map);
  }

  function setStaticMarkers(order) {
    if (!map) return;
    var pts = [];
    if (order.pickup_lat && order.pickup_lng) {
      if (!pickupMarker) {
        pickupMarker = L.marker([order.pickup_lat, order.pickup_lng], { icon: pinIcon('pickup', '🟢') })
          .bindPopup('🟢 Recogida<br>' + escapeHtml(order.pickup_address || '')).addTo(map);
      }
      pts.push([order.pickup_lat, order.pickup_lng]);
    }
    if (order.dropoff_lat && order.dropoff_lng) {
      if (!dropoffMarker) {
        dropoffMarker = L.marker([order.dropoff_lat, order.dropoff_lng], { icon: pinIcon('dropoff', '🔴') })
          .bindPopup('🔴 Entrega<br>' + escapeHtml(order.dropoff_address || '')).addTo(map);
      }
      pts.push([order.dropoff_lat, order.dropoff_lng]);
    }
    if (pts.length) { try { map.fitBounds(pts, { padding: [40, 40], maxZoom: 15 }); } catch (e) {} }
  }

  function setDriverMarker(lat, lng, name) {
    if (!map) return;
    var latlng = [lat, lng];
    if (driverMarker) {
      driverMarker.setLatLng(latlng);
    } else {
      driverMarker = L.marker(latlng, { icon: pinIcon('driver', '🛵') }).addTo(map);
    }
    driverMarker.bindPopup('<strong>' + escapeHtml(name || 'Repartidor') + '</strong>');
  }

  function drawRoute(points) {
    if (!map || !points || points.length === 0) return;
    routePoints = points.map(function (p) { return [p.lat, p.lng]; });
    if (routePolyline) {
      routePolyline.setLatLngs(routePoints);
    } else {
      routePolyline = L.polyline(routePoints, {
        color: '#3b82f6',
        weight: 4,
        opacity: 0.7,
      }).addTo(map);
    }
    // Fit bounds to show entire route
    if (routePoints.length > 1) {
      map.fitBounds(routePolyline.getBounds(), { padding: [30, 30] });
    }
  }

  function appendRoutePoint(lat, lng) {
    if (!map) return;
    routePoints.push([lat, lng]);
    if (routePolyline) {
      routePolyline.addLatLng([lat, lng]);
    } else {
      routePolyline = L.polyline(routePoints, {
        color: '#3b82f6',
        weight: 4,
        opacity: 0.7,
      }).addTo(map);
    }
  }

  // ─── Display ────────────────────────────────────────────────────────────────

  function displayTrackingData(data) {
    var order = data.order;
    var driver = data.driver;

    // If switching to a different order, clear previous markers/route
    if (map && currentCode && currentCode !== order.code) {
      [pickupMarker, dropoffMarker, driverMarker, routePolyline].forEach(function (m) {
        if (m) map.removeLayer(m);
      });
      pickupMarker = dropoffMarker = driverMarker = routePolyline = null;
      routePoints = [];
    }

    currentOrder = order;
    dropoffLat = order.dropoff_lat || null;
    dropoffLng = order.dropoff_lng || null;

    trackCode.textContent = order.code;
    trackStatusBadge.textContent = statusLabel(order.status);
    trackStatusBadge.className = 'badge badge-' + order.status;
    trackCustomer.textContent = order.customer_name;
    trackPickup.textContent = order.pickup_address || '-';
    trackDropoff.textContent = order.dropoff_address || '-';

    if (driver) {
      trackDriver.textContent = driver.name || '-';
      var vehicleInfo = [];
      if (driver.vehicle) vehicleInfo.push(driver.vehicle);
      if (driver.plate) vehicleInfo.push('(' + driver.plate + ')');
      trackVehicle.textContent = vehicleInfo.length > 0 ? vehicleInfo.join(' ') : '-';
    } else {
      trackDriver.textContent = 'Sin asignar';
      trackVehicle.textContent = '-';
    }

    trackDistance.textContent = order.estimated_distance_km
      ? order.estimated_distance_km.toFixed(1) + ' km'
      : '-';
    trackTime.textContent = order.estimated_minutes
      ? Math.round(order.estimated_minutes) + ' min'
      : '-';

    // ETA
    if (data.eta_minutes != null) {
      trackEta.textContent = data.eta_minutes + ' min';
      trackEtaContainer.classList.remove('hidden');
    } else {
      trackEta.textContent = '--';
      trackEtaContainer.classList.remove('hidden');
    }

    // Show results, hide error
    trackingResults.classList.remove('hidden');
    trackingError.classList.add('hidden');

    // Init map and show driver marker
    initMap();
    currentCode = order.code;
    setStaticMarkers(order);
    if (driver && driver.lat != null && driver.lng != null) {
      setDriverMarker(driver.lat, driver.lng, driver.name);
    }

    // Draw route from history
    if (data.route && data.route.length > 0) {
      drawRoute(data.route);
    }

    // Timeline + Rating
    renderTimeline(order);
    handleRating(order);
  }

  // ─── Timeline ─────────────────────────────────────────────────────────────
  function fmt(ts) {
    if (!ts) return '';
    var d = new Date(ts.indexOf('T') === -1 ? ts.replace(' ', 'T') + 'Z' : ts);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('es', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  function renderTimeline(order) {
    var el = document.getElementById('timeline');
    if (!el) return;
    if (order.status === 'cancelled') {
      el.classList.remove('hidden');
      el.innerHTML = '<div class="tl-cancelled">Pedido cancelado</div>';
      return;
    }
    var steps = [
      { key: 'created', label: 'Pedido recibido', icon: '📝', at: order.created_at },
      { key: 'assigned', label: 'Repartidor asignado', icon: '🧑‍🦱', at: order.assigned_at },
      { key: 'picked_up', label: 'Pedido recogido', icon: '📦', at: order.picked_up_at },
      { key: 'on_the_way', label: 'En camino', icon: '🛵', at: order.on_the_way_at },
      { key: 'delivered', label: 'Entregado', icon: '✅', at: order.delivered_at },
    ];
    var order_idx = ['pending', 'assigned', 'picked_up', 'on_the_way', 'delivered'];
    var current = order_idx.indexOf(order.status);
    if (order.status === 'pending') current = 0;

    var html = '';
    steps.forEach(function (s, i) {
      var done = i <= current;
      var active = i === current;
      html += '<div class="tl-step ' + (done ? 'done' : '') + (active ? ' active' : '') + '">' +
        '<div class="tl-dot">' + s.icon + '</div>' +
        '<div class="tl-body"><div class="tl-label">' + s.label + '</div>' +
        (s.at ? '<div class="tl-time">' + fmt(s.at) + '</div>' : '') + '</div></div>';
    });
    el.innerHTML = html;
    el.classList.remove('hidden');
  }

  // ─── Rating ─────────────────────────────────────────────────────────────────
  let selectedRating = 0;

  function handleRating(order) {
    var box = document.getElementById('rating-box');
    var starsWrap = document.getElementById('rating-stars');
    var thanks = document.getElementById('rating-thanks');
    var comment = document.getElementById('rating-comment');
    var sendBtn = document.getElementById('btn-send-rating');
    var proofBtn = document.getElementById('btn-view-proof');
    if (!box) return;

    if (order.status !== 'delivered') {
      box.classList.add('hidden');
      return;
    }
    box.classList.remove('hidden');
    var stars = starsWrap.querySelectorAll('.star');

    function paint(v) {
      stars.forEach(function (s) { s.classList.toggle('on', parseInt(s.dataset.v) <= v); });
    }

    // Proof of delivery button
    if (order.has_proof && proofBtn) {
      proofBtn.classList.remove('hidden');
      proofBtn.onclick = async function () {
        try {
          var res = await fetch('/api/track/' + encodeURIComponent(currentCode) + '/proof');
          if (res.ok) {
            var d = await res.json();
            var img = document.getElementById('cust-proof-img');
            img.src = d.image; img.style.display = 'block';
          }
        } catch (e) {}
      };
    } else if (proofBtn) {
      proofBtn.classList.add('hidden');
    }

    // Already rated
    if (order.rating) {
      paint(order.rating);
      if (comment) { comment.value = order.review || ''; comment.disabled = true; }
      if (sendBtn) sendBtn.style.display = 'none';
      thanks.classList.remove('hidden');
      starsWrap.style.pointerEvents = 'none';
      return;
    }

    thanks.classList.add('hidden');
    if (sendBtn) sendBtn.style.display = '';
    if (comment) comment.disabled = false;
    starsWrap.style.pointerEvents = 'auto';
    selectedRating = 0;
    stars.forEach(function (s) {
      s.onmouseenter = function () { paint(parseInt(s.dataset.v)); };
      s.onclick = function () { selectedRating = parseInt(s.dataset.v); paint(selectedRating); };
    });
    starsWrap.onmouseleave = function () { paint(selectedRating); };
    if (sendBtn) sendBtn.onclick = function () { submitRating(selectedRating); };
  }

  async function submitRating(value) {
    if (!currentCode) return;
    if (!value || value < 1) { showToast('Selecciona una calificacion', 'warning'); return; }
    var comment = document.getElementById('rating-comment');
    try {
      var res = await fetch('/api/track/' + encodeURIComponent(currentCode) + '/rating', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating: value, comment: comment ? comment.value : '' }),
      });
      if (res.ok) {
        document.getElementById('btn-send-rating').style.display = 'none';
        document.getElementById('rating-stars').style.pointerEvents = 'none';
        if (comment) comment.disabled = true;
        document.getElementById('rating-thanks').classList.remove('hidden');
        showToast('Gracias por tu calificacion', 'success');
      } else {
        showToast('No se pudo enviar la calificacion', 'error');
      }
    } catch (e) {
      showToast('Error de conexion', 'error');
    }
  }

  // ─── Fetch Tracking ─────────────────────────────────────────────────────────

  async function fetchTracking(code) {
    try {
      var res = await fetch('/api/track/' + encodeURIComponent(code));
      if (res.ok) {
        var data = await res.json();
        displayTrackingData(data);
        connectSocket(code);
      } else if (res.status === 404) {
        trackingResults.classList.add('hidden');
        trackingError.classList.remove('hidden');
      } else {
        showToast('Error al buscar el pedido', 'error');
      }
    } catch (err) {
      showToast('Error de conexion', 'error');
    }
  }

  // ─── Socket.IO ──────────────────────────────────────────────────────────────

  function connectSocket(code) {
    if (socket) {
      socket.disconnect();
    }
    socket = io({ query: { order_code: code } });

    socket.on('connect', function () {
      console.log('Socket conectado (seguimiento)');
    });

    socket.on('driver:location', function (data) {
      if (data.lat != null && data.lng != null) {
        setDriverMarker(data.lat, data.lng, data.name);
        appendRoutePoint(data.lat, data.lng);

        // Recalculate ETA
        var eta = calculateEta(data.lat, data.lng);
        if (eta != null) {
          trackEta.textContent = eta + ' min';
        }
      }
    });

    socket.on('order:status', function (data) {
      if (data.status) {
        trackStatusBadge.textContent = statusLabel(data.status);
        trackStatusBadge.className = 'badge badge-' + data.status;
        showToast('Estado actualizado: ' + statusLabel(data.status), 'info');

        if (currentOrder) {
          currentOrder.status = data.status;
          var now = new Date().toISOString();
          if (data.status === 'assigned' && !currentOrder.assigned_at) currentOrder.assigned_at = now;
          if (data.status === 'picked_up') currentOrder.picked_up_at = now;
          if (data.status === 'on_the_way') currentOrder.on_the_way_at = now;
          if (data.status === 'delivered') currentOrder.delivered_at = now;
          renderTimeline(currentOrder);
          handleRating(currentOrder);
        }
        if (data.status === 'delivered') trackEta.textContent = 'Entregado';
      }
    });

    socket.on('disconnect', function () {
      console.log('Socket desconectado');
    });
  }

  // ─── Form Handler ──────────────────────────────────────────────────────────

  searchForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var code = orderCodeInput.value.trim();
    if (!code) return;
    fetchTracking(code);
  });

  // ─── Auto-search from URL param ────────────────────────────────────────────

  function init() {
    var params = new URLSearchParams(window.location.search);
    var code = params.get('code');
    if (code) {
      orderCodeInput.value = code;
      fetchTracking(code);
    }
  }

  init();
})();
