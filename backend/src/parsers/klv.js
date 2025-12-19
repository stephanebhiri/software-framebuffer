/**
 * KLV Parser for MISB ST 0601 (UAS Datalink Local Set)
 * Parses STANAG 4609 metadata from drone video streams
 */

// UAS Local Set Universal Key (MISB 0601)
const UAS_LOCAL_SET_KEY = Buffer.from([
  0x06, 0x0e, 0x2b, 0x34, 0x02, 0x0b, 0x01, 0x01,
  0x0e, 0x01, 0x03, 0x01, 0x01, 0x00, 0x00, 0x00
]);

// MISB 0601 Tag definitions with IMAPB encoding
const TAGS = {
  1: { name: 'checksum', type: 'uint16' },
  2: { name: 'precisionTimeStamp', type: 'uint64' },
  3: { name: 'missionId', type: 'string' },
  4: { name: 'platformTailNumber', type: 'string' },
  5: { name: 'platformHeading', type: 'uint16', min: 0, max: 360 },
  6: { name: 'platformPitch', type: 'imapb16', min: -20, max: 20 },
  7: { name: 'platformRoll', type: 'imapb16', min: -50, max: 50 },
  8: { name: 'platformTrueAirspeed', type: 'uint8' },
  9: { name: 'platformIndicatedAirspeed', type: 'uint8' },
  10: { name: 'platformDesignation', type: 'string' },
  11: { name: 'imageSourceSensor', type: 'string' },
  12: { name: 'imageCoordinateSystem', type: 'string' },
  13: { name: 'sensorLatitude', type: 'imapb32', min: -90, max: 90 },
  14: { name: 'sensorLongitude', type: 'imapb32', min: -180, max: 180 },
  15: { name: 'sensorAltitude', type: 'uint16', min: -900, max: 19000 },
  16: { name: 'sensorHFOV', type: 'uint16', min: 0, max: 180 },
  17: { name: 'sensorVFOV', type: 'uint16', min: 0, max: 180 },
  18: { name: 'sensorRelativeAzimuth', type: 'uint32', min: 0, max: 360 },
  19: { name: 'sensorRelativeElevation', type: 'imapb32', min: -180, max: 180 },
  20: { name: 'sensorRelativeRoll', type: 'uint32', min: 0, max: 360 },
  21: { name: 'slantRange', type: 'uint32', min: 0, max: 5000000 },
  22: { name: 'targetWidth', type: 'uint16', min: 0, max: 10000 },
  23: { name: 'frameCenterLatitude', type: 'imapb32', min: -90, max: 90 },
  24: { name: 'frameCenterLongitude', type: 'imapb32', min: -180, max: 180 },
  25: { name: 'frameCenterElevation', type: 'uint16', min: -900, max: 19000 },
  26: { name: 'cornerLatPt1', type: 'imapb16', min: -90, max: 90 },
  27: { name: 'cornerLonPt1', type: 'imapb16', min: -180, max: 180 },
  28: { name: 'cornerLatPt2', type: 'imapb16', min: -90, max: 90 },
  29: { name: 'cornerLonPt2', type: 'imapb16', min: -180, max: 180 },
  30: { name: 'cornerLatPt3', type: 'imapb16', min: -90, max: 90 },
  31: { name: 'cornerLonPt3', type: 'imapb16', min: -180, max: 180 },
  32: { name: 'cornerLatPt4', type: 'imapb16', min: -90, max: 90 },
  33: { name: 'cornerLonPt4', type: 'imapb16', min: -180, max: 180 },
  47: { name: 'platformVerticalSpeed', type: 'imapb16', min: -180, max: 180 },
  48: { name: 'securityLocalSet', type: 'hex' },
  56: { name: 'platformGroundSpeed', type: 'uint8' },
  57: { name: 'groundRange', type: 'uint32', min: 0, max: 5000000 },
  59: { name: 'weaponLoad', type: 'string' },
  65: { name: 'sensorName', type: 'string' },
  72: { name: 'platformCallSign', type: 'string' }
};

/**
 * Decode BER-encoded length
 * @param {Buffer} buffer
 * @param {number} offset
 * @returns {{ length: number, bytesRead: number }}
 */
