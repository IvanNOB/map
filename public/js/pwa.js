/* PWA helpers: service worker registration + install banner (shared) */
(function () {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function () {});
    });
  }

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
