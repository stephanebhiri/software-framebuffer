/**
 * MPEG-2 Transport Stream Muxer with KLV support
 * Creates TS packets with video (PID 256) and KLV data (PID 258)
 */

const TS_PACKET_SIZE = 188;
const TS_SYNC_BYTE = 0x47;

// PIDs (matching Day_Flight.mpg sample)
export const PID_PAT = 0x0000;
export const PID_PMT = 0x0100;  // 256
export const PID_VIDEO = 0x01e1; // 481 (0x1e1)
export const PID_KLV = 0x01f1;   // 497 (0x1f1) - KLV data stream

// Stream types
const STREAM_TYPE_H264 = 0x1b;
const STREAM_TYPE_KLV = 0x06; // Private data

let continuityCounters = {
  [PID_PAT]: 0,
  [PID_PMT]: 0,
  [PID_VIDEO]: 0,
  [PID_KLV]: 0
};

/**
 * Calculate CRC32 for PSI tables
 */
function crc32(data) {
  const CRC32_TABLE = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let j = 0; j < 8; j++) {
      c = (c << 1) ^ ((c & 0x80000000) ? 0x04c11db7 : 0);
    }
    CRC32_TABLE[i] = c >>> 0;
  }

  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (crc << 8) ^ CRC32_TABLE[((crc >>> 24) ^ byte) & 0xff];
  }
  return crc >>> 0;
}

/**
 * Create a TS packet
 */
function createTSPacket(pid, payload, options = {}) {
  const {
    payloadUnitStart = false,
    adaptationField = null,
    randomAccess = false
  } = options;

  const packet = Buffer.alloc(TS_PACKET_SIZE, 0xff);
  let offset = 0;

  // Sync byte
  packet[offset++] = TS_SYNC_BYTE;

  // PID and flags
  const pidHigh = (pid >> 8) & 0x1f;
  const pidLow = pid & 0xff;
  packet[offset++] = (payloadUnitStart ? 0x40 : 0x00) | pidHigh;
  packet[offset++] = pidLow;

  // Adaptation field control and continuity counter
  let adaptationFieldControl = 0x01; // Payload only
  if (adaptationField || randomAccess) {
    adaptationFieldControl = 0x03; // Adaptation + payload
  }

  const cc = continuityCounters[pid] || 0;
  continuityCounters[pid] = (cc + 1) & 0x0f;
  packet[offset++] = (adaptationFieldControl << 4) | cc;

  // Adaptation field
  if (adaptationFieldControl === 0x03) {
    const afLength = randomAccess ? 1 : (adaptationField ? adaptationField.length : 0);
    packet[offset++] = afLength;
    if (randomAccess) {
      packet[offset++] = 0x40; // Random access indicator
    } else if (adaptationField) {
      adaptationField.copy(packet, offset);
      offset += adaptationField.length;
    }
  }

  // Payload
  if (payload) {
    const maxPayload = TS_PACKET_SIZE - offset;
    const copyLen = Math.min(payload.length, maxPayload);
    payload.copy(packet, offset, 0, copyLen);
  }

  return packet;
}

/**
 * Create PAT (Program Association Table)
 */
export function createPAT() {
  const patData = Buffer.alloc(17);
  let offset = 0;

  patData[offset++] = 0x00; // Pointer field
  patData[offset++] = 0x00; // Table ID (PAT)
  patData[offset++] = 0xb0; // Section syntax + length high
  patData[offset++] = 0x0d; // Section length low (13 bytes)
  patData[offset++] = 0x00; // Transport stream ID high
  patData[offset++] = 0x01; // Transport stream ID low
  patData[offset++] = 0xc1; // Version + current/next
  patData[offset++] = 0x00; // Section number
  patData[offset++] = 0x00; // Last section number
  patData[offset++] = 0x00; // Program number high
  patData[offset++] = 0x01; // Program number low
  patData[offset++] = 0xe1; // PMT PID high (with reserved bits)
  patData[offset++] = 0x00; // PMT PID low (256)

  // CRC32
  const crc = crc32(patData.subarray(1, offset));
  patData.writeUInt32BE(crc, offset);

  return createTSPacket(PID_PAT, patData, { payloadUnitStart: true });
}

/**
 * Create PMT (Program Map Table) with KLV stream
 */
