/**
 * Flight Simulator - Generates realistic drone flight telemetry
 * Simulates a patrol/surveillance mission with waypoints
 */

// Paris area patrol route (Eiffel Tower → Arc de Triomphe → Sacré-Cœur → back)
const WAYPOINTS = [
  { lat: 48.8584, lon: 2.2945, alt: 150, name: 'Eiffel Tower' },
  { lat: 48.8738, lon: 2.2950, alt: 180, name: 'Arc de Triomphe' },
  { lat: 48.8867, lon: 2.3431, alt: 200, name: 'Sacré-Cœur' },
  { lat: 48.8606, lon: 2.3376, alt: 160, name: 'Notre-Dame' },
  { lat: 48.8584, lon: 2.2945, alt: 150, name: 'Eiffel Tower' }, // Loop back
];

class FlightSimulator {
  constructor(options = {}) {
    this.waypoints = options.waypoints || WAYPOINTS;
    this.speed = options.speed || 30; // m/s (~108 km/h)
    this.updateRate = options.updateRate || 10; // Hz

    this.currentWaypointIndex = 0;
    this.position = { ...this.waypoints[0] };
    this.heading = 0;
    this.pitch = 0;
    this.roll = 0;

    // Sensor simulation
    this.sensorAzimuth = 0;
    this.sensorElevation = -30; // Looking down
    this.sensorHFOV = 24;
    this.sensorVFOV = 18;

    // Target (where camera is looking)
    this.target = { lat: 0, lon: 0, alt: 0 };

    this.missionId = 'PATROL-' + Date.now().toString(36).toUpperCase();
    this.startTime = Date.now();
  }

  /**
   * Calculate bearing between two points
   */
  calculateBearing(from, to) {
    const lat1 = from.lat * Math.PI / 180;
    const lat2 = to.lat * Math.PI / 180;
    const dLon = (to.lon - from.lon) * Math.PI / 180;

    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    let bearing = Math.atan2(y, x) * 180 / Math.PI;
    return (bearing + 360) % 360;
  }

  /**
   * Calculate distance between two points (meters)
   */
  calculateDistance(from, to) {
    const R = 6371000; // Earth radius in meters
    const lat1 = from.lat * Math.PI / 180;
    const lat2 = to.lat * Math.PI / 180;
    const dLat = (to.lat - from.lat) * Math.PI / 180;
    const dLon = (to.lon - from.lon) * Math.PI / 180;

    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1) * Math.cos(lat2) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }

  /**
   * Move position towards a bearing by distance
   */
  movePosition(pos, bearing, distance) {
    const R = 6371000;
    const lat1 = pos.lat * Math.PI / 180;
    const lon1 = pos.lon * Math.PI / 180;
    const brng = bearing * Math.PI / 180;
    const d = distance / R;

    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(d) +
      Math.cos(lat1) * Math.sin(d) * Math.cos(brng)
    );
    const lon2 = lon1 + Math.atan2(
      Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
    );

    return {
      lat: lat2 * 180 / Math.PI,
      lon: lon2 * 180 / Math.PI
    };
  }

  /**
   * Update simulation state
   */
  update() {
    const targetWaypoint = this.waypoints[this.currentWaypointIndex];
    const nextWaypoint = this.waypoints[(this.currentWaypointIndex + 1) % this.waypoints.length];

    // Calculate distance to current waypoint
    const distance = this.calculateDistance(this.position, targetWaypoint);

    // If close to waypoint, move to next
    if (distance < 50) { // Within 50m
      this.currentWaypointIndex = (this.currentWaypointIndex + 1) % this.waypoints.length;
    }

    // Calculate heading to target
    const targetHeading = this.calculateBearing(this.position, targetWaypoint);

    // Smooth heading transition
    let headingDiff = targetHeading - this.heading;
    if (headingDiff > 180) headingDiff -= 360;
    if (headingDiff < -180) headingDiff += 360;
    this.heading += headingDiff * 0.1; // Smooth turn
    this.heading = (this.heading + 360) % 360;

    // Calculate roll based on turn rate (banking)
    this.roll = -headingDiff * 0.3;
    this.roll = Math.max(-30, Math.min(30, this.roll));

    // Move position
    const moveDistance = this.speed / this.updateRate;
    const newPos = this.movePosition(this.position, this.heading, moveDistance);
    this.position.lat = newPos.lat;
    this.position.lon = newPos.lon;

    // Smooth altitude transition
    const altDiff = targetWaypoint.alt - this.position.alt;
    this.position.alt += altDiff * 0.05;

    // Calculate pitch based on altitude change
    this.pitch = altDiff * 0.1;
    this.pitch = Math.max(-15, Math.min(15, this.pitch));

    // Sensor simulation - slowly scan left/right
    const t = (Date.now() - this.startTime) / 1000;
    this.sensorAzimuth = (this.heading + 20 * Math.sin(t * 0.5)) % 360;
    this.sensorElevation = -30 + 10 * Math.sin(t * 0.3);

    // Calculate target position (where sensor is looking)
    const slantRange = this.position.alt / Math.cos((-this.sensorElevation) * Math.PI / 180);
    const groundRange = slantRange * Math.sin((-this.sensorElevation) * Math.PI / 180);
    const targetPos = this.movePosition(this.position, this.sensorAzimuth, groundRange);
    this.target = {
      lat: targetPos.lat,
      lon: targetPos.lon,
      alt: 0 // Ground level
    };

    // Add some noise for realism
    const noise = (base, amount) => base + (Math.random() - 0.5) * amount;

    return {
      timestamp: Date.now() * 1000, // Microseconds
      missionId: this.missionId,

      // Platform
      platformHeading: noise(this.heading, 0.5),
      platformPitch: noise(this.pitch, 0.2),
      platformRoll: noise(this.roll, 0.3),

      // Sensor position
      sensorLatitude: noise(this.position.lat, 0.00001),
      sensorLongitude: noise(this.position.lon, 0.00001),
      sensorAltitude: noise(this.position.alt, 1),

      // Sensor orientation
      sensorAzimuth: noise(this.sensorAzimuth, 0.5),
      sensorElevation: noise(this.sensorElevation, 0.3),
      sensorHFOV: this.sensorHFOV,
      sensorVFOV: this.sensorVFOV,

      // Target
      targetLatitude: noise(this.target.lat, 0.00002),
      targetLongitude: noise(this.target.lon, 0.00002),
      targetElevation: noise(this.target.alt, 2),
      slantRange: noise(this.position.alt / Math.cos((-this.sensorElevation) * Math.PI / 180), 5)
    };
  }
}

export { FlightSimulator, WAYPOINTS };
export default FlightSimulator;
