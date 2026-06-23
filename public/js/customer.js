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
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);
  }

  function setDriverMarker(lat, lng, name) {
    if (!map) return;
    var latlng = [lat, lng];
    if (driverMarker) {
      driverMarker.setLatLng(latlng);
    } else {
      driverMarker = L.marker(latlng).addTo(map);
    }
    driverMarker.bindPopup('<strong>' + escapeHtml(name || 'Repartidor') + '</strong>');
    map.setView(latlng, 15);
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
    if (driver && driver.lat != null && driver.lng != null) {
      setDriverMarker(driver.lat, driver.lng, driver.name);
    }

    // Draw route from history
    if (data.route && data.route.length > 0) {
      drawRoute(data.route);
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

        if (data.status === 'delivered') {
          trackEta.textContent = 'Entregado';
        }
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
