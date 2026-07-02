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
  ['click', 'touchstart', 'keydown'].forEach(function (ev) {
    window.addEventListener(ev, ensureAudio, { once: true, passive: true });
  });

  // Sonido de susto fantasmal: "BOO!" espectral
  function ghostScareSound() {
    var ctx = ensureAudio();
    if (!ctx) return;
    var now = ctx.currentTime;

    // Capa 1: "Boooo" grave subiendo
    var osc1 = ctx.createOscillator();
    var gain1 = ctx.createGain();
    osc1.connect(gain1); gain1.connect(ctx.destination);
    osc1.type = 'sawtooth';
    osc1.frequency.setValueAtTime(80, now);
    osc1.frequency.exponentialRampToValueAtTime(300, now + 0.3);
    osc1.frequency.exponentialRampToValueAtTime(150, now + 0.8);
    gain1.gain.setValueAtTime(0.0001, now);
    gain1.gain.exponentialRampToValueAtTime(0.6, now + 0.1);
    gain1.gain.setValueAtTime(0.5, now + 0.3);
    gain1.gain.exponentialRampToValueAtTime(0.0001, now + 1.0);
    osc1.start(now); osc1.stop(now + 1.0);

    // Capa 2: Viento fantasmal
    var bufSize = ctx.sampleRate;
    var buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < bufSize; i++) data[i] = (Math.random() * 2 - 1) * 0.3;
    var noise = ctx.createBufferSource(); noise.buffer = buf;
    var nGain = ctx.createGain();
    var nFilter = ctx.createBiquadFilter();
    nFilter.type = 'bandpass'; nFilter.frequency.value = 400; nFilter.Q.value = 2;
    noise.connect(nFilter); nFilter.connect(nGain); nGain.connect(ctx.destination);
    nGain.gain.setValueAtTime(0.0001, now);
    nGain.gain.exponentialRampToValueAtTime(0.25, now + 0.15);
    nGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.9);
    noise.start(now); noise.stop(now + 1.0);

    // Capa 3: Eco agudo (el susto)
    var osc2 = ctx.createOscillator();
    var gain2 = ctx.createGain();
    osc2.connect(gain2); gain2.connect(ctx.destination);
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(600, now + 0.2);
    osc2.frequency.exponentialRampToValueAtTime(200, now + 0.8);
    gain2.gain.setValueAtTime(0.0001, now + 0.2);
    gain2.gain.exponentialRampToValueAtTime(0.3, now + 0.25);
    gain2.gain.exponentialRampToValueAtTime(0.0001, now + 0.9);
    osc2.start(now + 0.2); osc2.stop(now + 1.0);
  }

  // Notificación visual fantasma: banner animado
  function showGhostNotification(title, body) {
    var prev = document.getElementById('ghost-notif');
    if (prev) prev.remove();

    var overlay = document.createElement('div');
    overlay.id = 'ghost-notif';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;' +
      'display:flex;align-items:center;gap:0.8rem;padding:1rem 1.2rem;' +
      'background:linear-gradient(135deg,#1a1a2e 0%,#16213e 50%,#0f3460 100%);' +
      'border-bottom:3px solid #d4af37;box-shadow:0 4px 20px rgba(212,175,55,0.3);' +
      'animation:ghostSlideIn 0.4s ease-out;font-family:inherit;';

    overlay.innerHTML =
      '<div style="font-size:2.2rem;animation:ghostBounce 0.6s ease infinite alternate;">👻</div>' +
      '<div style="flex:1;">' +
        '<div style="color:#d4af37;font-weight:bold;font-size:0.95rem;">' + (title || 'Servicio Ghost') + '</div>' +
        '<div style="color:#e0e0e0;font-size:0.85rem;margin-top:2px;">' + (body || '') + '</div>' +
      '</div>' +
      '<button onclick="this.parentElement.remove()" style="background:none;border:none;color:#888;font-size:1.3rem;cursor:pointer;">✕</button>';

    if (!document.getElementById('ghost-notif-styles')) {
      var style = document.createElement('style');
      style.id = 'ghost-notif-styles';
      style.textContent =
        '@keyframes ghostSlideIn{from{transform:translateY(-100%);opacity:0;}to{transform:translateY(0);opacity:1;}}' +
        '@keyframes ghostBounce{from{transform:translateY(0) scale(1);}to{transform:translateY(-5px) scale(1.1);}}' +
        '@keyframes ghostFadeOut{from{opacity:1;transform:translateY(0);}to{opacity:0;transform:translateY(-100%);}}';
      document.head.appendChild(style);
    }

    document.body.appendChild(overlay);
    setTimeout(function () {
      if (overlay.parentElement) {
        overlay.style.animation = 'ghostFadeOut 0.4s ease-in forwards';
        setTimeout(function () { if (overlay.parentElement) overlay.remove(); }, 400);
      }
    }, 5000);
  }

  // Llamable desde cualquier pantalla
  window.ghostAlert = function (opts) {
    opts = opts || {};
    try { ghostScareSound(); } catch (e) {}
    try { if (navigator.vibrate) navigator.vibrate(opts.vibrate || [300, 100, 500, 100, 300]); } catch (e) {}
    if (opts.title || opts.body) {
      showGhostNotification(opts.title || '', opts.body || '');
    }
  };

  // Cuando el service worker recibe una notificación push y la app está abierta.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', function (e) {
      if (e.data && e.data.type === 'push-alert') {
        window.ghostAlert({ title: '👻 Servicios Ghost', body: 'Tienes una nueva notificación' });
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
