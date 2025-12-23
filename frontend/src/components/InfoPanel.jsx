const SENSOR_COLORS = ['#ef4444', '#8b5cf6', '#22c55e', '#f59e0b'];

export function InfoPanel({ klvData, sensors, status, isConnected }) {
  const sensorIds = Object.keys(sensors || {});

  const formatCoord = (val, isLat) => {
    if (val == null) return '--';
    const dir = isLat ? (val >= 0 ? 'N' : 'S') : (val >= 0 ? 'E' : 'W');
    return `${Math.abs(val).toFixed(6)}° ${dir}`;
  };

  const formatDeg = (val) => val != null ? `${val.toFixed(1)}°` : '--';
  const formatAlt = (m, ft) => {
    if (m == null) return '--';
    return `${m.toFixed(0)}m`;
  };
  const formatSpeed = (val, unit = 'm/s') => val != null ? `${val} ${unit}` : '--';

  // Render a single sensor column
  const SensorColumn = ({ sensorId, sensorData, color }) => (
    <div className="sensor-column" style={{ borderTopColor: color }}>
      <div className="sensor-column-header" style={{ background: color }}>
        {sensorData?._sensorName || sensorId}
      </div>

      <div className="sensor-data">
        <div className="data-group">
          <div className="data-label">Position</div>
          <div className="data-row">
            <span>Lat</span>
            <span>{formatCoord(sensorData?.sensor?.latitude, true)}</span>
          </div>
          <div className="data-row">
            <span>Lon</span>
            <span>{formatCoord(sensorData?.sensor?.longitude, false)}</span>
          </div>
          <div className="data-row">
            <span>Alt</span>
            <span>{formatAlt(sensorData?.sensor?.altitudeM)}</span>
          </div>
        </div>

        <div className="data-group">
          <div className="data-label">Orientation</div>
          <div className="data-row">
            <span>Az</span>
            <span>{formatDeg(sensorData?.sensor?.azimuth)}</span>
          </div>
          <div className="data-row">
            <span>El</span>
            <span>{formatDeg(sensorData?.sensor?.elevation)}</span>
          </div>
          <div className="data-row">
            <span>HFOV</span>
            <span>{formatDeg(sensorData?.sensor?.hfov)}</span>
          </div>
        </div>

        <div className="data-group">
          <div className="data-label">Frame Center</div>
          <div className="data-row">
            <span>Lat</span>
            <span>{formatCoord(sensorData?.target?.latitude, true)}</span>
          </div>
          <div className="data-row">
            <span>Lon</span>
            <span>{formatCoord(sensorData?.target?.longitude, false)}</span>
          </div>
          <div className="data-row highlight">
            <span>Elev</span>
            <span>{formatAlt(sensorData?.target?.elevationM)}</span>
          </div>
          <div className="data-row highlight">
            <span>Slant</span>
            <span>{formatAlt(sensorData?.target?.slantRangeM)}</span>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="info-panel">
      {/* Header */}
      <div className="info-header">
        <span className={`status-dot ${isConnected ? 'connected' : 'disconnected'}`} />
        <span>{isConnected ? 'Connected' : 'Disconnected'}</span>
        {status.streaming && <span className="live-badge">LIVE</span>}
        {sensorIds.length > 1 && (
          <span className="multi-sensor-badge">{sensorIds.length} sensors</span>
        )}
      </div>

      {/* Common Info: Mission & Platform */}
      <div className="common-info">
        {klvData?.mission && (
          <div className="info-section compact">
            <h3>Mission</h3>
            <div className="info-row">
              <span>Platform</span>
              <span>{klvData.mission.platformDesignation || klvData.mission.tailNumber || '--'}</span>
            </div>
            {klvData.mission.id && (
              <div className="info-row">
                <span>ID</span>
                <span className="value-small">{klvData.mission.id}</span>
              </div>
            )}
          </div>
        )}

        <div className="info-section compact">
          <h3>Platform</h3>
          <div className="platform-row">
            <div>
              <span className="label">HDG</span>
              <span className="value">{formatDeg(klvData?.platform?.heading)}</span>
            </div>
            <div>
              <span className="label">GS</span>
              <span className="value">{klvData?.platform?.groundSpeed ?? '--'} kts</span>
            </div>
          </div>
        </div>
      </div>

      {/* Sensor Columns */}
      {sensorIds.length > 0 ? (
        <div className={`sensors-grid sensors-${Math.min(sensorIds.length, 2)}`}>
          {sensorIds.map((sensorId, idx) => (
            <SensorColumn
              key={sensorId}
              sensorId={sensorId}
              sensorData={sensors[sensorId]}
              color={SENSOR_COLORS[idx % SENSOR_COLORS.length]}
            />
          ))}
        </div>
      ) : (
        <div className="no-sensors">Waiting for KLV data...</div>
      )}

      {/* Timestamp */}
      {klvData?.timestamp && (
        <div className="info-timestamp">
          {new Date(klvData.timestamp).toLocaleTimeString()}
        </div>
      )}
    </div>
  );
}
