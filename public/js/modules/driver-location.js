/**
 * Driver Location Module — GPS tracking and map management.
 * Extracted to separate location concerns from main driver.js.
 * 
 * Exposes: window.DriverApp.Location
 */
(function () {
  'use strict';

  var App = window.DriverApp = window.DriverApp || {};

  App.Location = {
    map: null,
    marker: null,
    watchId: null,
    sharing: false,
    lastPos: null,

    /**
     * Initialize the map.
     * @param {string} containerId
     */
    initMap: function (containerId) {
      if (this.map) { this.map.invalidateSize(); return this.map; }

      this.map = L.map(containerId).setView([4.6097, -74.0817], 13);
      window._driverMap = this.map;

      var darkMatter = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; CartoDB', maxZoom: 19,
      });
      darkMatter.addTo(this.map);

      return this.map;
    },

    /**
     * Update position marker on map.
     */
    updateMarker: function (lat, lng) {
      if (!this.map) return;
      var latlng = [lat, lng];
      if (this.marker) {
        this.marker.setLatLng(latlng);
      } else {
        this.marker = L.circleMarker(latlng, {
          radius: 10, color: '#3b82f6', fillColor: '#3b82f6', fillOpacity: 0.8,
        }).addTo(this.map);
      }
      this.map.setView(latlng, 15);
    },

    /**
     * Start GPS sharing via Socket.IO.
     * @param {object} socket - Socket.IO instance
     * @param {function} onPosition - callback(lat, lng, speed, accuracy)
     */
    startSharing: function (socket, onPosition) {
      if (this.sharing || !navigator.geolocation) return false;
      this.sharing = true;

      var self = this;
      this.watchId = navigator.geolocation.watchPosition(
        function (pos) {
          var lat = pos.coords.latitude;
          var lng = pos.coords.longitude;
          var speed = pos.coords.speed || 0;
          var accuracy = pos.coords.accuracy || 0;
          self.lastPos = { lat: lat, lng: lng, speed: speed, accuracy: accuracy };
          self.updateMarker(lat, lng);

          if (socket && socket.connected) {
            socket.emit('driver:update', { lat: lat, lng: lng, speed: speed, accuracy: accuracy });
          }
          if (onPosition) onPosition(lat, lng, speed, accuracy);
        },
        function (err) {
          console.error('[GPS] Error:', err.message);
        },
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
      );
      return true;
    },

    /**
     * Stop GPS sharing.
     * @param {object} socket
     */
    stopSharing: function (socket) {
      if (this.watchId !== null) {
        navigator.geolocation.clearWatch(this.watchId);
        this.watchId = null;
      }
      this.sharing = false;
      if (socket && socket.connected) socket.emit('driver:stop');
    },
  };

})();
