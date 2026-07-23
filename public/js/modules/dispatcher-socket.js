/**
 * Dispatcher Socket Module — Socket.IO event handlers for admin panel.
 * Extracted to reduce main dispatcher.js size.
 * 
 * Exposes: window.DispatcherApp.Socket
 */
(function () {
  'use strict';

  var DA = window.DispatcherApp = window.DispatcherApp || {};

  DA.Socket = {
    instance: null,

    /**
     * Initialize Socket.IO connection.
     * @param {object} opts - { onOrderNew, onOrderStatus, onDriverLocation, onDriverOffline, onChat, onSOS }
     */
    init: function (opts) {
      opts = opts || {};
      var token = localStorage.getItem('token') || '';
      if (this.instance) return this.instance;

      this.instance = io({ auth: { token: token } });

      this.instance.on('connect', function () {
        console.log('[Socket] Connected');
        var dot = document.getElementById('conn-dot');
        if (dot) dot.classList.add('online');
      });

      this.instance.on('disconnect', function () {
        console.log('[Socket] Disconnected');
        var dot = document.getElementById('conn-dot');
        if (dot) dot.classList.remove('online');
      });

      // ─── Order Events ──────────────────────────────────────────────────
      this.instance.on('order:new', function (order) {
        DA.showToast('Nuevo pedido: ' + order.code + ' (enviado a repartidores)', 'info');
        if (opts.onOrderNew) opts.onOrderNew(order);
      });

      this.instance.on('order:status', function (order) {
        DA.showToast('Pedido ' + order.code + ': ' + DA.statusLabel(order.status), 'info');
        if (opts.onOrderStatus) opts.onOrderStatus(order);
      });

      this.instance.on('order:assigned', function (order) {
        if (opts.onOrderStatus) opts.onOrderStatus(order);
      });

      this.instance.on('order:accepted', function (data) {
        DA.showToast('Pedido ' + data.order.code + ' aceptado por ' + data.driver_name, 'success');
        if (opts.onOrderStatus) opts.onOrderStatus(data.order);
      });

      // ─── Driver Events ─────────────────────────────────────────────────
      this.instance.on('driver:location', function (data) {
        if (DA.Map) DA.Map.updateDriverMarker(data);
        if (opts.onDriverLocation) opts.onDriverLocation(data);
      });

      this.instance.on('driver:offline', function (data) {
        if (DA.Map) DA.Map.removeDriverMarker(data);
        if (opts.onDriverOffline) opts.onDriverOffline(data);
      });

      // ─── Chat ──────────────────────────────────────────────────────────
      this.instance.on('chat:message', function (msg) {
        if (opts.onChat) opts.onChat(msg);
      });

      // ─── SOS ───────────────────────────────────────────────────────────
      this.instance.on('driver:sos', function (data) {
        if (opts.onSOS) opts.onSOS(data);
      });

      // ─── Walkie-Talkie ─────────────────────────────────────────────────
      this.instance.on('walkie:audio', function (data) {
        // Handled by walkie-talkie.js module
      });
      this.instance.on('walkie:talking', function (data) {
        window.dispatchEvent(new CustomEvent('walkie:remoteTalking', { detail: data }));
      });

      // ─── Notifications ─────────────────────────────────────────────────
      this.instance.on('notification', function (data) {
        if ('Notification' in window && Notification.permission === 'granted') {
          var title = 'Notificacion';
          var body = '';
          switch (data.type) {
            case 'order_new': title = 'Nuevo Pedido'; body = data.data && data.data.code || ''; break;
            case 'order_delivered': title = 'Pedido Entregado'; body = data.data && data.data.code || ''; break;
            case 'driver_offline': title = 'Repartidor Desconectado'; body = data.data && data.data.name || ''; break;
            case 'driver_sos': title = '🚨 SOS'; body = data.data && data.data.name || ''; break;
            default: body = data.type || '';
          }
          new Notification(title, { body: body });
        }
      });

      return this.instance;
    },

    /**
     * Emit an event.
     */
    emit: function (event, data) {
      if (this.instance) this.instance.emit(event, data);
    },
  };

})();
