/* ─── Compass & Orientation Plugin for Leaflet Maps ───────────────────────── */
/* Automatically injects a compass widget into any Leaflet map on the page */
/* Include this script AFTER leaflet.js and after the map is created */

(function () {
  'use strict';

  var compassAdded = false;
  var currentHeading = null;

  // ─── Inject compass into the Leaflet control container ─────────────────────
  function injectCompass() {
    if (compassAdded) return;

    var container = document.querySelector('.leaflet-container');
    if (!container) return false;

    var controlContainer = container.querySelector('.leaflet-control-container');
    if (!controlContainer) return false;

    // Place below zoom controls on top-left
    var topLeft = controlContainer.querySelector('.leaflet-top.leaflet-left');
    if (!topLeft) return false;

    compassAdded = true;

    var el = document.createElement('div');
    el.className = 'compass-widget leaflet-bar leaflet-control';
    el.id = 'compass-widget';
    el.innerHTML =
      '<div class="compass-rose" id="compass-rose">' +
        '<div class="compass-needle"></div>' +
        '<span class="compass-label compass-n">N</span>' +
        '<span class="compass-label compass-e">E</span>' +
        '<span class="compass-label compass-s">S</span>' +
        '<span class="compass-label compass-w">O</span>' +
      '</div>' +
      '<div class="compass-heading" id="compass-heading">--&deg;</div>';

    // Inline critical styles to guarantee visibility
    el.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:flex-start;' +
      'width:70px;height:90px;padding-top:6px;gap:2px;' +
      'background:rgba(20,20,30,0.9);border:1px solid rgba(255,255,255,0.15);' +
      'border-radius:10px;box-shadow:0 2px 8px rgba(0,0,0,0.5);backdrop-filter:blur(4px);';

    topLeft.appendChild(el);

    // Stop map interactions when touching compass
    ['mousedown', 'touchstart', 'dblclick', 'click'].forEach(function (evt) {
      el.addEventListener(evt, function (e) { e.stopPropagation(); });
    });

    initOrientation();
    return true;
  }

  // ─── Orientation handling ──────────────────────────────────────────────────
  function initOrientation() {
    var compassRose = document.getElementById('compass-rose');
    var headingEl = document.getElementById('compass-heading');
    if (!compassRose || !headingEl) return;

    // Apply styles to compass rose
    compassRose.style.cssText = 'position:relative;width:50px;height:50px;transition:transform 0.15s ease-out;';

    // Needle styles
    var needle = compassRose.querySelector('.compass-needle');
    if (needle) {
      needle.style.cssText = 'position:absolute;top:50%;left:50%;width:4px;height:22px;' +
        'transform:translate(-50%,-100%);background:#ef4444;border-radius:2px;' +
        'box-shadow:0 0 4px rgba(239,68,68,0.6);';
    }

    // Cardinal labels
    var labels = compassRose.querySelectorAll('.compass-label');
    labels.forEach(function (lbl) {
      lbl.style.cssText = 'position:absolute;font-size:0.55rem;font-weight:700;color:rgba(255,255,255,0.6);width:12px;text-align:center;';
    });
    var n = compassRose.querySelector('.compass-n');
    if (n) { n.style.top = '1px'; n.style.left = 'calc(50% - 6px)'; n.style.color = '#ef4444'; }
    var s = compassRose.querySelector('.compass-s');
    if (s) { s.style.bottom = '1px'; s.style.left = 'calc(50% - 6px)'; }
    var e = compassRose.querySelector('.compass-e');
    if (e) { e.style.right = '1px'; e.style.top = 'calc(50% - 6px)'; }
    var w = compassRose.querySelector('.compass-w');
    if (w) { w.style.left = '1px'; w.style.top = 'calc(50% - 6px)'; }

    // Heading text styles
    headingEl.style.cssText = 'font-size:0.65rem;font-weight:600;color:#fff;white-space:nowrap;';

    // DeviceOrientation API
    if (window.DeviceOrientationEvent) {
      if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        // iOS - needs tap to activate
        var widget = document.getElementById('compass-widget');
        widget.style.cursor = 'pointer';
        widget.title = 'Toca para activar brujula';
        widget.addEventListener('click', function handler() {
          DeviceOrientationEvent.requestPermission().then(function (perm) {
            if (perm === 'granted') {
              listenOrientation(compassRose, headingEl);
              widget.style.cursor = '';
              widget.title = '';
              widget.removeEventListener('click', handler);
            }
          }).catch(function () {});
        });
      } else {
        listenOrientation(compassRose, headingEl);
      }
    }

    // GPS heading fallback (works when moving)
    if (navigator.geolocation) {
      navigator.geolocation.watchPosition(function (pos) {
        var h = pos.coords.heading;
        if (h != null && !isNaN(h) && currentHeading === null) {
          updateCompass(h, compassRose, headingEl);
        }
      }, function () {}, { enableHighAccuracy: true, maximumAge: 10000 });
    }
  }

  function listenOrientation(compassRose, headingEl) {
    window.addEventListener('deviceorientation', function (event) {
      var heading = null;
      if (event.webkitCompassHeading != null) {
        heading = event.webkitCompassHeading;
      } else if (event.alpha != null) {
        heading = 360 - event.alpha;
      }
      if (heading != null) {
        updateCompass(heading, compassRose, headingEl);
      }
    }, true);
  }

  function updateCompass(heading, compassRose, headingEl) {
    if (heading == null || isNaN(heading)) return;
    currentHeading = heading;
    compassRose.style.transform = 'rotate(' + (-heading) + 'deg)';
    var dirs = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
    var idx = Math.round(heading / 45) % 8;
    headingEl.textContent = Math.round(heading) + '\u00B0 ' + dirs[idx];
  }

  // ─── Poll until map appears (handles async map initialization) ─────────────
  function tryInject() {
    if (!injectCompass()) {
      setTimeout(tryInject, 800);
    }
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(tryInject, 600);
  } else {
    document.addEventListener('DOMContentLoaded', function () {
      setTimeout(tryInject, 600);
    });
  }
})();
