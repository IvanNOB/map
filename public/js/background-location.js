/**
 * Background Location Module
 * 
 * Provides persistent location tracking that survives:
 * - App minimized / switched to another app
 * - Screen locked / turned off
 * - Browser tab in background
 * 
 * Uses multiple strategies:
 * 1. Wake Lock API - prevents screen/CPU sleep
 * 2. watchPosition with high accuracy - continuous GPS
 * 3. Service Worker communication - queues locations for background sync
 * 4. Visibility change detection - adjusts strategy when backgrounded
 * 5. Web Worker heartbeat - keeps JS context alive
 * 6. Persistent notification via SW - keeps SW alive on Android
 * 7. NoSleep.js technique - plays silent audio to prevent suspension
 */

(function () {
  'use strict';

  // ─── Configuration ──────────────────────────────────────────────────────────

  const CONFIG = {
    // GPS options
    highAccuracy: true,
    maxAge: 5000,           // Accept cached position up to 5s old
    timeout: 15000,         // Timeout for GPS fix
    // Reporting intervals
    foregroundInterval: 5000,    // Send every 5s when in foreground
    backgroundInterval: 15000,   // Send every 15s when in background
    // Minimum movement to report (meters)
    minDistance: 5,
    // Heartbeat to keep alive
    heartbeatInterval: 25000,    // Every 25s (before 30s offline threshold)
    // Retry/queue settings
    maxQueueSize: 500,
    batchSyncInterval: 60000,    // Try to sync queue every 60s
  };

  // ─── State ──────────────────────────────────────────────────────────────────

  let isTracking = false;
  let wakeLock = null;
  let watchId = null;
  let lastPosition = null;
  let lastSentTime = 0;
  let isVisible = !document.hidden;
  let heartbeatTimer = null;
  let batchSyncTimer = null;
  let noSleepAudio = null;
  let swRegistration = null;
  let onLocationUpdate = null;   // Callback for UI updates
  let onStatusChange = null;     // Callback for status changes
  let onError = null;            // Callback for errors

  // Token and user info (set from driver.js)
  let authToken = null;
  let driverId = null;
  let driverName = null;
  let socket = null;

  // ─── Public API ─────────────────────────────────────────────────────────────

  window.BackgroundLocation = {
    /**
     * Initialize the background location module.
     * @param {object} opts
     * @param {string} opts.token - JWT auth token
     * @param {number} opts.driverId - Driver user ID
     * @param {string} opts.driverName - Driver display name
     * @param {object} opts.socket - Socket.IO instance
     * @param {function} opts.onLocation - Called with each position update
     * @param {function} opts.onStatus - Called when tracking status changes
     * @param {function} opts.onError - Called on errors
     */
    init(opts) {
      authToken = opts.token;
      driverId = opts.driverId;
      driverName = opts.driverName;
      socket = opts.socket || null;
      onLocationUpdate = opts.onLocation || null;
      onStatusChange = opts.onStatus || null;
      onError = opts.onError || null;

      // Listen for visibility changes
      document.addEventListener('visibilitychange', handleVisibilityChange);

      // Listen for online/offline
      window.addEventListener('online', handleOnline);
      window.addEventListener('offline', handleOffline);

      // Listen for messages from Service Worker
      if (navigator.serviceWorker) {
        navigator.serviceWorker.addEventListener('message', handleSWMessage);
      }

      // Get SW registration
      if (navigator.serviceWorker && navigator.serviceWorker.ready) {
        navigator.serviceWorker.ready.then((reg) => {
          swRegistration = reg;
        });
      }

      // Check if tracking was previously active (recover after page reload)
      checkPreviousState();
    },

    /**
     * Start persistent location tracking.
     * @returns {Promise<boolean>} true if started successfully
     */
    async start() {
      if (isTracking) return true;

      if (!navigator.geolocation) {
        emitError('Geolocalizacion no disponible en este navegador');
        return false;
      }

      // Request notification permission (needed for persistent notification)
      if ('Notification' in window && Notification.permission === 'default') {
        await Notification.requestPermission();
      }

      isTracking = true;
      emitStatus('starting');

      // 1. Acquire Wake Lock
      await acquireWakeLock();

      // 2. Start GPS watch
      startGPSWatch();

      // 3. Start heartbeat (keep-alive pings)
      startHeartbeat();

      // 4. Start NoSleep audio (prevents mobile browser suspension)
      startNoSleepAudio();

      // 5. Notify Service Worker to start background tracking
      await notifySWStart();

      // 6. Start periodic batch sync
      startBatchSync();

      // 7. Register for Background Sync
      await registerBackgroundSync();

      emitStatus('active');
      console.log('[BGL] Background location tracking started');
      return true;
    },

    /**
     * Stop all location tracking.
     */
    async stop() {
      if (!isTracking) return;
      isTracking = false;

      // 1. Stop GPS watch
      stopGPSWatch();

      // 2. Release Wake Lock
      releaseWakeLock();

      // 3. Stop heartbeat
      stopHeartbeat();

      // 4. Stop NoSleep audio
      stopNoSleepAudio();

      // 5. Stop batch sync
      stopBatchSync();

      // 6. Notify Service Worker
      await notifySWStop();

      // 7. Emit driver:stop via socket
      if (socket && socket.connected) {
        socket.emit('driver:stop');
      }

      emitStatus('stopped');
      console.log('[BGL] Background location tracking stopped');
    },

    /**
     * Check if tracking is currently active.
     * @returns {boolean}
     */
    isActive() {
      return isTracking;
    },

    /**
     * Get current tracking diagnostics.
     * @returns {object}
     */
    getDiagnostics() {
      return {
        isTracking,
        hasWakeLock: wakeLock !== null,
        hasGPSWatch: watchId !== null,
        isVisible,
        lastPosition,
        lastSentTime: lastSentTime ? new Date(lastSentTime).toISOString() : null,
        heartbeatActive: heartbeatTimer !== null,
        noSleepActive: noSleepAudio !== null && !noSleepAudio.paused,
      };
    },

    /**
     * Update the socket reference (if reconnected).
     * @param {object} newSocket
     */
    updateSocket(newSocket) {
      socket = newSocket;
    },

    /**
     * Update auth token (if refreshed).
     * @param {string} newToken
     */
    updateToken(newToken) {
      authToken = newToken;
    },
  };

  // ─── Wake Lock (prevents screen/CPU from sleeping) ─────────────────────────

  async function acquireWakeLock() {
    if (!('wakeLock' in navigator)) {
      console.log('[BGL] Wake Lock API not available');
      return;
    }
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        console.log('[BGL] Wake Lock released');
        // Try to reacquire if still tracking
        if (isTracking && isVisible) {
          setTimeout(acquireWakeLock, 1000);
        }
      });
      console.log('[BGL] Wake Lock acquired');
    } catch (err) {
      console.warn('[BGL] Wake Lock request failed:', err.message);
    }
  }

  function releaseWakeLock() {
    if (wakeLock) {
      wakeLock.release().catch(() => {});
      wakeLock = null;
    }
  }

  // ─── GPS Watch Position ────────────────────────────────────────────────────

  function startGPSWatch() {
    if (watchId !== null) return;

    watchId = navigator.geolocation.watchPosition(
      handlePositionSuccess,
      handlePositionError,
      {
        enableHighAccuracy: CONFIG.highAccuracy,
        maximumAge: CONFIG.maxAge,
        timeout: CONFIG.timeout,
      }
    );
  }

  function stopGPSWatch() {
    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
  }

  function handlePositionSuccess(position) {
    const { latitude, longitude, speed, accuracy, heading, altitude } = position.coords;
    const now = Date.now();

    const locationData = {
      lat: latitude,
      lng: longitude,
      speed: speed || 0,
      accuracy: accuracy || 0,
      heading: heading || 0,
      altitude: altitude || 0,
      timestamp: new Date().toISOString(),
    };

    // Check minimum distance filter
    if (lastPosition && !hasMovedEnough(lastPosition, locationData)) {
      // Even if not moved, still send periodically
      const interval = isVisible ? CONFIG.foregroundInterval : CONFIG.backgroundInterval;
      if (now - lastSentTime < interval) {
        return; // Skip this update
      }
    }

    lastPosition = locationData;
    lastSentTime = now;

    // Notify UI callback
    if (onLocationUpdate) {
      onLocationUpdate(locationData);
    }

    // Send via Socket.IO (real-time, foreground)
    if (socket && socket.connected) {
      socket.emit('driver:update', {
        lat: latitude,
        lng: longitude,
        speed: speed || 0,
        heading: heading || 0,
        accuracy: accuracy || 0,
      });
    }

    // Queue in Service Worker (for background sync / offline)
    queueInServiceWorker(locationData);
  }

  function handlePositionError(error) {
    console.warn('[BGL] GPS error:', error.message, 'code:', error.code);

    // If permission denied, stop tracking
    if (error.code === 1) { // PERMISSION_DENIED
      emitError('Permiso de ubicacion denegado. Activa el GPS y permite el acceso.');
      window.BackgroundLocation.stop();
      return;
    }

    // For timeout or unavailable, retry
    if (error.code === 2 || error.code === 3) {
      emitError('Buscando senal GPS...');
      // watchPosition will keep trying automatically
    }
  }

  function hasMovedEnough(prev, current) {
    const R = 6371000; // Earth radius in meters
    const dLat = ((current.lat - prev.lat) * Math.PI) / 180;
    const dLng = ((current.lng - prev.lng) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((prev.lat * Math.PI) / 180) *
        Math.cos((current.lat * Math.PI) / 180) *
        Math.sin(dLng / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const distance = R * c;
    return distance >= CONFIG.minDistance;
  }

  // ─── Service Worker Communication ──────────────────────────────────────────

  function queueInServiceWorker(locationData) {
    if (!navigator.serviceWorker || !navigator.serviceWorker.controller) return;
    navigator.serviceWorker.controller.postMessage({
      type: 'QUEUE_LOCATION',
      data: locationData,
    });
  }

  async function notifySWStart() {
    if (!navigator.serviceWorker) return;
    const reg = await navigator.serviceWorker.ready;
    if (reg.active) {
      reg.active.postMessage({
        type: 'START_TRACKING',
        data: {
          token: authToken,
          driverId,
          driverName,
        },
      });
    }
  }

  async function notifySWStop() {
    if (!navigator.serviceWorker) return;
    const reg = await navigator.serviceWorker.ready;
    if (reg.active) {
      reg.active.postMessage({ type: 'STOP_TRACKING' });
    }
  }

  async function registerBackgroundSync() {
    if (!navigator.serviceWorker) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      if ('sync' in reg) {
        await reg.sync.register('sync-locations');
        console.log('[BGL] Background Sync registered');
      }
    } catch (err) {
      console.log('[BGL] Background Sync not available:', err.message);
    }
  }

  function handleSWMessage(event) {
    const { type, data } = event.data || {};

    switch (type) {
      case 'REQUEST_LOCATION':
        // SW is requesting current location (from periodic sync)
        if (lastPosition && isTracking) {
          queueInServiceWorker(lastPosition);
        }
        break;

      case 'TRACKING_STOPPED':
        // Tracking was stopped from the notification action
        isTracking = false;
        stopGPSWatch();
        releaseWakeLock();
        stopHeartbeat();
        stopNoSleepAudio();
        stopBatchSync();
        emitStatus('stopped');
        break;

      case 'ALIVE':
        // Acknowledgment from SW keep-alive
        break;
    }
  }

  // ─── Heartbeat (keeps connection alive, prevents offline detection) ────────

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (!isTracking) return;

      // Ping the service worker to keep it alive
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'KEEP_ALIVE' });
      }

      // If we have a position but haven't sent recently, resend
      if (lastPosition && socket && socket.connected) {
        const now = Date.now();
        if (now - lastSentTime > CONFIG.heartbeatInterval) {
          socket.emit('driver:update', {
            lat: lastPosition.lat,
            lng: lastPosition.lng,
            speed: lastPosition.speed || 0,
            heading: lastPosition.heading || 0,
            accuracy: lastPosition.accuracy || 0,
          });
          lastSentTime = now;
        }
      }
    }, CONFIG.heartbeatInterval);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  // ─── Batch Sync Timer ──────────────────────────────────────────────────────

  function startBatchSync() {
    stopBatchSync();
    batchSyncTimer = setInterval(async () => {
      if (!isTracking) return;
      try {
        if (navigator.serviceWorker) {
          const reg = await navigator.serviceWorker.ready;
          if ('sync' in reg) {
            await reg.sync.register('sync-locations');
          }
        }
      } catch (err) {
        // Fallback: direct batch upload
        await directBatchUpload();
      }
    }, CONFIG.batchSyncInterval);
  }

  function stopBatchSync() {
    if (batchSyncTimer) {
      clearInterval(batchSyncTimer);
      batchSyncTimer = null;
    }
  }

  async function directBatchUpload() {
    // Fallback when Background Sync is not available
    // The SW will handle this, but if SW is not active, do it directly
    if (!authToken) return;
    try {
      const response = await fetch('/api/location/batch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + authToken,
        },
        body: JSON.stringify({
          locations: lastPosition ? [{
            lat: lastPosition.lat,
            lng: lastPosition.lng,
            speed: lastPosition.speed,
            accuracy: lastPosition.accuracy,
            heading: lastPosition.heading,
            timestamp: lastPosition.timestamp,
          }] : [],
        }),
      });
      if (!response.ok && response.status === 401) {
        emitError('Sesion expirada');
      }
    } catch (err) {
      // Offline - will sync later
    }
  }

  // ─── NoSleep Audio (prevents browser from suspending the tab) ──────────────
  // This technique plays a silent audio loop which prevents iOS Safari and
  // Chrome on Android from suspending the page's JavaScript execution.

  function startNoSleepAudio() {
    if (noSleepAudio) return;

    try {
      // Create a very short silent audio context
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;

      const ctx = new AudioContext();

      // Create a buffer with 1 sample of silence
      const buffer = ctx.createBuffer(1, 1, 22050);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start(0);

      // Also create a looping silent HTML5 audio as fallback
      noSleepAudio = new Audio();
      // Data URI for a tiny silent WAV file (44 bytes)
      noSleepAudio.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
      noSleepAudio.loop = true;
      noSleepAudio.volume = 0.001; // Nearly silent
      noSleepAudio.play().catch(() => {
        // Auto-play might be blocked, that's okay
        console.log('[BGL] NoSleep audio blocked by browser');
      });

      console.log('[BGL] NoSleep audio started');
    } catch (err) {
      console.log('[BGL] NoSleep audio error:', err.message);
    }
  }

  function stopNoSleepAudio() {
    if (noSleepAudio) {
      noSleepAudio.pause();
      noSleepAudio.src = '';
      noSleepAudio = null;
    }
  }

  // ─── Visibility Change Handler ─────────────────────────────────────────────

  function handleVisibilityChange() {
    isVisible = !document.hidden;

    if (isVisible) {
      console.log('[BGL] App in foreground');
      // Reacquire wake lock
      if (isTracking && !wakeLock) {
        acquireWakeLock();
      }
      // Resume NoSleep audio (might have been paused)
      if (isTracking && noSleepAudio && noSleepAudio.paused) {
        noSleepAudio.play().catch(() => {});
      }
    } else {
      console.log('[BGL] App in background');
      // In background, rely on SW + heartbeat + NoSleep
      // GPS watchPosition continues to fire in most browsers
      // Trigger a sync registration as safety net
      if (isTracking) {
        registerBackgroundSync();
      }
    }
  }

  // ─── Online/Offline Handlers ───────────────────────────────────────────────

  function handleOnline() {
    console.log('[BGL] Device online - flushing queue');
    if (isTracking) {
      registerBackgroundSync();
    }
  }

  function handleOffline() {
    console.log('[BGL] Device offline - queuing locations');
    // Locations will be queued in IndexedDB via SW
  }

  // ─── Recover Previous State ────────────────────────────────────────────────

  async function checkPreviousState() {
    // Check if SW reports tracking was active (e.g., after page reload)
    if (!navigator.serviceWorker) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      if (reg.active) {
        reg.active.postMessage({ type: 'GET_TRACKING_STATE' });
      }
    } catch (err) {
      // Ignore
    }

    // Listen for the response
    const handler = (event) => {
      if (event.data && event.data.type === 'TRACKING_STATE') {
        const state = event.data.data;
        if (state.active && !isTracking) {
          console.log('[BGL] Recovering previous tracking state');
          emitStatus('recovering');
          // Auto-resume tracking
          window.BackgroundLocation.start();
        }
        navigator.serviceWorker.removeEventListener('message', handler);
      }
    };
    navigator.serviceWorker.addEventListener('message', handler);

    // Timeout cleanup
    setTimeout(() => {
      navigator.serviceWorker.removeEventListener('message', handler);
    }, 5000);
  }

  // ─── Status Emitters ───────────────────────────────────────────────────────

  function emitStatus(status) {
    if (onStatusChange) {
      onStatusChange(status);
    }
  }

  function emitError(message) {
    console.warn('[BGL] Error:', message);
    if (onError) {
      onError(message);
    }
  }

})();
