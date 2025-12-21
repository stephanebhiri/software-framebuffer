/**
 * KLV Encoder for MISB ST 0601 (UAS Datalink Local Set)
 * Generates valid STANAG 4609 KLV metadata packets
 */

// UAS Local Set Universal Key (MISB 0601)
const UAS_LOCAL_SET_KEY = Buffer.from([
  0x06, 0x0e, 0x2b, 0x34, 0x02, 0x0b, 0x01, 0x01,
  0x0e, 0x01, 0x03, 0x01, 0x01, 0x00, 0x00, 0x00
]);

/**
 * Encode BER length
 */
function encodeBERLength(length) {
  if (length < 128) {
    return Buffer.from([length]);
  } else if (length < 256) {
    return Buffer.from([0x81, length]);
  } else if (length < 65536) {
    return Buffer.from([0x82, (length >> 8) & 0xff, length & 0xff]);
  } else {
    return Buffer.from([0x83, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff]);
  }
}

/**
 * IMAPB encoding - map real value to unsigned integer
 */
function encodeIMAPB(value, bits, min, max) {
  const maxRaw = Math.pow(2, bits) - 1;
  const range = max - min;
  const normalized = (value - min) / range;
  const raw = Math.round(normalized * (maxRaw - 1));
  return Math.max(1, Math.min(maxRaw - 1, raw)); // Avoid 0 and maxRaw (out of range markers)
}

/**
 * Encode a single KLV tag
 */
function encodeTag(tag, value, type, options = {}) {
  const tagBuf = Buffer.from([tag]);
  let valueBuf;

  switch (type) {
    case 'uint8':
      valueBuf = Buffer.alloc(1);
      valueBuf.writeUInt8(value);
      break;
    case 'uint16':
      valueBuf = Buffer.alloc(2);
      valueBuf.writeUInt16BE(value);
      break;
    case 'uint32':
      valueBuf = Buffer.alloc(4);
      valueBuf.writeUInt32BE(value);
      break;
    case 'uint64':
      valueBuf = Buffer.alloc(8);
      valueBuf.writeBigUInt64BE(BigInt(value));
      break;
    case 'imapb16':
      valueBuf = Buffer.alloc(2);
      valueBuf.writeUInt16BE(encodeIMAPB(value, 16, options.min, options.max));
      break;
    case 'imapb32':
      valueBuf = Buffer.alloc(4);
      valueBuf.writeUInt32BE(encodeIMAPB(value, 32, options.min, options.max));
      break;
    case 'string':
      valueBuf = Buffer.from(value, 'utf8');
      break;
    default:
      valueBuf = Buffer.from(value);
  }

  const lengthBuf = encodeBERLength(valueBuf.length);
  return Buffer.concat([tagBuf, lengthBuf, valueBuf]);
}

/**
 * Encode a complete MISB 0601 KLV packet
 * @param {object} metadata - Metadata values
 * @returns {Buffer} - Complete KLV packet with UAS Local Set wrapper
 */
export function encodeKLVPacket(metadata) {
  const tags = [];

  // Tag 2: Precision Timestamp (microseconds since Unix epoch)
  if (metadata.timestamp) {
    tags.push(encodeTag(2, metadata.timestamp, 'uint64'));
  }

  // Tag 3: Mission ID
  if (metadata.missionId) {
    tags.push(encodeTag(3, metadata.missionId, 'string'));
  }

  // Tag 5: Platform Heading (0-360)
  if (metadata.platformHeading !== undefined) {
    tags.push(encodeTag(5, metadata.platformHeading, 'imapb16', { min: 0, max: 360 }));
  }

  // Tag 6: Platform Pitch (-20 to 20)
  if (metadata.platformPitch !== undefined) {
    tags.push(encodeTag(6, metadata.platformPitch, 'imapb16', { min: -20, max: 20 }));
  }

  // Tag 7: Platform Roll (-50 to 50)
  if (metadata.platformRoll !== undefined) {
    tags.push(encodeTag(7, metadata.platformRoll, 'imapb16', { min: -50, max: 50 }));
  }

  // Tag 13: Sensor Latitude (-90 to 90)
  if (metadata.sensorLatitude !== undefined) {
    tags.push(encodeTag(13, metadata.sensorLatitude, 'imapb32', { min: -90, max: 90 }));
  }

  // Tag 14: Sensor Longitude (-180 to 180)
  if (metadata.sensorLongitude !== undefined) {
    tags.push(encodeTag(14, metadata.sensorLongitude, 'imapb32', { min: -180, max: 180 }));
  }

  // Tag 15: Sensor Altitude (-900 to 19000)
  if (metadata.sensorAltitude !== undefined) {
    tags.push(encodeTag(15, metadata.sensorAltitude, 'imapb16', { min: -900, max: 19000 }));
  }

  // Tag 16: Sensor HFOV (0-180)
  if (metadata.sensorHFOV !== undefined) {
    tags.push(encodeTag(16, metadata.sensorHFOV, 'imapb16', { min: 0, max: 180 }));
  }

  // Tag 17: Sensor VFOV (0-180)
  if (metadata.sensorVFOV !== undefined) {
    tags.push(encodeTag(17, metadata.sensorVFOV, 'imapb16', { min: 0, max: 180 }));
  }

  // Tag 18: Sensor Relative Azimuth (0-360)
  if (metadata.sensorAzimuth !== undefined) {
    tags.push(encodeTag(18, metadata.sensorAzimuth, 'imapb32', { min: 0, max: 360 }));
  }

  // Tag 19: Sensor Relative Elevation (-180 to 180)
  if (metadata.sensorElevation !== undefined) {
    tags.push(encodeTag(19, metadata.sensorElevation, 'imapb32', { min: -180, max: 180 }));
  }

  // Tag 21: Slant Range (0 to 5000000 meters)
  if (metadata.slantRange !== undefined) {
    tags.push(encodeTag(21, metadata.slantRange, 'imapb32', { min: 0, max: 5000000 }));
  }

  // Tag 23: Frame Center Latitude (-90 to 90)
  if (metadata.targetLatitude !== undefined) {
    tags.push(encodeTag(23, metadata.targetLatitude, 'imapb32', { min: -90, max: 90 }));
  }

  // Tag 24: Frame Center Longitude (-180 to 180)
  if (metadata.targetLongitude !== undefined) {
    tags.push(encodeTag(24, metadata.targetLongitude, 'imapb32', { min: -180, max: 180 }));
  }

  // Tag 25: Frame Center Elevation (-900 to 19000)
  if (metadata.targetElevation !== undefined) {
    tags.push(encodeTag(25, metadata.targetElevation, 'imapb16', { min: -900, max: 19000 }));
  }

  // Concatenate all tags
  const payload = Buffer.concat(tags);
  const lengthBuf = encodeBERLength(payload.length);

  return Buffer.concat([UAS_LOCAL_SET_KEY, lengthBuf, payload]);
}

export default { encodeKLVPacket };
