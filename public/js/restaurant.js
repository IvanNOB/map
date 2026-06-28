(function () {
  'use strict';

  let token = localStorage.getItem('rest_token') || '';
  let currentUser = null;
  let socket = null;

  const loginScreen = document.getElementById('login-screen');
  const app = document.getElementById('app');
  const loginForm = document.getElementById('login-form');
  const toastContainer = document.getElementById('toast-container');
  const ordersList = document.getElementById('orders-list');

  function apiHeaders() {
    return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
  }
  async function apiFetch(url, opts = {}) {
    opts.headers = Object.assign(apiHeaders(), opts.headers || {});
    const res = await fetch(url, opts);
    if (res.status === 401) { showLogin(); }
    return res;
  }

  function showToast(msg, type) {
    type = type || 'info';
    const t = document.createElement('div');
    t.className = 'toast ' + type;
    t.textContent = msg;
    toastContainer.appendChild(t);
    setTimeout(() => t.remove(), 4000);
  }
  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
  }
  function statusLabel(s) {
    return ({ pending: 'Pendiente', assigned: 'Asignado', picked_up: 'Recogido', on_the_way: 'En Camino', delivered: 'Entregado', cancelled: 'Cancelado' }[s] || s);
  }
  function fmt(ts) {
    if (!ts) return '';
    const d = new Date(ts.indexOf && ts.indexOf('T') === -1 ? ts.replace(' ', 'T') + 'Z' : ts);
    return isNaN(d.getTime()) ? '' : d.toLocaleString('es', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  function showLogin() {
    loginScreen.classList.remove('hidden');
    app.classList.add('hidden');
    token = '';
    localStorage.removeItem('rest_token');
  }
  function showApp() {
    loginScreen.classList.add('hidden');
    app.classList.remove('hidden');
    document.getElementById('rest-name').textContent = currentUser.name;
    loadOrders();
    initSocket();
    // Notifications: ask permission + subscribe to push
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
    if (window.enablePush) window.enablePush(token);
    // Revisar si la app se abrió compartiendo un mensaje desde WhatsApp
    checkSharedIntent();
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkSharedIntent(); });
  }

  async function checkAuth() {
    if (!token) { showLogin(); return; }
    try {
      const res = await fetch('/api/auth/me', { headers: apiHeaders() });
      if (res.ok) {
        currentUser = (await res.json()).user;
        if (currentUser.role !== 'restaurant') { showToast('Esta cuenta no es de restaurante', 'error'); showLogin(); return; }
        showApp();
      } else showLogin();
    } catch { showLogin(); }
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: document.getElementById('login-email').value, password: document.getElementById('login-password').value }),
      });
      const data = await res.json();
      if (res.ok) {
        token = data.token;
        localStorage.setItem('rest_token', token);
        currentUser = data.user;
        if (currentUser.role !== 'restaurant') { showToast('Esta cuenta no es de restaurante', 'error'); return; }
        showApp();
      } else showToast(data.error || 'Error al ingresar', 'error');
    } catch { showToast('Error de conexión', 'error'); }
  });

  document.getElementById('btn-logout').addEventListener('click', showLogin);

  // ─── Importar datos desde un mensaje de WhatsApp ────────────────────────────
  function parseWhatsApp(text) {
    const res = { name: '', phone: '', address: '', items: '' };
    if (!text) return res;
    const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    const phoneMatch = text.match(/(\+?\d[\d\s().-]{6,}\d)/);
    if (phoneMatch) res.phone = phoneMatch[1].replace(/[^\d+]/g, '');

    const labels = {
      name: /^(nombre|cliente|name)\s*[:\-]\s*(.+)/i,
      phone: /^(tel[eé]fono|tel|cel(ular)?|whatsapp|wa|n[uú]mero|numero)\s*[:\-]\s*(.+)/i,
      address: /^(direcci[oó]n|direccion|dir|domicilio|barrio)\s*[:\-]\s*(.+)/i,
      items: /^(pedido|orden|productos?|art[ií]culos?|items?)\s*[:\-]\s*(.+)/i,
    };
    const remaining = [];
    lines.forEach((line) => {
      let matched = false;
      for (const key in labels) {
        const m = line.match(labels[key]);
        if (m) {
          const val = m[m.length - 1].trim();
          if (key === 'phone') { if (!res.phone) res.phone = val.replace(/[^\d+]/g, ''); }
          else if (!res[key]) res[key] = val;
          matched = true;
          break;
        }
      }
      if (!matched) remaining.push(line);
    });

    const addrKw = /(calle|cra|carrera|av\b|avenida|diagonal|transversal|\bkr\b|\bcl\b|#|n[oº]\.?|mz|manzana|casa|apto|apartamento|torre|barrio|conjunto|edificio)/i;
    const isPhoneLine = (l) => l.replace(/[^\d]/g, '').length >= 7 && /^[\d\s+().-]+$/.test(l);
    // Dirección: debe tener palabra clave Y un número o '#'
    if (!res.address) {
      const a = remaining.find((l) => addrKw.test(l) && /[#\d]/.test(l) && !isPhoneLine(l));
      if (a) res.address = a;
    }
    if (!res.name) {
      const c = remaining.find((l) =>
        l !== res.address && /[a-záéíóúñ]/i.test(l) && !/\d{4,}/.test(l) && !isPhoneLine(l) && l.split(' ').length <= 5
      );
      if (c) res.name = c;
    }
    if (!res.items) {
      const left = remaining.filter((l) => l !== res.address && l !== res.name && !isPhoneLine(l));
      if (left.length) res.items = left.join(', ');
    }
    return res;
  }

  function applyParsed(text) {
    const p = parseWhatsApp(text);
    if (p.name) document.getElementById('o-name').value = p.name;
    if (p.phone) document.getElementById('o-phone').value = formatPhone(nationalDigits(p.phone));
    if (p.address) document.getElementById('o-dropoff').value = p.address;
    if (p.items) document.getElementById('o-items').value = p.items;
    const got = [p.name, p.phone, p.address, p.items].filter(Boolean).length;
    showToast(got ? 'Datos importados, revisa y envía' : 'No se reconocieron datos, llénalos manual', got ? 'success' : 'warning');
  }

  document.getElementById('btn-parse').addEventListener('click', () => {
    applyParsed(document.getElementById('o-import').value);
  });
  document.getElementById('btn-paste').addEventListener('click', async () => {
    try {
      const txt = await navigator.clipboard.readText();
      document.getElementById('o-import').value = txt;
      applyParsed(txt);
    } catch (e) {
      showToast('No se pudo leer el portapapeles; pega el texto manualmente', 'warning');
    }
  });

  // ─── Compartir nativo desde WhatsApp (APK) ──────────────────────────────────
  async function checkSharedIntent() {
    const SI = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.SendIntent;
    if (!SI) return;
    try {
      const r = await SI.checkSendIntentReceived();
      const shared = (r && (r.text || r.title || r.description || r.url)) || '';
      if (shared) {
        const t = decodeURIComponent(shared);
        document.getElementById('o-import').value = t;
        applyParsed(t);
      }
    } catch (e) { /* sin contenido compartido */ }
  }

  // Geocode an address with Nominatim (free)
  async function geocode(address) {
    try {
      const res = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(address));
      const data = await res.json();
      if (data && data[0]) return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    } catch (e) {}
    return null;
  }

  // ─── Telefono: limpiar, formatear y validar (para no equivocarse) ───────────
  function onlyDigits(s) { return (s || '').replace(/\D/g, ''); }
  // Normaliza a numero nacional (10 digitos): quita +57 y el 0 inicial si vienen.
  function nationalDigits(raw) {
    let d = onlyDigits(raw);
    if (d.length === 12 && d.slice(0, 2) === '57') d = d.slice(2);   // +57 300...
    else if (d.length === 11 && d[0] === '0') d = d.slice(1);        // 0 300...
    return d.slice(0, 10);
  }
  function formatPhone(digits) {
    digits = digits.slice(0, 10);
    if (digits.length > 6) return digits.replace(/(\d{3})(\d{3})(\d{0,4})/, '$1 $2 $3').trim();
    if (digits.length > 3) return digits.replace(/(\d{3})(\d{0,3})/, '$1 $2').trim();
    return digits;
  }
  (function bindPhoneField() {
    const input = document.getElementById('o-phone');
    const hint = document.getElementById('phone-hint');
    if (!input) return;
    input.addEventListener('input', () => {
      const digits = nationalDigits(input.value);
      input.value = formatPhone(digits);
      if (!hint) return;
      if (digits.length === 0) {
        hint.textContent = 'Solo números. Celular: 10 dígitos.';
        hint.className = 'phone-hint';
      } else if (digits.length === 10 && digits[0] === '3') {
        hint.textContent = '✓ Número de celular válido';
        hint.className = 'phone-hint ok';
      } else if (digits.length < 7) {
        hint.textContent = 'Faltan dígitos (' + digits.length + '/10)';
        hint.className = 'phone-hint warn';
      } else if (digits.length < 10) {
        hint.textContent = digits.length + ' dígitos. Un celular tiene 10.';
        hint.className = 'phone-hint warn';
      } else {
        hint.textContent = '✓ Número guardado';
        hint.className = 'phone-hint ok';
      }
    });
  })();

  document.getElementById('order-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const phoneDigits = nationalDigits(document.getElementById('o-phone').value);
    if (phoneDigits && (phoneDigits.length < 7 || phoneDigits.length > 10)) {
      showToast('Revisa el teléfono: debe tener entre 7 y 10 dígitos', 'warning');
      document.getElementById('o-phone').focus();
      return;
    }
    const dropoff = document.getElementById('o-dropoff').value.trim();
    const body = {
      customer_name: document.getElementById('o-name').value.trim(),
      customer_phone: phoneDigits ? formatPhone(phoneDigits) : '',
      dropoff_address: dropoff,
      items: document.getElementById('o-items').value.trim(),
      amount: parseFloat(document.getElementById('o-amount').value) || 0,
      payment_method: document.getElementById('o-payment').value,
    };
    showToast('Enviando domicilio...', 'info');
    if (dropoff) {
      const geo = await geocode(dropoff);
      if (geo) { body.dropoff_lat = geo.lat; body.dropoff_lng = geo.lng; }
    }
    try {
      const res = await apiFetch('/api/orders', { method: 'POST', body: JSON.stringify(body) });
      const data = await res.json();
      if (res.ok) {
        showToast('Domicilio enviado: ' + data.code, 'success');
        document.getElementById('order-form').reset();
        loadOrders();
      } else showToast(data.error || 'Error al enviar', 'error');
    } catch { showToast('Error de conexión', 'error'); }
  });

  async function loadOrders() {
    try {
      const res = await apiFetch('/api/orders');
      if (!res.ok) return;
      const orders = await res.json();
      if (orders.length === 0) { ordersList.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:1rem;">Aún no has enviado domicilios.</p>'; return; }
      ordersList.innerHTML = orders.map((o) =>
        '<div class="order-card status-' + escapeHtml(o.status) + '">' +
        '<div><span class="order-code">' + escapeHtml(o.code) + '</span>' +
        '<span class="badge badge-' + escapeHtml(o.status) + '">' + escapeHtml(statusLabel(o.status)) + '</span></div>' +
        '<div class="order-customer">' + escapeHtml(o.customer_name) + '</div>' +
        '<div class="order-addresses">🔴 ' + escapeHtml(o.dropoff_address || '') + '</div>' +
        '<div class="order-meta"><span>' + escapeHtml(fmt(o.created_at)) + '</span>' +
        (o.amount ? '<span>$' + escapeHtml(String(o.amount)) + '</span>' : '') + '</div>' +
        '</div>'
      ).join('');
    } catch {}
  }

  function initSocket() {
    if (socket) return;
    socket = io({ auth: { token } });
    socket.on('order:status', (o) => { loadOrders(); if (o && o.code) showToast('Pedido ' + o.code + ': ' + statusLabel(o.status), 'info'); });
    socket.on('order:assigned', (o) => { loadOrders(); if (window.ghostAlert) window.ghostAlert({ beeps: 3 }); if (o && o.code) showToast('Pedido ' + o.code + ' asignado a un repartidor', 'info'); });
  }

  checkAuth();
})();
