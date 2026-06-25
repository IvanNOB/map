/* Service Worker - Agencia de Domicilios PWA */
const CACHE = "domicilios-v6";
const ASSETS = [
  "/",
  "/index.html",
  "/driver.html",
  "/customer.html",
  "/css/style.css",
  "/js/dispatcher.js",
  "/js/driver.js",
  "/js/customer.js",
  "/js/pwa.js",
  "/manifest.json",
  "/manifest-driver.json",
  "/manifest-customer.json",
  "/icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  // Never cache API or socket.io calls — always go to network.
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/socket.io/")) {
    return;
  }
  if (request.method !== "GET") return;

  // Network-first for navigation, cache fallback for offline.
  event.respondWith(
    fetch(request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(request).then((r) => r || caches.match("/")))
  );
});

// ─── Push notifications ──────────────────────────────────────────────────────
self.addEventListener("push", (event) => {
  let data = { title: "Agencia de Domicilios", body: "Tienes una notificacion", url: "/" };
  try {
    if (event.data) data = Object.assign(data, event.data.json());
  } catch (e) {}
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: data.url || "/" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.includes(url) && "focus" in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
