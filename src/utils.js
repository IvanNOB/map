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
 * Fetch the fastest driving route between two points using OSRM (free, no key).
 * @returns {Promise<{distanceKm:number, minutes:number, geometry:object}|null>}
 */
export async function getRoute(lat1, lng1, lat2, lng2) {
  try {
    const url =
      `https://router.project-osrm.org/route/v1/driving/` +
      `${lng1},${lat1};${lng2},${lat2}?overview=full&geometries=geojson`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    const r = data.routes && data.routes[0];
    if (!r) return null;
    return { distanceKm: r.distance / 1000, minutes: r.duration / 60, geometry: r.geometry };
  } catch (e) {
    return null;
  }
}
