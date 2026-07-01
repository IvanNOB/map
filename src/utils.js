/**
 * Utility functions for distance and time estimation.
 */

/**
 * Haversine distance between two lat/lng points.
 * @returns distance in kilometers
 */
export function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371; // Earth radius in km
  const toRad = (deg) => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Estimate travel time in minutes given distance in km.
 * @param {number} distanceKm - distance in kilometers
 * @param {number} avgSpeedKmh - average speed (default 25 km/h for urban delivery)
 * @returns minutes
 */
export function estimateTime(distanceKm, avgSpeedKmh = 25) {
  return (distanceKm / avgSpeedKmh) * 60;
}

/**
 * Dynamic ETA: calculates estimated minutes from current driver position to dropoff.
 * @param {number} driverLat
 * @param {number} driverLng
 * @param {number} dropoffLat
 * @param {number} dropoffLng
 * @param {number} avgSpeedKmh
 * @returns minutes
 */
export function dynamicETA(driverLat, driverLng, dropoffLat, dropoffLng, avgSpeedKmh = 25) {
  const distance = haversineDistance(driverLat, driverLng, dropoffLat, dropoffLng);
  return estimateTime(distance, avgSpeedKmh);
}

/**
 * Normalizes and validates a Colombian phone number.
 * Accepts formats like: 3001234567, 300 123 4567, +573001234567, 573001234567, 03001234567
 * @param {string} raw - raw phone input
 * @returns {string|null} formatted as +57XXXXXXXXXX, or null if invalid
 */
export function formatColombianPhone(raw) {
  if (!raw) return null;
  // Remove all non-digit characters except leading +
  let cleaned = String(raw).trim().replace(/[^\d+]/g, '');
  // Remove leading + if present
  if (cleaned.startsWith('+')) {
    cleaned = cleaned.substring(1);
  }
  // Remove leading country code 57 if present (12 digits = 57 + 10-digit number)
  if (cleaned.startsWith('57') && cleaned.length === 12) {
    cleaned = cleaned.substring(2);
  }
  // Remove leading 0 (some people dial 0 + number)
  if (cleaned.startsWith('0') && cleaned.length === 11) {
    cleaned = cleaned.substring(1);
  }
  // Colombian numbers are 10 digits
  if (cleaned.length !== 10) {
    return null;
  }
  // Mobile numbers start with 3, landlines start with 1-8 (area codes)
  if (!/^[1-8]\d{9}$/.test(cleaned) && !/^3\d{9}$/.test(cleaned)) {
    return null;
  }
  return '+57' + cleaned;
}

/**
 * Returns true if the given string is a valid Colombian phone number.
 * @param {string} raw
 * @returns {boolean}
 */
export function isValidColombianPhone(raw) {
  return formatColombianPhone(raw) !== null;
}
