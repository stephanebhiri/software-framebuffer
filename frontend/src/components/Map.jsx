import { useEffect, useState, useRef } from 'react';
import { MapContainer, TileLayer, Marker, Polyline, Polygon, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Fix default marker icon
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
});

// Custom icons
const sensorIcon = new L.Icon({
  iconUrl: 'data:image/svg+xml;base64,' + btoa(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="32" height="32">
      <circle cx="12" cy="12" r="10" fill="#3b82f6" stroke="white" stroke-width="2"/>
      <circle cx="12" cy="12" r="4" fill="white"/>
    </svg>
  `),
  iconSize: [32, 32],
  iconAnchor: [16, 16],
});

const targetIcon = new L.Icon({
  iconUrl: 'data:image/svg+xml;base64,' + btoa(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="32" height="32">
      <circle cx="12" cy="12" r="10" fill="#ef4444" stroke="white" stroke-width="2"/>
      <line x1="12" y1="2" x2="12" y2="22" stroke="white" stroke-width="2"/>
      <line x1="2" y1="12" x2="22" y2="12" stroke="white" stroke-width="2"/>
    </svg>
  `),
  iconSize: [32, 32],
  iconAnchor: [16, 16],
});

/**
 * Calculate a point at a given distance and bearing from a start point
 * @param {number} lat - Start latitude in degrees
 * @param {number} lon - Start longitude in degrees
 * @param {number} distance - Distance in meters
 * @param {number} bearing - Bearing in degrees (0 = North, 90 = East)
 * @returns {[number, number]} - [lat, lon]
 */
function destinationPoint(lat, lon, distance, bearing) {
  const R = 6371000; // Earth radius in meters
  const d = distance / R;
  const brng = (bearing * Math.PI) / 180;
  const lat1 = (lat * Math.PI) / 180;
  const lon1 = (lon * Math.PI) / 180;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng)
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
    );

  return [(lat2 * 180) / Math.PI, (lon2 * 180) / Math.PI];
}

/**
 * Generate FOV cone polygon points
 * @param {number} sensorLat - Sensor latitude
 * @param {number} sensorLon - Sensor longitude
 * @param {number} platformHeading - Aircraft heading (0 = North)
 * @param {number} sensorAzimuth - Sensor azimuth relative to platform
 * @param {number} hfov - Horizontal field of view in degrees
 * @param {number} range - Slant range in meters
 * @returns {Array} - Array of [lat, lon] points for polygon
 */
function calculateFOVCone(sensorLat, sensorLon, platformHeading, sensorAzimuth, hfov, range) {
  if (sensorLat == null || sensorLon == null || platformHeading == null || sensorAzimuth == null || !hfov || !range) {
    return null;
  }

  // Absolute direction = platform heading + relative sensor azimuth
  const azimuth = (platformHeading + sensorAzimuth) % 360;

  const points = [];
  const halfFov = hfov / 2;

  // Start at sensor position
  points.push([sensorLat, sensorLon]);

  // Calculate left edge of cone
  const leftBearing = (azimuth - halfFov + 360) % 360;
  points.push(destinationPoint(sensorLat, sensorLon, range, leftBearing));

  // Add intermediate points for smooth arc (every 5 degrees)
  const steps = Math.ceil(hfov / 5);
  for (let i = 1; i < steps; i++) {
    const bearing = (azimuth - halfFov + (hfov * i) / steps + 360) % 360;
    points.push(destinationPoint(sensorLat, sensorLon, range, bearing));
  }

  // Calculate right edge of cone
  const rightBearing = (azimuth + halfFov) % 360;
  points.push(destinationPoint(sensorLat, sensorLon, range, rightBearing));

  // Close polygon back to sensor
  points.push([sensorLat, sensorLon]);

  return points;
}

