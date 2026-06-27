/* Service Worker - Servicio Ghost PWA */
const CACHE = "domicilios-v29";
const ASSETS = [
  "/",
  "/index.html",
  "/driver.html",
  "/customer.html",
  "/css/style.css",
  "/js/dispatcher.js",
  "/js/driver.js",
  "/js/customer.js",
  "/js/restaurant.js",
  "/js/pwa.js",
  "/manifest.json",
  "/manifest-driver.json",
  "/manifest-customer.json",
  "/manifest-restaurant.json",
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
  let data = { title: "Servicio Ghost", body: "Tienes una notificacion", url: "/" };
  try {
    if (event.data) data = Object.assign(data, event.data.json());
  } catch (e) {}

  const options = {
    body: data.body,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { url: data.url || "/" },
    // Make the notification much more noticeable on phones:
    vibrate: [500, 200, 500, 200, 500],     // strong, repeated vibration
    requireInteraction: true,                // stays on screen until tapped
    renotify: true,                          // re-alerts even if grouped
    tag: data.tag || ("ghost-" + Date.now()), // unique so each one alerts
    silent: false,
    timestamp: Date.now(),
    actions: [{ action: "open", title: "✅ Abrir" }],
  };

  event.waitUntil(
    self.registration
      .showNotification(data.title, options)
      .then(() => self.clients.matchAll({ type: "window", includeUncontrolled: true }))
      .then((list) => {
        // Ask any open page to play an alert sound + vibrate.
        for (const c of list) c.postMessage({ type: "push-alert", data: data });
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
