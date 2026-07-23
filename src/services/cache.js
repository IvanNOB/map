/**
 * Cache service — abstraction layer for caching.
 * Uses Redis if REDIS_URL is configured, otherwise in-memory Map.
 * 
 * Usage:
 *   import cache from './services/cache.js';
 *   await cache.set('key', value, ttlSeconds);
 *   const val = await cache.get('key');
 *   await cache.del('key');
 */
import config from "../config/index.js";
import logger from "../config/logger.js";

let impl;

if (config.redisEnabled) {
  // ─── Redis Implementation ──────────────────────────────────────────────
  try {
    const Redis = (await import("ioredis")).default;
    const redis = new Redis(config.redisUrl, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });
    await redis.connect();
    logger.info("Redis cache connected");

    impl = {
      async get(key) {
        const val = await redis.get(key);
        return val ? JSON.parse(val) : null;
      },
      async set(key, value, ttlSeconds = 300) {
        await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
      },
      async del(key) {
        await redis.del(key);
      },
      async flush() {
        await redis.flushdb();
      },
    };
  } catch (err) {
    logger.warn("Redis not available, falling back to in-memory cache", { error: err.message });
    impl = createMemoryCache();
  }
} else {
  // ─── In-Memory Implementation ──────────────────────────────────────────
  impl = createMemoryCache();
}

function createMemoryCache() {
  const store = new Map();

  return {
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expires && Date.now() > entry.expires) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key, value, ttlSeconds = 300) {
      store.set(key, {
        value,
        expires: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
      });
    },
    async del(key) {
      store.delete(key);
    },
    async flush() {
      store.clear();
    },
  };
}

export default impl;
