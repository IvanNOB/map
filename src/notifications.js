/**
 * Notification helpers for Socket.IO events.
 */

/**
 * Emit a notification event to all connected admins.
 * @param {import("socket.io").Server} io
 * @param {string} type - e.g. 'order_new', 'order_delivered', 'driver_offline'
 * @param {object} data
 */
export function notifyAdmins(io, type, data) {
  io.to("admins").emit("notification", {
    type,
    data,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Emit a notification event to a specific driver.
 * @param {import("socket.io").Server} io
 * @param {number} driverId
 * @param {string} type - e.g. 'order_assigned'
 * @param {object} data
 */
export function notifyDriver(io, driverId, type, data) {
  io.to(`driver:${driverId}`).emit("notification", {
    type,
    data,
    timestamp: new Date().toISOString(),
  });
}
