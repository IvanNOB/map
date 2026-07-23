/**
 * Driver Orders Module — Order rendering and status updates.
 * Extracted to separate order management from main driver.js.
 * 
 * Exposes: window.DriverApp.Orders
 */
(function () {
  'use strict';

  var App = window.DriverApp = window.DriverApp || {};

  var STATUS_LABELS = {
    pending: 'Pendiente', assigned: 'Asignado', picked_up: 'Recogido',
    on_the_way: 'En Camino', delivered: 'Entregado', cancelled: 'Cancelado',
  };

  var NEXT_ACTION = {
    assigned: { next: 'picked_up', label: 'RECOGIDO', cssClass: 'action-pickup' },
    picked_up: { next: 'on_the_way', label: 'EN CAMINO', cssClass: 'action-enroute' },
    on_the_way: { next: 'delivered', label: 'ENTREGADO', cssClass: 'action-deliver' },
  };

  App.Orders = {
    list: [],

    statusLabel: function (status) { return STATUS_LABELS[status] || status; },
    nextAction: function (status) { return NEXT_ACTION[status] || null; },

    /**
     * Load orders from API.
     * @param {function} apiFetch - authenticated fetch wrapper
     * @param {function} onLoaded - callback(orders)
     */
    load: async function (apiFetch, onLoaded) {
      try {
        var res = await apiFetch('/api/orders');
        if (res.ok) {
          this.list = await res.json();
          if (onLoaded) onLoaded(this.list);
        }
      } catch (e) { /* offline */ }
    },

    /**
     * Update order status.
     * @param {function} apiFetch
     * @param {number} orderId
     * @param {string} status
     * @returns {Promise<boolean>}
     */
    updateStatus: async function (apiFetch, orderId, status) {
      try {
        var res = await apiFetch('/api/orders/' + orderId + '/status', {
          method: 'POST',
          body: JSON.stringify({ status: status }),
        });
        return res.ok;
      } catch (e) { return false; }
    },

    /**
     * Accept an available order (competitive).
     * @param {function} apiFetch
     * @param {number} orderId
     * @returns {Promise<{ok: boolean, conflict: boolean}>}
     */
    accept: async function (apiFetch, orderId) {
      try {
        var res = await apiFetch('/api/orders/' + orderId + '/accept', { method: 'POST' });
        if (res.ok) return { ok: true, conflict: false };
        if (res.status === 409) return { ok: false, conflict: true };
        return { ok: false, conflict: false };
      } catch (e) { return { ok: false, conflict: false }; }
    },
  };

})();
