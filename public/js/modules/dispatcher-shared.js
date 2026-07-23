/**
 * Dispatcher Shared Module — State & Utilities
 * Provides a global namespace for inter-module communication.
 * 
 * Other modules access shared state via window.DispatcherApp
 */
(function () {
  'use strict';

  window.DispatcherApp = window.DispatcherApp || {};

  // ─── Shared API Wrapper ─────────────────────────────────────────────────────

  window.DispatcherApp.apiFetch = async function (url, opts = {}) {
    const token = localStorage.getItem('token') || '';
    opts.headers = {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token,
      ...opts.headers,
    };
    const res = await fetch(url, opts);
    if (res.status === 401) {
      localStorage.removeItem('token');
      window.location.reload();
      throw new Error('No autorizado');
    }
    return res;
  };

  // ─── HTML Escaping ──────────────────────────────────────────────────────────

  window.DispatcherApp.escapeHtml = function (str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  };

  // ─── Toast Notifications ────────────────────────────────────────────────────

  window.DispatcherApp.showToast = function (message, type) {
    type = type || 'info';
    var container = document.getElementById('toast-container');
    if (!container) return;
    var toast = document.createElement('div');
    toast.className = 'toast ' + type;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(function () { toast.remove(); }, 4000);
  };

  // ─── Format Helpers ─────────────────────────────────────────────────────────

  window.DispatcherApp.statusLabel = function (status) {
    var labels = {
      pending: 'Pendiente', assigned: 'Asignado', picked_up: 'Recogido',
      on_the_way: 'En camino', delivered: 'Entregado', cancelled: 'Cancelado',
    };
    return labels[status] || status;
  };

  window.DispatcherApp.formatTime = function (dateStr) {
    if (!dateStr) return '';
    var d = new Date(dateStr);
    return d.toLocaleString('es-CO', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' });
  };

  // ─── Delivery Fare (client-side) ───────────────────────────────────────────

  window.DispatcherApp.getDeliveryFare = function () {
    var hour = new Date().getHours();
    return hour >= 21 ? 4000 : 3000;
  };

  // ─── Colombian Phone Validation ────────────────────────────────────────────

  window.DispatcherApp.formatColombianPhone = function (raw) {
    if (!raw) return null;
    var cleaned = String(raw).trim().replace(/[^\d+]/g, '');
    if (cleaned.startsWith('+')) cleaned = cleaned.substring(1);
    if (cleaned.startsWith('57') && cleaned.length === 12) cleaned = cleaned.substring(2);
    if (cleaned.startsWith('0') && cleaned.length === 11) cleaned = cleaned.substring(1);
    if (cleaned.length !== 10) return null;
    if (!/^[1-8]\d{9}$/.test(cleaned) && !/^3\d{9}$/.test(cleaned)) return null;
    return '+57' + cleaned;
  };

})();
