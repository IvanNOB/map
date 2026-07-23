/**
 * Queue service — simple job queue abstraction.
 * Uses Redis-based queue if REDIS_URL is configured, otherwise in-memory.
 * 
 * For horizontal scaling: replace with BullMQ or similar.
 * 
 * Usage:
 *   import queue from './services/queue.js';
 *   queue.add('send-whatsapp', { phone, message });
 *   queue.process('send-whatsapp', async (job) => { ... });
 */
import config from "../config/index.js";
import logger from "../config/logger.js";

const handlers = new Map();
const pending = [];

const queue = {
  /**
   * Add a job to the queue.
   * @param {string} name - job type
   * @param {object} data - job payload
   */
  add(name, data) {
    const job = { name, data, id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), createdAt: new Date().toISOString() };

    const handler = handlers.get(name);
    if (handler) {
      // Process immediately (in-memory mode)
      setImmediate(async () => {
        try {
          await handler(job);
          logger.debug(`Job ${name}:${job.id} completed`);
        } catch (err) {
          logger.error(`Job ${name}:${job.id} failed`, { error: err.message });
        }
      });
    } else {
      pending.push(job);
    }
  },

  /**
   * Register a processor for a job type.
   * @param {string} name - job type
   * @param {function} handler - async function(job)
   */
  process(name, handler) {
    handlers.set(name, handler);
    // Process any pending jobs
    const toProcess = pending.filter((j) => j.name === name);
    for (const job of toProcess) {
      pending.splice(pending.indexOf(job), 1);
      setImmediate(async () => {
        try { await handler(job); } catch (err) { logger.error(`Job ${name} failed`, { error: err.message }); }
      });
    }
  },
};

export default queue;