function MapUpdater({ sensorPos, targetPos, fovCone }) {
  const map = useMap();
  const userInteractedRef = useRef(false);
  const interactionTimeoutRef = useRef(null);
  const lastFitRef = useRef(0);

  // Detect user interaction (zoom, drag) - pause auto-fit for 5 seconds
  useEffect(() => {
    const handleInteraction = () => {
      userInteractedRef.current = true;

      // Clear previous timeout
      if (interactionTimeoutRef.current) {
        clearTimeout(interactionTimeoutRef.current);
      }

      // Resume auto-fit after 5 seconds of no interaction
      interactionTimeoutRef.current = setTimeout(() => {
        userInteractedRef.current = false;
      }, 5000);
    };

    map.on('zoomstart', handleInteraction);
    map.on('dragstart', handleInteraction);

    return () => {
      map.off('zoomstart', handleInteraction);
      map.off('dragstart', handleInteraction);
      if (interactionTimeoutRef.current) {
        clearTimeout(interactionTimeoutRef.current);
      }
    };
  }, [map]);

  // Auto-fit every 500ms when not interacting
  useEffect(() => {
    if (!sensorPos) return;
    if (userInteractedRef.current) return;

    const now = Date.now();
    if (now - lastFitRef.current < 500) return; // Throttle: max 2 updates/sec

    // Collect all points to fit
    const points = [sensorPos];

    if (targetPos) {
      points.push(targetPos);
    }

    if (fovCone && fovCone.length > 0) {
      points.push(...fovCone);
    }

    if (points.length > 1) {
      const bounds = L.latLngBounds(points);
      map.fitBounds(bounds, { padding: [30, 30], maxZoom: 16, animate: true, duration: 0.3 });
      lastFitRef.current = now;
    }
  }, [sensorPos, targetPos, fovCone, map]);

  return null;
}

export function Map({ klvData }) {
  const [history, setHistory] = useState([]);
  const [center, setCenter] = useState([48.8566, 2.3522]); // Paris default

  useEffect(() => {
    if (!klvData?.sensor?.latitude || !klvData?.sensor?.longitude) return;

    const pos = [klvData.sensor.latitude, klvData.sensor.longitude];
    setCenter(pos);
    setHistory(prev => {
      const newHistory = [...prev, pos];
      // Keep last 500 points
      return newHistory.slice(-500);
    });
  }, [klvData]);

  const sensorPos = klvData?.sensor?.latitude && klvData?.sensor?.longitude
    ? [klvData.sensor.latitude, klvData.sensor.longitude]
    : null;

  const targetPos = klvData?.target?.latitude && klvData?.target?.longitude
    ? [klvData.target.latitude, klvData.target.longitude]
    : null;

  // Calculate FOV cone
  // Absolute azimuth = platformHeading + sensorRelativeAzimuth
  const fovCone = sensorPos ? calculateFOVCone(
    klvData.sensor.latitude,
    klvData.sensor.longitude,
    klvData.platform?.heading,        // Platform heading (0 = North)
    klvData.sensor?.azimuth,          // Sensor azimuth relative to platform
    klvData.sensor?.hfov,
    klvData.target?.slantRangeM || 1000
  ) : null;

  return (
    <div className="map-container">
      <MapContainer
        center={center}
        zoom={14}
        style={{ height: '100%', width: '100%' }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <MapUpdater sensorPos={sensorPos} targetPos={targetPos} fovCone={fovCone} />

        {/* FOV Cone */}
        {fovCone && (
          <Polygon
            positions={fovCone}
            pathOptions={{
              color: '#f59e0b',
              fillColor: '#f59e0b',
              fillOpacity: 0.2,
              weight: 2
            }}
          />
        )}

        {/* Historical track */}
        {history.length > 1 && (
          <Polyline
            positions={history}
            color="#3b82f6"
            weight={3}
            opacity={0.7}
          />
        )}

        {/* Line from sensor to target */}
        {sensorPos && targetPos && (
          <Polyline
            positions={[sensorPos, targetPos]}
            color="#ef4444"
            weight={2}
            opacity={0.5}
            dashArray="5, 10"
          />
        )}

        {/* Sensor position (drone) */}
        {sensorPos && (
          <Marker position={sensorPos} icon={sensorIcon} />
        )}

        {/* Target position (frame center) */}
        {targetPos && (
          <Marker position={targetPos} icon={targetIcon} />
        )}
      </MapContainer>
    </div>
  );
}