export function createPMT() {
  const pmtData = Buffer.alloc(32);
  let offset = 0;

  pmtData[offset++] = 0x00; // Pointer field
  pmtData[offset++] = 0x02; // Table ID (PMT)
  pmtData[offset++] = 0xb0; // Section syntax + length high
  pmtData[offset++] = 0x17; // Section length (23 bytes)
  pmtData[offset++] = 0x00; // Program number high
  pmtData[offset++] = 0x01; // Program number low
  pmtData[offset++] = 0xc1; // Version + current/next
  pmtData[offset++] = 0x00; // Section number
  pmtData[offset++] = 0x00; // Last section number
  pmtData[offset++] = 0xe1; // PCR PID high
  pmtData[offset++] = 0x01; // PCR PID low (257 = video)
  pmtData[offset++] = 0xf0; // Program info length high
  pmtData[offset++] = 0x00; // Program info length low

  // Video stream (PID 0x1e1 = 481)
  pmtData[offset++] = STREAM_TYPE_H264;
  pmtData[offset++] = 0xe1; // PID high (0x1e1)
  pmtData[offset++] = 0xe1; // PID low
  pmtData[offset++] = 0xf0; // ES info length high
  pmtData[offset++] = 0x00; // ES info length low

  // KLV data stream (PID 0x1f1 = 497)
  pmtData[offset++] = STREAM_TYPE_KLV;
  pmtData[offset++] = 0xe1; // PID high (0x1f1)
  pmtData[offset++] = 0xf1; // PID low
  pmtData[offset++] = 0xf0; // ES info length high
  pmtData[offset++] = 0x00; // ES info length low

  // CRC32
  const crc = crc32(pmtData.subarray(1, offset));
  pmtData.writeUInt32BE(crc, offset);

  return createTSPacket(PID_PMT, pmtData, { payloadUnitStart: true });
}

/**
 * Create KLV data packets
 * @param {Buffer} klvData - KLV payload
 * @returns {Buffer[]} - Array of TS packets
 */
export function createKLVPackets(klvData) {
  const packets = [];

  // Create PES header for KLV
  const pesHeader = Buffer.alloc(14);
  let offset = 0;

  pesHeader[offset++] = 0x00; // Packet start code prefix
  pesHeader[offset++] = 0x00;
  pesHeader[offset++] = 0x01;
  pesHeader[offset++] = 0xbd; // Private stream 1 (for KLV)

  const pesLength = klvData.length + 8; // Payload + PES header extension
  pesHeader[offset++] = (pesLength >> 8) & 0xff;
  pesHeader[offset++] = pesLength & 0xff;

  pesHeader[offset++] = 0x80; // PES header flags
  pesHeader[offset++] = 0x80; // PTS present
  pesHeader[offset++] = 0x05; // PES header data length

  // PTS (current time)
  const pts = BigInt(Date.now()) * 90n; // 90kHz clock
  pesHeader[offset++] = 0x21 | Number((pts >> 29n) & 0x0en);
  pesHeader[offset++] = Number((pts >> 22n) & 0xffn);
  pesHeader[offset++] = 0x01 | Number((pts >> 14n) & 0xfen);
  pesHeader[offset++] = Number((pts >> 7n) & 0xffn);
  pesHeader[offset++] = 0x01 | Number((pts << 1n) & 0xfen);

  const fullPayload = Buffer.concat([pesHeader, klvData]);

  // Split into TS packets
  let remaining = fullPayload;
  let first = true;

  while (remaining.length > 0) {
    const maxPayload = first ? 184 - 1 : 184; // Account for adaptation field
    const chunkSize = Math.min(remaining.length, maxPayload);
    const chunk = remaining.subarray(0, chunkSize);
    remaining = remaining.subarray(chunkSize);

    const packet = createTSPacket(PID_KLV, chunk, {
      payloadUnitStart: first,
      randomAccess: first
    });
    packets.push(packet);
    first = false;
  }

  return packets;
}

/**
 * Create a null packet (for padding/timing)
 */
export function createNullPacket() {
  const packet = Buffer.alloc(TS_PACKET_SIZE, 0xff);
  packet[0] = TS_SYNC_BYTE;
  packet[1] = 0x1f;
  packet[2] = 0xff;
  packet[3] = 0x10;
  return packet;
}

export default {
  createPAT,
  createPMT,
  createKLVPackets,
  createNullPacket,
  PID_VIDEO,
  PID_KLV
};
