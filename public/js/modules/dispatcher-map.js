/**
 * Dispatcher Map Module — Leaflet map management.
 * Extracted to reduce main dispatcher.js size.
 * 
 * Exposes: window.DispatcherApp.Map
 */
(function () {
  'use strict';

  var DA = window.DispatcherApp = window.DispatcherApp || {};

  DA.Map = {
    instance: null,
    driverMarkers: {},
    orderLayerGroup: null,
    routePolyline: null,

    /**
     * Initialize the main map.
     * @param {string} containerId - DOM element ID
     * @param {object} opts - { lat, lng, zoom }
     */
    init: function (containerId, opts) {
      opts = opts || {};
      if (this.instance) { this.instance.invalidateSize(); return this.instance; }

      this.instance = L.map(containerId).setView(
        [opts.lat || 4.6097, opts.lng || -74.0817],
        opts.zoom || 12
      );

      // Dark mode tile layer
      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; CartoDB',
        maxZoom: 19,
      }).addTo(this.instance);

      this.orderLayerGroup = L.layerGroup().addTo(this.instance);

      return this.instance;
    },

    /**
     * Update or create a driver marker.
     */
    updateDriverMarker: function (data) {
      if (!this.instance || !data.lat || !data.lng) return;

      if (this.driverMarkers[data.id]) {
        this.driverMarkers[data.id].setLatLng([data.lat, data.lng]);
        this.driverMarkers[data.id].setPopupContent(
          '<strong>' + DA.escapeHtml(data.name) + '</strong><br>Velocidad: ' + (data.speed || 0).toFixed(1) + ' km/h'
        );
      } else {
        var marker = L.circleMarker([data.lat, data.lng], {
          radius: 10, color: '#22c55e', fillColor: '#22c55e', fillOpacity: 0.8,
        }).bindPopup('<strong>' + DA.escapeHtml(data.name) + '</strong><br>Velocidad: ' + (data.speed || 0).toFixed(1) + ' km/h');
        marker.addTo(this.instance);
        this.driverMarkers[data.id] = marker;
      }
    },

    /**
     * Remove a driver marker (went offline).
     */
    removeDriverMarker: function (data) {
      if (!this.instance || !this.driverMarkers[data.id]) return;
      this.instance.removeLayer(this.driverMarkers[data.id]);
      delete this.driverMarkers[data.id];
    },

    /**
     * Show a route polyline on the map.
     */
    showRoute: function (points) {
      if (!this.instance) return;
      if (this.routePolyline) this.instance.removeLayer(this.routePolyline);
      if (!points || points.length === 0) return;

      var latlngs = points.map(function (p) { return [p.lat, p.lng]; });
      this.routePolyline = L.polyline(latlngs, { color: '#3b82f6', weight: 4, opacity: 0.8 }).addTo(this.instance);
      this.instance.fitBounds(this.routePolyline.getBounds(), { padding: [30, 30] });
    },

    /**
     * Invalidate size (after container resize).
     */
    resize: function () {
      if (this.instance) this.instance.invalidateSize();
    },
  };

})();
