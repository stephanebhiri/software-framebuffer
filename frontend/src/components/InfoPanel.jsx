export function InfoPanel({ klvData, status, isConnected }) {
  const formatCoord = (val, isLat) => {
    if (val == null) return '--';
    const dir = isLat ? (val >= 0 ? 'N' : 'S') : (val >= 0 ? 'E' : 'W');
    return `${Math.abs(val).toFixed(6)}° ${dir}`;
  };

  const formatDeg = (val) => val != null ? `${val.toFixed(1)}°` : '--';
  const formatAltBoth = (m, ft) => {
    if (m == null) return '--';
    return `${m.toFixed(0)}m / ${ft}ft`;
  };
  const formatSpeed = (val, unit = 'm/s') => val != null ? `${val} ${unit}` : '--';

  return (
    <div className="info-panel">
      <div className="info-header">
        <span className={`status-dot ${isConnected ? 'connected' : 'disconnected'}`} />
        <span>{isConnected ? 'Connected' : 'Disconnected'}</span>
        {status.streaming && <span className="live-badge">LIVE</span>}
      </div>

      {/* Mission Info */}
      {klvData?.mission && (
        <div className="info-section">
          <h3>Mission</h3>
          {klvData.mission.id && (
            <div className="info-row">
              <span>Mission</span>
              <span className="value-small">{klvData.mission.id}</span>
            </div>
          )}
          {klvData.mission.tailNumber && (
            <div className="info-row">
              <span>Tail #</span>
              <span>{klvData.mission.tailNumber}</span>
            </div>
          )}
          {klvData.mission.platformDesignation && (
            <div className="info-row">
              <span>Aircraft</span>
              <span>{klvData.mission.platformDesignation}</span>
            </div>
          )}
          {klvData.mission.sensorName && (
            <div className="info-row">
              <span>Sensor</span>
              <span>{klvData.mission.sensorName}</span>
            </div>
          )}
        </div>
      )}

      {/* Sensor Position */}
      <div className="info-section">
        <h3>Sensor Position</h3>
        <div className="info-row">
          <span>Lat</span>
          <span>{formatCoord(klvData?.sensor?.latitude, true)}</span>
        </div>
        <div className="info-row">
          <span>Lon</span>
          <span>{formatCoord(klvData?.sensor?.longitude, false)}</span>
        </div>
        <div className="info-row">
          <span>Alt</span>
          <span>{formatAltBoth(klvData?.sensor?.altitudeM, klvData?.sensor?.altitudeFt)}</span>
        </div>
      </div>

      {/* Sensor Orientation */}
      <div className="info-section">
        <h3>Sensor Orientation</h3>
        <div className="info-row">
          <span>HFOV</span>
          <span>{formatDeg(klvData?.sensor?.hfov)}</span>
        </div>
        <div className="info-row">
          <span>VFOV</span>
          <span>{formatDeg(klvData?.sensor?.vfov)}</span>
        </div>
        <div className="info-row">
          <span>Azimuth</span>
          <span>{formatDeg(klvData?.sensor?.azimuth)}</span>
        </div>
        <div className="info-row">
          <span>Elevation</span>
          <span>{formatDeg(klvData?.sensor?.elevation)}</span>
        </div>
      </div>

      {/* Platform State */}
      <div className="info-section">
        <h3>Platform</h3>
        <div className="info-row">
          <span>Heading</span>
          <span>{formatDeg(klvData?.platform?.heading)}</span>
        </div>
        <div className="info-row">
          <span>Pitch</span>
          <span>{formatDeg(klvData?.platform?.pitch)}</span>
        </div>
        <div className="info-row">
          <span>Roll</span>
          <span>{formatDeg(klvData?.platform?.roll)}</span>
        </div>
        {klvData?.platform?.groundSpeed != null && (
          <div className="info-row">
            <span>GS</span>
            <span>{formatSpeed(klvData.platform.groundSpeed, 'kts')}</span>
          </div>
        )}
        {klvData?.platform?.trueAirspeed != null && (
          <div className="info-row">
            <span>TAS</span>
            <span>{formatSpeed(klvData.platform.trueAirspeed, 'kts')}</span>
          </div>
        )}
      </div>

      {/* Target / Frame Center */}
      <div className="info-section">
        <h3>Frame Center</h3>
        <div className="info-row">
          <span>Lat</span>
          <span>{formatCoord(klvData?.target?.latitude, true)}</span>
        </div>
        <div className="info-row">
          <span>Lon</span>
          <span>{formatCoord(klvData?.target?.longitude, false)}</span>
        </div>
        <div className="info-row">
          <span>Elev</span>
          <span>{formatAltBoth(klvData?.target?.elevationM, klvData?.target?.elevationFt)}</span>
        </div>
        <div className="info-row">
          <span>Slant</span>
          <span>{formatAltBoth(klvData?.target?.slantRangeM, klvData?.target?.slantRangeFt)}</span>
        </div>
      </div>

      {/* Timestamp */}
      {klvData?.timestamp && (
        <div className="info-timestamp">
          <div>{new Date(klvData.timestamp).toLocaleString()}</div>
          <div className="timestamp-iso">{klvData.timestamp}</div>
        </div>
      )}
    </div>
  );
}
