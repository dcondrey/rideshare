// @ts-check
/**
 * Cost-split and CO2 estimates for a ride. Rough by design and labeled as
 * estimates in the UI: straight-line distance times a road factor, flat
 * per-mile rates, and average emissions per vehicle mile.
 */

import { getEventConfig } from "./event-config.js";

const ROAD_FACTOR = 1.3; // road distance vs. straight line, typical for metro trips
const CAR_COST_PER_MILE = 0.3; // fuel, tolls, parking share
const TAXI_BASE = 4;
const TAXI_PER_MILE = 2.6;
const TRANSIT_FARE = 9;
const CAR_KG_CO2_PER_MILE = 0.4; // average passenger car (US EPA ~400 g/mi)
const TRANSIT_KG_CO2_PER_PASSENGER_MILE = 0.14;

/** @param {number} lat1 @param {number} lng1 @param {number} lat2 @param {number} lng2 */
export function milesBetween(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * @typedef {{ miles: number, people: number, totalCost: number, costEach: number,
 *   co2SavedKg: number, basis: string }} TripEstimate
 */

/**
 * @param {{ airport: string, mode?: string, kind: string }} ride
 * @param {number} people everyone travelling together, including the poster
 * @returns {TripEstimate | null} null when the pickup point has no coordinates
 */
export function tripEstimate(ride, people) {
  const event = getEventConfig();
  const a = (event.airports || []).find((x) => x.code === ride.airport);
  const v = event.venue;
  if (!a || !Number.isFinite(a.lat) || !v || !Number.isFinite(v.lat)) return null;
  const miles = milesBetween(a.lat, a.lng, v.lat, v.lng) * ROAD_FACTOR;
  const n = Math.max(1, people);
  const mode = ride.mode || "car";
  let totalCost;
  let co2SavedKg;
  let basis;
  if (mode === "transit") {
    totalCost = TRANSIT_FARE * n;
    // Each traveller would otherwise have taken a car on their own.
    co2SavedKg = n * miles * (CAR_KG_CO2_PER_MILE - TRANSIT_KG_CO2_PER_PASSENGER_MILE);
    basis = `about $${TRANSIT_FARE} a fare; transit vs. a car each`;
  } else {
    const perMile = mode === "taxi" ? TAXI_PER_MILE : CAR_COST_PER_MILE;
    totalCost = (mode === "taxi" ? TAXI_BASE : 0) + miles * perMile;
    // One vehicle instead of n.
    co2SavedKg = (n - 1) * miles * CAR_KG_CO2_PER_MILE;
    basis =
      mode === "taxi"
        ? `$${TAXI_BASE} + $${TAXI_PER_MILE}/mi taxi fare, one car instead of ${n}`
        : `$${CAR_COST_PER_MILE}/mi for gas and tolls, one car instead of ${n}`;
  }
  return {
    miles: Math.round(miles),
    people: n,
    totalCost: Math.round(totalCost),
    costEach: Math.round(totalCost / n),
    co2SavedKg: Math.round(co2SavedKg),
    basis,
  };
}
