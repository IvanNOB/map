/* dispatcher-enhancements.js — 10 mejoras para el panel admin */
(function() {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════════════
  // DATA INTERCEPTION — Cache orders and drivers from API responses
  // ═══════════════════════════════════════════════════════════════════════════
  var _orders = [];
  var _drivers = [];
  var _sosHistory = [];
  var _routeLayer = null;
  var _leafletMap = null;

  var originalFetch = window.fetch;
  window.fetch = function() {
    var args = arguments;
    var url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
    return originalFetch.apply(this, args).then(function(res) {
      try {
        if (url.indexOf('/api/orders') !== -1 &&
            url.indexOf('/proof') === -1 &&
            url.indexOf('/status') === -1 &&
            url.indexOf('/route') === -1 &&
            url.indexOf('/assign') === -1) {
          var clone = res.clone();
          clone.json().then(function(data) {
            _orders = data.orders || data || [];
            updateFilterCounters();
          }).catch(function() {});
        }
        if (url.indexOf('/api/drivers') !== -1 &&
            url.indexOf('/my-stats') === -1) {
          var clone2 = res.clone();
          clone2.json().then(function(data) {
            _drivers = data || [];
          }).catch(function() {});
        }
      } catch(e) {}
      return res;
    });
  };


  // ═══════════════════════════════════════════════════════════════════════════
  // HELPER: Find the Leaflet map instance from the DOM
  // ═══════════════════════════════════════════════════════════════════════════
  function getLeafletMap() {
    if (_leafletMap) return _leafletMap;
    try {
      var el = document.getElementById('map');
      if (!el) return null;
      var keys = Object.keys(el);
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        if (key.indexOf('_leaflet') === 0 || key.indexOf('leaflet') === 0) {
          var val = el[key];
          if (val && typeof val === 'object' && typeof val.getZoom === 'function') {
            _leafletMap = val;
            return _leafletMap;
          }
        }
      }
      // Fallback: check _leaflet_id and lookup via L internal maps
      if (typeof L !== 'undefined' && L.Map && L.Map._instances) {
        var instances = Object.values(L.Map._instances);
        if (instances.length > 0) {
          _leafletMap = instances[0];
          return _leafletMap;
        }
      }
    } catch(e) {}
    return null;
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // HELPER: Safe element query with retry
  // ═══════════════════════════════════════════════════════════════════════════
  function waitForElement(selector, callback, maxAttempts) {
    maxAttempts = maxAttempts || 20;
    var attempts = 0;
    var interval = setInterval(function() {
      var el = document.querySelector(selector);
      if (el) {
        clearInterval(interval);
        callback(el);
      } else if (++attempts >= maxAttempts) {
        clearInterval(interval);
      }
    }, 500);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FEATURE 1: FILTER COUNTERS
  // Update each .filter-btn text to include the count of orders by status
  // ═══════════════════════════════════════════════════════════════════════════
  var filterLabels = {
    '': 'Todos',
    'pending': 'Pendientes',
    'assigned': 'Asignados',
    'picked_up': 'Recogidos',
    'on_the_way': 'En Camino',
    'delivered': 'Entregados',
    'cancelled': 'Cancelados'
  };

  function updateFilterCounters() {
    try {
      var buttons = document.querySelectorAll('.filter-btn');
      if (!buttons.length || !_orders.length) return;
      var counts = {};
      for (var i = 0; i < _orders.length; i++) {
        var s = _orders[i].status || '';
        counts[s] = (counts[s] || 0) + 1;
      }
      for (var j = 0; j < buttons.length; j++) {
        var btn = buttons[j];
        var filter = btn.getAttribute('data-filter') || '';
        var label = filterLabels[filter] || filter;
        if (filter === '') {
          btn.textContent = label + ' (' + _orders.length + ')';
        } else {
          var count = counts[filter] || 0;
          btn.textContent = label + ' (' + count + ')';
        }
      }
    } catch(e) {}
  }


  // Also observe #orders-list for DOM updates to trigger counter refresh
  waitForElement('#orders-list', function(el) {
    var observer = new MutationObserver(function() {
      // Small delay to let _orders cache update from fetch
      setTimeout(updateFilterCounters, 300);
    });
    observer.observe(el, { childList: true, subtree: true });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // FEATURE 2: ROUTE LINES FROM DRIVERS TO DESTINATIONS
  // Every 10s, draw dashed polylines from online drivers to their order dest
  // ═══════════════════════════════════════════════════════════════════════════
  function drawRouteLines() {
    try {
      var map = getLeafletMap();
      if (!map || typeof L === 'undefined') return;

      // Create or clear the route layer
      if (!_routeLayer) {
        _routeLayer = L.layerGroup().addTo(map);
      } else {
        _routeLayer.clearLayers();
      }

      if (!_orders.length || !_drivers.length) return;

      // Build lookup: driver_id -> driver with location
      var driverMap = {};
      for (var i = 0; i < _drivers.length; i++) {
        var d = _drivers[i];
        if (d.lat && d.lng) {
          driverMap[d._id || d.id] = d;
        }
      }


      // For each active order with an assigned driver, draw a line
      for (var j = 0; j < _orders.length; j++) {
        var order = _orders[j];
        var driverId = order.driver_id || order.driverId;
        if (!driverId) continue;
        var driver = driverMap[driverId];
        if (!driver) continue;

        var destLat, destLng;
        // If picked_up or on_the_way, destination is dropoff
        if (order.status === 'picked_up' || order.status === 'on_the_way') {
          destLat = order.dropoff_lat || (order.dropoff && order.dropoff.lat);
          destLng = order.dropoff_lng || (order.dropoff && order.dropoff.lng);
        } else if (order.status === 'assigned') {
          // Destination is pickup
          destLat = order.pickup_lat || (order.pickup && order.pickup.lat);
          destLng = order.pickup_lng || (order.pickup && order.pickup.lng);
        } else {
          continue;
        }

        if (!destLat || !destLng) continue;

        var line = L.polyline(
          [[driver.lat, driver.lng], [destLat, destLng]],
          {
            color: '#d4af37',
            weight: 2,
            opacity: 0.7,
            dashArray: '8, 6',
            className: 'route-line-animated'
          }
        );
        _routeLayer.addLayer(line);
      }
    } catch(e) {}
  }

  // Poll every 10 seconds
  setInterval(drawRouteLines, 10000);
  // Also draw once after initial load
  setTimeout(drawRouteLines, 3000);


  // ═══════════════════════════════════════════════════════════════════════════
  // FEATURE 3: ADMIN QUICK REPLIES
  // Add quick reply buttons above chat input
  // ═══════════════════════════════════════════════════════════════════════════
  var quickReplies = [
    '¿Llegaste?',
    'Apúrate',
    'Pedido listo',
    '¿Estás bien?',
    'Gracias'
  ];

  function initQuickReplies() {
    waitForElement('#chat-input', function(chatInput) {
      var inputRow = chatInput.closest('.chat-input-row');
      if (!inputRow) return;
      // Check if already added
      if (document.getElementById('quick-replies-row')) return;

      var row = document.createElement('div');
      row.id = 'quick-replies-row';
      row.style.cssText = 'display:flex;gap:4px;padding:4px 8px;flex-wrap:wrap;border-top:1px solid var(--border);';

      for (var i = 0; i < quickReplies.length; i++) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = quickReplies[i];
        btn.className = 'btn btn-outline';
        btn.style.cssText = 'font-size:0.7rem;padding:2px 8px;border-radius:12px;white-space:nowrap;';
        btn.setAttribute('data-reply', quickReplies[i]);
        btn.addEventListener('click', function() {
          var input = document.getElementById('chat-input');
          var sendBtn = document.getElementById('chat-send');
          if (input) {
            input.value = this.getAttribute('data-reply');
            input.dispatchEvent(new Event('input', { bubbles: true }));
          }
          if (sendBtn && !sendBtn.disabled) {
            sendBtn.click();
          }
        });
        row.appendChild(btn);
      }
      inputRow.parentNode.insertBefore(row, inputRow);
    });
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // FEATURE 4: BADGE ON TAB
  // When active orders > 0, show a gold badge on "Pedidos y Mapa" tab
  // ═══════════════════════════════════════════════════════════════════════════
  function initTabBadge() {
    waitForElement('#stat-active', function(statEl) {
      var tabBtn = document.querySelector('.tab-btn[data-tab="pedidos"]');
      if (!tabBtn) return;
      // Make tab button relative for positioning
      tabBtn.style.position = 'relative';

      var badge = document.createElement('span');
      badge.id = 'tab-badge-orders';
      badge.style.cssText = 'position:absolute;top:-4px;right:-4px;background:var(--gold, #d4af37);color:#000;' +
        'font-size:0.65rem;font-weight:bold;min-width:16px;height:16px;border-radius:50%;' +
        'display:none;align-items:center;justify-content:center;line-height:1;padding:0 3px;';
      tabBtn.appendChild(badge);

      var observer = new MutationObserver(function() {
        try {
          var val = parseInt(statEl.textContent, 10) || 0;
          if (val > 0) {
            badge.textContent = val;
            badge.style.display = 'flex';
          } else {
            badge.style.display = 'none';
          }
        } catch(e) {}
      });
      observer.observe(statEl, { childList: true, characterData: true, subtree: true });
    });
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // FEATURE 5: ONLINE/OFFLINE INDICATOR ON CHAT CONTACTS
  // After contacts render, add green/gray dot based on driver online status
  // ═══════════════════════════════════════════════════════════════════════════
  function updateChatContactDots() {
    try {
      var contacts = document.querySelectorAll('#chat-contacts .chat-contact');
      if (!contacts.length) return;

      // Build set of online driver IDs
      var onlineIds = {};
      for (var i = 0; i < _drivers.length; i++) {
        var d = _drivers[i];
        var id = d._id || d.id;
        if (d.lat && d.lng && d.status !== 'offline') {
          onlineIds[id] = true;
        }
      }

      for (var j = 0; j < contacts.length; j++) {
        var contact = contacts[j];
        var driverId = contact.getAttribute('data-id') || contact.getAttribute('data-driver-id') || '';
        // Remove existing dot if any
        var existingDot = contact.querySelector('.enh-status-dot');
        if (existingDot) existingDot.remove();

        var dot = document.createElement('span');
        dot.className = 'enh-status-dot';
        var isOnline = onlineIds[driverId];
        dot.style.cssText = 'display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px;flex-shrink:0;' +
          'background:' + (isOnline ? '#22c55e' : '#6b7280') + ';';
        dot.title = isOnline ? 'En línea' : 'Desconectado';
        contact.insertBefore(dot, contact.firstChild);
      }
    } catch(e) {}
  }

  function initChatContactDots() {
    waitForElement('#chat-contacts', function(el) {
      var observer = new MutationObserver(function() {
        setTimeout(updateChatContactDots, 200);
      });
      observer.observe(el, { childList: true, subtree: true });
      // Initial run
      setTimeout(updateChatContactDots, 1000);
    });
    // Also update periodically since _drivers may update
    setInterval(updateChatContactDots, 5000);
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // FEATURE 6: LIVE CLOCK
  // Prepend a live clock (HH:MM:SS) inside .navbar-right
  // ═══════════════════════════════════════════════════════════════════════════
  function initLiveClock() {
    waitForElement('.navbar-right', function(navRight) {
      if (document.getElementById('live-clock')) return;

      var clock = document.createElement('span');
      clock.id = 'live-clock';
      clock.style.cssText = 'font-size:0.8rem;color:var(--text-muted);font-family:monospace;margin-right:8px;';
      navRight.insertBefore(clock, navRight.firstChild);

      function tick() {
        var now = new Date();
        var h = String(now.getHours()).padStart(2, '0');
        var m = String(now.getMinutes()).padStart(2, '0');
        var s = String(now.getSeconds()).padStart(2, '0');
        clock.textContent = h + ':' + m + ':' + s;
      }
      tick();
      setInterval(tick, 1000);
    });
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // FEATURE 7: DRIVERS SPLIT ONLINE/OFFLINE
  // After #drivers-grid renders, group cards into Online / Offline sections
  // ═══════════════════════════════════════════════════════════════════════════
  function splitDriversGrid() {
    try {
      var grid = document.getElementById('drivers-grid');
      if (!grid) return;
      var cards = grid.querySelectorAll('.driver-card');
      if (!cards.length) return;
      // Check if already split
      if (grid.querySelector('.enh-driver-section')) return;

      var onlineCards = [];
      var offlineCards = [];

      for (var i = 0; i < cards.length; i++) {
        var card = cards[i];
        // Detect online: look for a green status indicator or status text
        var statusDot = card.querySelector('.status-dot, .driver-status');
        var html = card.innerHTML.toLowerCase();
        var isOnline = false;
        if (statusDot) {
          var style = window.getComputedStyle(statusDot);
          isOnline = style.backgroundColor.indexOf('34, 197') !== -1 ||
                     style.backgroundColor.indexOf('22, 163') !== -1 ||
                     statusDot.classList.contains('online');
        }
        if (!isOnline && (html.indexOf('en línea') !== -1 || html.indexOf('online') !== -1)) {
          isOnline = true;
        }
        // Also check against _drivers data
        var cardId = card.getAttribute('data-id') || card.getAttribute('data-driver-id') || '';
        if (cardId) {
          for (var d = 0; d < _drivers.length; d++) {
            var drv = _drivers[d];
            if ((drv._id || drv.id) === cardId && drv.lat && drv.lng && drv.status !== 'offline') {
              isOnline = true;
              break;
            }
          }
        }
        if (isOnline) {
          onlineCards.push(card);
        } else {
          offlineCards.push(card);
        }
      }


      // Rebuild grid with sections
      grid.innerHTML = '';

      var onlineSection = document.createElement('div');
      onlineSection.className = 'enh-driver-section';
      onlineSection.innerHTML = '<h3 style="font-size:0.9rem;margin:0.5rem 0;color:var(--success, #22c55e);">' +
        '\uD83D\uDFE2 En l\u00EDnea (' + onlineCards.length + ')</h3>';
      var onlineGrid = document.createElement('div');
      onlineGrid.className = 'drivers-grid';
      onlineGrid.style.cssText = 'margin-bottom:1rem;';
      for (var k = 0; k < onlineCards.length; k++) {
        onlineGrid.appendChild(onlineCards[k]);
      }
      onlineSection.appendChild(onlineGrid);
      grid.appendChild(onlineSection);

      var offlineSection = document.createElement('div');
      offlineSection.className = 'enh-driver-section';
      offlineSection.innerHTML = '<h3 style="font-size:0.9rem;margin:0.5rem 0;color:var(--text-muted, #6b7280);">' +
        '\u26AB Offline (' + offlineCards.length + ')</h3>';
      var offlineGrid = document.createElement('div');
      offlineGrid.className = 'drivers-grid';
      for (var m = 0; m < offlineCards.length; m++) {
        offlineGrid.appendChild(offlineCards[m]);
      }
      offlineSection.appendChild(offlineGrid);
      grid.appendChild(offlineSection);
    } catch(e) {}
  }

  function initDriversSplit() {
    waitForElement('#drivers-grid', function(el) {
      var observer = new MutationObserver(function(mutations) {
        // Avoid re-triggering from our own changes
        for (var i = 0; i < mutations.length; i++) {
          if (mutations[i].target && mutations[i].target.classList &&
              mutations[i].target.classList.contains('enh-driver-section')) {
            return;
          }
        }
        setTimeout(splitDriversGrid, 300);
      });
      observer.observe(el, { childList: true });
    });
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // FEATURE 8: SOS HISTORY IN ACTIVITY
  // Observe for SOS modal, save to history, display in Activity tab
  // ═══════════════════════════════════════════════════════════════════════════
  function initSOSHistory() {
    var bodyObserver = new MutationObserver(function(mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var node = added[j];
          if (node.id === 'sos-alert-modal' || (node.nodeType === 1 && node.querySelector && node.querySelector('#sos-alert-modal'))) {
            // Extract SOS data from the modal content
            try {
              var modal = node.id === 'sos-alert-modal' ? node : node.querySelector('#sos-alert-modal');
              var nameEl = modal.querySelector('strong');
              var name = nameEl ? nameEl.textContent : 'Repartidor';
              var sosEntry = {
                name: name,
                time: new Date().toLocaleTimeString('es-CO'),
                date: new Date().toLocaleDateString('es-CO'),
                timestamp: Date.now()
              };
              _sosHistory.unshift(sosEntry);
              // Keep only last 50
              if (_sosHistory.length > 50) _sosHistory.pop();
              // If activity tab is visible, inject
              injectSOSInActivity();
            } catch(e) {}
          }
        }
      }
    });
    bodyObserver.observe(document.body, { childList: true, subtree: false });
  }

  function injectSOSInActivity() {
    try {
      var activityList = document.getElementById('activity-list');
      if (!activityList) return;
      // Remove previous SOS entries
      var prev = activityList.querySelectorAll('.enh-sos-entry');
      for (var i = 0; i < prev.length; i++) prev[i].remove();
      // Prepend SOS entries
      for (var j = _sosHistory.length - 1; j >= 0; j--) {
        var entry = _sosHistory[j];
        var div = document.createElement('div');
        div.className = 'activity-item enh-sos-entry';
        div.style.cssText = 'border-left:3px solid #ef4444;background:rgba(239,68,68,0.08);';
        div.innerHTML = '<span style="color:#ef4444;font-weight:bold;">\uD83D\uDEA8 SOS</span> ' +
          '<strong>' + escapeHtmlSafe(entry.name) + '</strong> — ' +
          '<span style="color:var(--text-muted);">' + entry.time + ' ' + entry.date + '</span>';
        activityList.insertBefore(div, activityList.firstChild);
      }
    } catch(e) {}
  }

  // Also inject when Activity tab is clicked
  function hookActivityTab() {
    document.addEventListener('click', function(e) {
      if (e.target && e.target.classList && e.target.classList.contains('tab-btn') &&
          e.target.getAttribute('data-tab') === 'actividad') {
        setTimeout(injectSOSInActivity, 500);
      }
    });
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // FEATURE 9: STATS FLASH ANIMATION
  // When .mini-val content changes, flash gold briefly
  // ═══════════════════════════════════════════════════════════════════════════
  function initStatsFlash() {
    // Inject the CSS keyframe
    var style = document.createElement('style');
    style.id = 'enh-flash-style';
    style.textContent =
      '@keyframes enh-flash-gold { 0% { background: var(--gold, #d4af37); color: #000; } 100% { background: transparent; color: inherit; } }' +
      '.enh-flash { animation: enh-flash-gold 1s ease-out; border-radius: 4px; }' +
      '@keyframes enh-route-dash { to { stroke-dashoffset: -20; } }' +
      '.route-line-animated { animation: enh-route-dash 1s linear infinite; }';
    document.head.appendChild(style);

    // Observe each .mini-val
    var statEls = document.querySelectorAll('.mini-val');
    for (var i = 0; i < statEls.length; i++) {
      (function(el) {
        var lastVal = el.textContent;
        var obs = new MutationObserver(function() {
          var newVal = el.textContent;
          if (newVal !== lastVal) {
            lastVal = newVal;
            el.classList.remove('enh-flash');
            // Force reflow
            void el.offsetWidth;
            el.classList.add('enh-flash');
            setTimeout(function() {
              el.classList.remove('enh-flash');
            }, 1000);
          }
        });
        obs.observe(el, { childList: true, characterData: true, subtree: true });
      })(statEls[i]);
    }
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // FEATURE 10: BROADCAST MESSAGE
  // Add button next to "Aviso" to send a broadcast message to all drivers
  // ═══════════════════════════════════════════════════════════════════════════
  function initBroadcast() {
    waitForElement('#btn-notify', function(notifyBtn) {
      if (document.getElementById('btn-broadcast')) return;

      var btn = document.createElement('button');
      btn.id = 'btn-broadcast';
      btn.className = 'btn btn-outline btn-sm';
      btn.title = 'Enviar mensaje a todos los repartidores';
      btn.textContent = '\uD83D\uDCE2 Broadcast';
      btn.style.cssText = 'margin-left:4px;';
      notifyBtn.parentNode.insertBefore(btn, notifyBtn.nextSibling);

      btn.addEventListener('click', function() {
        showBroadcastModal();
      });
    });
  }

  function showBroadcastModal() {
    // Remove previous if exists
    var prev = document.getElementById('enh-broadcast-modal');
    if (prev) prev.remove();

    var overlay = document.createElement('div');
    overlay.id = 'enh-broadcast-modal';
    overlay.className = 'modal-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9998;display:flex;align-items:center;' +
      'justify-content:center;background:rgba(0,0,0,0.5);backdrop-filter:blur(2px);';
    overlay.innerHTML =
      '<div class="modal" style="max-width:400px;padding:1.5rem;">' +
        '<h2 style="font-size:1.1rem;margin:0 0 1rem;">\uD83D\uDCE2 Mensaje Broadcast</h2>' +
        '<p style="color:var(--text-muted);font-size:0.83rem;margin-bottom:0.8rem;">Este mensaje se enviará a todos los repartidores conectados.</p>' +
        '<div class="form-group">' +
          '<label>Mensaje</label>' +
          '<textarea id="broadcast-text" rows="3" placeholder="Escribe tu mensaje..." style="width:100%;resize:vertical;"></textarea>' +
        '</div>' +
        '<div class="modal-actions">' +
          '<button type="button" class="btn btn-outline" id="broadcast-cancel">Cancelar</button>' +
          '<button type="button" class="btn btn-primary" id="broadcast-send">\uD83D\uDCE8 Enviar</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);


    document.getElementById('broadcast-cancel').addEventListener('click', function() {
      overlay.remove();
    });
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) overlay.remove();
    });

    document.getElementById('broadcast-send').addEventListener('click', function() {
      var text = document.getElementById('broadcast-text').value.trim();
      if (!text) return;
      sendBroadcast(text);
      overlay.remove();
    });

    // Focus textarea
    setTimeout(function() {
      var ta = document.getElementById('broadcast-text');
      if (ta) ta.focus();
    }, 100);
  }

  function sendBroadcast(message) {
    try {
      var token = localStorage.getItem('token') || '';
      if (!token) return;
      fetch('/api/chat/broadcast', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token
        },
        body: JSON.stringify({ message: message })
      }).then(function(res) {
        if (res.ok) {
          showEnhToast('\u2705 Broadcast enviado', 'success');
        } else {
          // Fallback: try to use socket emit if available
          showEnhToast('\u26A0\uFE0F No se pudo enviar el broadcast', 'error');
        }
      }).catch(function() {
        showEnhToast('\u26A0\uFE0F Error de conexión', 'error');
      });
    } catch(e) {}
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // UTILITY: Simple toast (uses existing toast container if available)
  // ═══════════════════════════════════════════════════════════════════════════
  function showEnhToast(message, type) {
    try {
      var container = document.getElementById('toast-container');
      if (!container) return;
      var toast = document.createElement('div');
      toast.className = 'toast ' + (type || 'info');
      toast.textContent = message;
      container.appendChild(toast);
      setTimeout(function() {
        if (toast.parentNode) toast.remove();
      }, 4000);
    } catch(e) {}
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // UTILITY: Safe HTML escape
  // ═══════════════════════════════════════════════════════════════════════════
  function escapeHtmlSafe(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INITIALIZATION — Start all features when DOM is ready
  // ═══════════════════════════════════════════════════════════════════════════
  function initAll() {
    initQuickReplies();      // Feature 3
    initTabBadge();          // Feature 4
    initChatContactDots();   // Feature 5
    initLiveClock();         // Feature 6
    initDriversSplit();      // Feature 7
    initSOSHistory();        // Feature 8
    hookActivityTab();       // Feature 8 (tab hook)
    initBroadcast();         // Feature 10
    // Feature 9 needs mini-val elements to exist
    waitForElement('.mini-val', function() {
      initStatsFlash();      // Feature 9
    });
    // Features 1 & 2 are auto-triggered via fetch interception and intervals
  }

  // Start when DOM ready or immediately if already loaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAll);
  } else {
    // Small delay to ensure dispatcher.js has finished its initialization
    setTimeout(initAll, 500);
  }

})();
