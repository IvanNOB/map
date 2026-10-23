/**
 * Service Worker for the Driver PWA.
 * Provides:
 * - Offline caching for the app shell
 * - Background Sync for queued location updates
 * - Periodic Background Sync for persistent location reporting
 * - Persistent notification to keep SW alive
 * - Push notification handling
 */

const CACHE_NAME = 'driver-app-v2';
const LOCATION_QUEUE_KEY = 'pending-locations';
const TRACKING_STATE_KEY = 'tracking-active';

const APP_SHELL = [
  '/driver.html',
  '/css/style.css',
  '/js/driver.js',
  '/js/background-location.js',
  '/manifest.json',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

// ─── Install: pre-cache app shell ────────────────────────────────────────────

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

// ─── Activate: clean old caches, claim clients ───────────────────────────────

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

// ─── Fetch: cache-first for static, network for API ──────────────────────────

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (event.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) {
        // Stale-while-revalidate
        fetch(event.request).then((response) => {
          if (response && response.status === 200) {
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response));
          }
        }).catch(() => {});
        return cached;
      }
      return fetch(event.request).then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        if (event.request.headers.get('accept')?.includes('text/html')) {
          return caches.match('/driver.html');
        }
      });
    })
  );
});

// ─── Background Sync: flush queued locations when online ─────────────────────

self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-locations') {
    event.waitUntil(flushLocationQueue());
  }
});

// ─── Periodic Background Sync: keep reporting location periodically ──────────

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'periodic-location-update') {
    event.waitUntil(handlePeriodicLocationUpdate());
  }
});

// ─── Push Notifications ──────────────────────────────────────────────────────

self.addEventListener('push', (event) => {
  const data = event.data
    ? event.data.json()
    : { title: 'Nuevo pedido', body: 'Tienes un pedido asignado' };

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/icon-192.svg',
      badge: '/icons/icon-192.svg',
      vibrate: [200, 100, 200],
      tag: data.tag || 'general',
      renotify: true,
    })
  );
});

// ─── Notification click: focus the app ───────────────────────────────────────

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  // If it's the persistent tracking notification, just focus the app
  if (event.notification.tag === 'tracking-active') {
    event.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
        for (const client of clients) {
          if (client.url.includes('/driver.html') && 'focus' in client) {
            return client.focus();
          }
        }
        return self.clients.openWindow('/driver.html');
      })
    );
    return;
  }

  // For order notifications, open the app
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes('/driver.html') && 'focus' in client) {
          return client.focus();
        }
      }
      return self.clients.openWindow('/driver.html');
    })
  );
});

// ─── Messages from main thread ───────────────────────────────────────────────

self.addEventListener('message', (event) => {
  const { type, data } = event.data || {};

  switch (type) {
    case 'START_TRACKING':
      handleStartTracking(data);
      break;

    case 'STOP_TRACKING':
      handleStopTracking();
      break;

    case 'QUEUE_LOCATION':
      queueLocation(data);
      break;

    case 'GET_TRACKING_STATE':
      getTrackingState().then((state) => {
        event.source.postMessage({ type: 'TRACKING_STATE', data: state });
      });
      break;

    case 'KEEP_ALIVE':
      // Acknowledge to keep connection alive
      if (event.source) {
        event.source.postMessage({ type: 'ALIVE' });
      }
      break;
  }
});

// ─── IndexedDB helpers for location queue ────────────────────────────────────

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('driver-tracking-db', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('locations')) {
        db.createObjectStore('locations', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('state')) {
        db.createObjectStore('state', { keyPath: 'key' });
      }
    };
  });
}

