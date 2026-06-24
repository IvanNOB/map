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