function decodeBERLength(buffer, offset) {
  const firstByte = buffer[offset];

  if (firstByte < 128) {
    return { length: firstByte, bytesRead: 1 };
  }

  const numBytes = firstByte & 0x7f;
  let length = 0;

  for (let i = 0; i < numBytes; i++) {
    length = (length << 8) | buffer[offset + 1 + i];
  }

  return { length, bytesRead: 1 + numBytes };
}

/**
 * IMAPB decoding (MISB ST 0601)
 * Uses signed interpretation for symmetric ranges (lat/lon)
 * Uses unsigned interpretation for asymmetric ranges (altitude, etc.)
 * @param {number} raw - Raw value (read as unsigned)
 * @param {number} bits - Number of bits (16 or 32)
 * @param {number} min - Minimum output value
 * @param {number} max - Maximum output value
 */
function decodeIMAPB(raw, bits, min, max) {
  const maxUnsigned = Math.pow(2, bits) - 1;

  // Check for special "out of range" values
  if (raw === 0 || raw === maxUnsigned) return null;

  // Check if range is symmetric around zero (like lat/lon)
  const isSymmetric = Math.abs(max + min) < 0.001;

  if (isSymmetric) {
    // Signed interpretation for symmetric ranges
    const maxSigned = Math.pow(2, bits - 1) - 1;
    let signedRaw = raw;
    if (raw >= Math.pow(2, bits - 1)) {
      signedRaw = raw - Math.pow(2, bits);
    }
    const halfRange = (max - min) / 2;
    const result = (signedRaw * halfRange) / maxSigned;
    return Math.round(result * 1000000) / 1000000;
  } else {
    // Unsigned interpretation for asymmetric ranges
    const range = max - min;
    const result = min + (raw / maxUnsigned) * range;
    return Math.round(result * 1000000) / 1000000;
  }
}

/**
 * Read value based on type
 * @param {Buffer} buffer
 * @param {number} offset
 * @param {number} length
 * @param {object} tagDef
 * @returns {any}
 */
function readValue(buffer, offset, length, tagDef) {
  if (!tagDef) {
    return buffer.subarray(offset, offset + length).toString('hex');
  }

  let rawValue;

  switch (tagDef.type) {
    case 'uint8':
      rawValue = buffer.readUInt8(offset);
      break;
    case 'uint16':
      rawValue = length === 2 ? buffer.readUInt16BE(offset) : buffer.readUInt8(offset);
      if (tagDef.min !== undefined) {
        return decodeIMAPB(rawValue, 16, tagDef.min, tagDef.max);
      }
      break;
    case 'uint32':
      rawValue = length === 4 ? buffer.readUInt32BE(offset) :
                 length === 2 ? buffer.readUInt16BE(offset) : buffer.readUInt8(offset);
      if (tagDef.min !== undefined) {
        return decodeIMAPB(rawValue, 32, tagDef.min, tagDef.max);
      }
      break;
    case 'imapb16':
      rawValue = length === 2 ? buffer.readUInt16BE(offset) : buffer.readUInt8(offset);
      return decodeIMAPB(rawValue, 16, tagDef.min, tagDef.max);
    case 'imapb32':
      rawValue = length === 4 ? buffer.readUInt32BE(offset) :
                 length === 2 ? buffer.readUInt16BE(offset) : buffer.readUInt8(offset);
      return decodeIMAPB(rawValue, 32, tagDef.min, tagDef.max);
    case 'uint64':
      rawValue = buffer.readBigUInt64BE(offset);
      return Number(rawValue);
    case 'string':
      return buffer.subarray(offset, offset + length).toString('utf8').replace(/\0/g, '');
    case 'hex':
      return buffer.subarray(offset, offset + length).toString('hex');
    default:
      return buffer.subarray(offset, offset + length).toString('hex');
  }

  return rawValue;
}

/**
 * Parse KLV Local Set (nested tags inside UAS Local Set)
 * @param {Buffer} buffer
 * @returns {object}
 */
function parseLocalSet(buffer) {
  const result = {};
  let offset = 0;

  while (offset < buffer.length - 2) {
    const tag = buffer[offset];
    offset++;

    const { length, bytesRead } = decodeBERLength(buffer, offset);
    offset += bytesRead;

    if (offset + length > buffer.length) break;

    const tagDef = TAGS[tag];
    const value = readValue(buffer, offset, length, tagDef);

    if (tagDef) {
      result[tagDef.name] = value;
    } else {
      result[`tag_${tag}`] = value;
    }

    offset += length;
  }

  return result;
}

