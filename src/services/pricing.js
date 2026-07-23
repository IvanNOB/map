/**
 * Delivery pricing service.
 * Centralizes fare calculation logic.
 */
import config from "../config/index.js";

/**
 * Returns the delivery fare based on current time in Colombia.
 * @returns {number} fare in COP
 */
export function getDeliveryFare() {
  const now = new Date();
  const colombiaTime = new Date(now.toLocaleString("en-US", { timeZone: config.timezone }));
  const hour = colombiaTime.getHours();
  return hour >= config.fareNightStartHour ? config.fareNight : config.fareDay;
}

/**
 * Returns whether it's currently night rate.
 * @returns {boolean}
 */
export function isNightRate() {
  const now = new Date();
  const colombiaTime = new Date(now.toLocaleString("en-US", { timeZone: config.timezone }));
  return colombiaTime.getHours() >= config.fareNightStartHour;
}
