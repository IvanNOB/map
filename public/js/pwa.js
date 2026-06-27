/* PWA helpers: service worker registration + install banner + push subscription (shared) */
(function () {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js')
        .then(function (reg) { window.__swReg = reg; })
        .catch(function () {});
    });
  }

  function urlB64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(base64);
    var arr = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }

  // Pages call window.enablePush(token) after login + permission.
  window.enablePush = async function (token) {
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
      if (Notification.permission !== 'granted') {
        var perm = await Notification.requestPermission();
        if (perm !== 'granted') return;
      }
      var reg = window.__swReg || (await navigator.serviceWorker.ready);
      var keyRes = await fetch('/api/push/key');
      var keyData = await keyRes.json();
      if (!keyData.enabled || !keyData.key) return;

      var sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlB64ToUint8Array(keyData.key),
        });
      }
      var headers = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = 'Bearer ' + token;
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({ subscription: sub }),
      });
    } catch (e) { /* ignore */ }
  };

  var deferredPrompt = null;

  // ── Alerta sonora + vibración cuando la app está abierta ──────────────────
  var audioCtx = null;
  function ensureAudio() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) {}
    return audioCtx;
  }
  // Desbloquear el audio en la primera interacción (política de autoplay)
  ['click', 'touchstart', 'keydown'].forEach(function (ev) {
    window.addEventListener(ev, ensureAudio, { once: true, passive: true });
  });

  function beep(times) {
    var ctx = ensureAudio();
    if (!ctx) return;
    var n = times || 3;
    for (var i = 0; i < n; i++) {
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = 880;
      var start = ctx.currentTime + i * 0.35;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.5, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.3);
      osc.start(start);
      osc.stop(start + 0.32);
    }
  }

  // Llamable desde cualquier pantalla para avisar de forma llamativa.
  window.ghostAlert = function (opts) {
    opts = opts || {};
    try { beep(opts.beeps || 3); } catch (e) {}
    try { if (navigator.vibrate) navigator.vibrate(opts.vibrate || [500, 200, 500, 200, 500]); } catch (e) {}
  };

  // Cuando el service worker recibe una notificación push y la app está abierta.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', function (e) {
      if (e.data && e.data.type === 'push-alert') {
        window.ghostAlert({ beeps: 3 });
      }
    });
  }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    if (localStorage.getItem('pwa_dismissed') === '1') return;
    showBanner();
  });

  function showBanner() {
    if (document.getElementById('install-banner')) return;
    var b = document.createElement('div');
    b.id = 'install-banner';
    b.className = 'install-banner';
    b.innerHTML =
      '<span>📲 Instala la app en tu dispositivo</span>' +
      '<button id="pwa-install">Instalar</button>' +
      '<button id="pwa-close" class="close-x">✕</button>';
    document.body.appendChild(b);

    document.getElementById('pwa-install').addEventListener('click', async function () {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      try { await deferredPrompt.userChoice; } catch (e) {}
      deferredPrompt = null;
      b.remove();
    });
    document.getElementById('pwa-close').addEventListener('click', function () {
      localStorage.setItem('pwa_dismissed', '1');
      b.remove();
    });
  }
})();