/**
 * Check if buffer starts with UAS Local Set key
 * @param {Buffer} buffer
 * @param {number} offset
 * @returns {boolean}
 */
function isUASLocalSet(buffer, offset = 0) {
  if (offset + 16 > buffer.length) return false;
  return buffer.subarray(offset, offset + 16).equals(UAS_LOCAL_SET_KEY);
}

/**
 * Parse KLV packet(s) from buffer
 * @param {Buffer} buffer
 * @returns {{ packets: object[], consumed: number }}
 */
export function parseKLV(buffer) {
  const packets = [];
  let offset = 0;
  let lastCompletePacketEnd = 0;

  while (offset < buffer.length) {
    // Look for UAS Local Set key
    if (!isUASLocalSet(buffer, offset)) {
      offset++;
      continue;
    }

    const packetStart = offset;
    offset += 16; // Skip key

    if (offset >= buffer.length) break;

    const { length, bytesRead } = decodeBERLength(buffer, offset);
    offset += bytesRead;

    if (offset + length > buffer.length) {
      // Incomplete packet, rewind
      offset = packetStart;
      break;
    }

    const payload = buffer.subarray(offset, offset + length);
    const parsed = parseLocalSet(payload);

    if (Object.keys(parsed).length > 0) {
      packets.push(parsed);
    }

    offset += length;
    lastCompletePacketEnd = offset;
  }

  return { packets, consumed: lastCompletePacketEnd };
}

/**
 * Convert meters to feet
 */
function metersToFeet(m) {
  return m != null ? Math.round(m * 3.28084) : null;
}

/**
 * Format parsed KLV for display
 * @param {object} klv
 * @returns {object}
 */
export function formatKLVForDisplay(klv) {
  const sensorAltM = klv.sensorAltitude;
  const frameCenterElevM = klv.frameCenterElevation;
  const slantRangeM = klv.slantRange;

  return {
    // Timestamp
    timestamp: klv.precisionTimeStamp ? new Date(klv.precisionTimeStamp / 1000).toISOString() : null,
    unixTimestamp: klv.precisionTimeStamp ? Math.floor(klv.precisionTimeStamp / 1000000) : null,

    // Mission info
    mission: {
      id: klv.missionId,
      tailNumber: klv.platformTailNumber,
      platformDesignation: klv.platformDesignation,
      sensorName: klv.sensorName,
      callSign: klv.platformCallSign,
      imageSource: klv.imageSourceSensor
    },

    // Platform (aircraft) state
    platform: {
      heading: klv.platformHeading,
      pitch: klv.platformPitch,
      roll: klv.platformRoll,
      trueAirspeed: klv.platformTrueAirspeed,
      indicatedAirspeed: klv.platformIndicatedAirspeed,
      groundSpeed: klv.platformGroundSpeed,
      verticalSpeed: klv.platformVerticalSpeed
    },

    // Sensor position and orientation
    sensor: {
      latitude: klv.sensorLatitude,
      longitude: klv.sensorLongitude,
      altitudeM: sensorAltM,
      altitudeFt: metersToFeet(sensorAltM),
      hfov: klv.sensorHFOV,
      vfov: klv.sensorVFOV,
      azimuth: klv.sensorRelativeAzimuth,
      elevation: klv.sensorRelativeElevation,
      roll: klv.sensorRelativeRoll
    },

    // Frame center (target point)
    target: {
      latitude: klv.frameCenterLatitude,
      longitude: klv.frameCenterLongitude,
      elevationM: frameCenterElevM,
      elevationFt: metersToFeet(frameCenterElevM),
      slantRangeM: slantRangeM,
      slantRangeFt: metersToFeet(slantRangeM),
      groundRange: klv.groundRange,
      width: klv.targetWidth
    },

    // Image corner coordinates
    corners: (klv.cornerLatPt1 != null) ? [
      { lat: klv.cornerLatPt1, lon: klv.cornerLonPt1 },
      { lat: klv.cornerLatPt2, lon: klv.cornerLonPt2 },
      { lat: klv.cornerLatPt3, lon: klv.cornerLonPt3 },
      { lat: klv.cornerLatPt4, lon: klv.cornerLonPt4 }
    ] : null,

    raw: klv
  };
}

export default { parseKLV, formatKLVForDisplay };