async function queueLocation(locationData) {
  try {
    const db = await openDB();
    const tx = db.transaction('locations', 'readwrite');
    const store = tx.objectStore('locations');
    store.add({
      ...locationData,
      queued_at: new Date().toISOString(),
    });
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (err) {
    console.error('[SW] Error queuing location:', err);
  }
}

async function getQueuedLocations() {
  try {
    const db = await openDB();
    const tx = db.transaction('locations', 'readonly');
    const store = tx.objectStore('locations');
    const request = store.getAll();
    const result = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return result || [];
  } catch (err) {
    console.error('[SW] Error getting queued locations:', err);
    return [];
  }
}

async function clearQueuedLocations(ids) {
  try {
    const db = await openDB();
    const tx = db.transaction('locations', 'readwrite');
    const store = tx.objectStore('locations');
    for (const id of ids) {
      store.delete(id);
    }
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (err) {
    console.error('[SW] Error clearing locations:', err);
  }
}

async function saveTrackingState(state) {
  try {
    const db = await openDB();
    const tx = db.transaction('state', 'readwrite');
    const store = tx.objectStore('state');
    store.put({ key: TRACKING_STATE_KEY, ...state, updated_at: new Date().toISOString() });
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (err) {
    console.error('[SW] Error saving tracking state:', err);
  }
}

async function getTrackingState() {
  try {
    const db = await openDB();
    const tx = db.transaction('state', 'readonly');
    const store = tx.objectStore('state');
    const request = store.get(TRACKING_STATE_KEY);
    const result = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return result || { active: false };
  } catch (err) {
    console.error('[SW] Error getting tracking state:', err);
    return { active: false };
  }
}

// ─── Flush location queue to server (batch upload) ───────────────────────────

async function flushLocationQueue() {
  const locations = await getQueuedLocations();
  if (locations.length === 0) return;

  const state = await getTrackingState();
  if (!state.token) {
    console.warn('[SW] No token available, cannot flush locations');
    return;
  }

  // Send in batches of 50
  const BATCH_SIZE = 50;
  for (let i = 0; i < locations.length; i += BATCH_SIZE) {
    const batch = locations.slice(i, i + BATCH_SIZE);
    try {
      const response = await fetch('/api/location/batch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + state.token,
        },
        body: JSON.stringify({
          locations: batch.map((loc) => ({
            lat: loc.lat,
            lng: loc.lng,
            speed: loc.speed,
            accuracy: loc.accuracy,
            heading: loc.heading,
            timestamp: loc.timestamp || loc.queued_at,
          })),
        }),
      });

      if (response.ok) {
        await clearQueuedLocations(batch.map((l) => l.id));
        console.log(`[SW] Flushed ${batch.length} locations`);
      } else if (response.status === 401) {
        console.warn('[SW] Token expired, stopping background sync');
        await handleStopTracking();
        return;
      }
    } catch (err) {
      console.error('[SW] Error flushing locations:', err);
      // Will retry on next sync event
      return;
    }
  }
}

// ─── Periodic location update handler ────────────────────────────────────────

async function handlePeriodicLocationUpdate() {
  const state = await getTrackingState();
  if (!state.active || !state.token) return;

  // Notify all clients to send their current position
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clients) {
    client.postMessage({ type: 'REQUEST_LOCATION' });
  }

  // Also try to flush any queued locations
  await flushLocationQueue();
}

// ─── Start/Stop tracking handlers ────────────────────────────────────────────

async function handleStartTracking(data) {
  await saveTrackingState({
    active: true,
    token: data.token,
    driverId: data.driverId,
    driverName: data.driverName,
    startedAt: new Date().toISOString(),
  });

  // Show persistent notification to keep SW alive
  await showTrackingNotification();

  // Register periodic background sync if available
  try {
    const registration = self.registration;
    if ('periodicSync' in registration) {
      await registration.periodicSync.register('periodic-location-update', {
        minInterval: 60 * 1000, // Minimum 1 minute (browser may enforce higher)
      });
      console.log('[SW] Periodic sync registered');
    }
  } catch (err) {
    console.log('[SW] Periodic sync not available:', err.message);
  }
}

async function handleStopTracking() {
  await saveTrackingState({ active: false, token: null });

  // Remove persistent notification
  const notifications = await self.registration.getNotifications({ tag: 'tracking-active' });
  for (const n of notifications) {
    n.close();
  }

  // Unregister periodic sync
  try {
    const registration = self.registration;
    if ('periodicSync' in registration) {
      await registration.periodicSync.unregister('periodic-location-update');
    }
  } catch (err) {
    // Ignore
  }

  // Flush remaining locations
  await flushLocationQueue();
}

// ─── Persistent notification (keeps SW alive on Android) ─────────────────────

async function showTrackingNotification() {
  const state = await getTrackingState();
  await self.registration.showNotification('Ubicacion activa', {
    body: `${state.driverName || 'Repartidor'} - Compartiendo ubicacion en segundo plano`,
    icon: '/icons/icon-192.svg',
    badge: '/icons/icon-192.svg',
    tag: 'tracking-active',
    ongoing: true, // Android: makes it non-dismissable
    silent: true,
    requireInteraction: true, // Prevents auto-dismiss
    actions: [
      { action: 'stop', title: 'Detener' },
    ],
  });
}

// Handle notification actions (stop tracking from notification)
self.addEventListener('notificationclick', (event) => {
  if (event.action === 'stop') {
    event.notification.close();
    event.waitUntil(
      (async () => {
        await handleStopTracking();
        // Notify all clients that tracking was stopped
        const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const client of clients) {
          client.postMessage({ type: 'TRACKING_STOPPED' });
        }
      })()
    );
    return;
  }
}, { once: false });
