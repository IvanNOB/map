/* Compass plugin - se auto-inyecta en cualquier mapa Leaflet de la pagina */
(function () {
  'use strict';
  var added = false, heading = null;

  function inject() {
    if (added) return;
    var c = document.querySelector('.leaflet-container');
    if (!c) return setTimeout(inject, 800);
    var ctrl = c.querySelector('.leaflet-control-container .leaflet-top.leaflet-left');
    if (!ctrl) return setTimeout(inject, 800);
    added = true;

    var el = document.createElement('div');
    el.className = 'leaflet-bar leaflet-control';
    el.id = 'compass-widget';
    el.style.cssText = 'display:flex;flex-direction:column;align-items:center;width:68px;height:88px;padding-top:6px;gap:2px;background:rgba(20,20,30,0.92);border:1px solid rgba(255,255,255,0.12);border-radius:10px;box-shadow:0 2px 8px rgba(0,0,0,0.5);backdrop-filter:blur(4px);margin-top:8px;';
    el.innerHTML =
      '<div id="compass-rose" style="position:relative;width:48px;height:48px;transition:transform 0.12s ease-out;">' +
        '<div style="position:absolute;top:50%;left:50%;width:4px;height:20px;transform:translate(-50%,-100%);background:#ef4444;border-radius:2px;box-shadow:0 0 4px rgba(239,68,68,0.6);"></div>' +
        '<div style="position:absolute;top:50%;left:50%;width:4px;height:16px;transform:translate(-50%,0);background:rgba(255,255,255,0.3);border-radius:2px;"></div>' +
        '<span style="position:absolute;top:1px;left:50%;transform:translateX(-50%);font-size:0.55rem;font-weight:700;color:#ef4444;">N</span>' +
        '<span style="position:absolute;bottom:1px;left:50%;transform:translateX(-50%);font-size:0.55rem;font-weight:700;color:rgba(255,255,255,0.5);">S</span>' +
        '<span style="position:absolute;right:1px;top:50%;transform:translateY(-50%);font-size:0.55rem;font-weight:700;color:rgba(255,255,255,0.5);">E</span>' +
        '<span style="position:absolute;left:1px;top:50%;transform:translateY(-50%);font-size:0.55rem;font-weight:700;color:rgba(255,255,255,0.5);">O</span>' +
      '</div>' +
      '<div id="compass-heading" style="font-size:0.65rem;font-weight:600;color:#fff;white-space:nowrap;">--&deg;</div>';

    ctrl.appendChild(el);
    ['mousedown','touchstart','dblclick','click'].forEach(function(e){el.addEventListener(e,function(ev){ev.stopPropagation();});});
    initOrientation();
  }

  function initOrientation() {
    var rose = document.getElementById('compass-rose');
    var txt = document.getElementById('compass-heading');
    if (!rose || !txt) return;

    if (window.DeviceOrientationEvent) {
      if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        var w = document.getElementById('compass-widget');
        w.style.cursor = 'pointer';
        w.addEventListener('click', function h() {
          DeviceOrientationEvent.requestPermission().then(function(p) {
            if (p === 'granted') { listen(rose, txt); w.style.cursor = ''; w.removeEventListener('click', h); }
          }).catch(function(){});
        });
      } else {
        listen(rose, txt);
      }
    }
    if (navigator.geolocation) {
      navigator.geolocation.watchPosition(function(pos) {
        var h = pos.coords.heading;
        if (h != null && !isNaN(h) && heading === null) update(h, rose, txt);
      }, function(){}, {enableHighAccuracy:true, maximumAge:10000});
    }
  }

  function listen(rose, txt) {
    window.addEventListener('deviceorientation', function(e) {
      var h = e.webkitCompassHeading != null ? e.webkitCompassHeading : (e.alpha != null ? 360 - e.alpha : null);
      if (h != null) update(h, rose, txt);
    }, true);
  }

  function update(h, rose, txt) {
    if (h == null || isNaN(h)) return;
    heading = h;
    rose.style.transform = 'rotate(' + (-h) + 'deg)';
    var d = ['N','NE','E','SE','S','SO','O','NO'];
    txt.textContent = Math.round(h) + '\u00B0 ' + d[Math.round(h/45)%8];
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function(){setTimeout(inject,500);});
  else setTimeout(inject, 500);
})();
