/**
 * UDP KLV Splitter
 * Receives UDP MPEG-TS, extracts KLV metadata, forwards stream to FrameSync
 *
 * Dynamically detects KLV PIDs from PMT (no hardcoded list)
 */
import dgram from 'dgram';
import { EventEmitter } from 'events';

// SMPTE 336M UAS Local Set key
const UAS_KEY = Buffer.from([
  0x06, 0x0E, 0x2B, 0x34, 0x02, 0x0B, 0x01, 0x01,
  0x0E, 0x01, 0x03, 0x01, 0x01, 0x00, 0x00, 0x00
]);

// KLVA registration descriptor identifier
const KLVA_ID = 0x4B4C5641; // "KLVA" in ASCII

export class UDPKLVSplitter extends EventEmitter {
  constructor() {
    super();
    this.server = null;
    this.forwardSocket = null;
    this.isRunning = false;
    this.inputPort = 5000;
    this.outputPort = 5001;
    this.outputHost = '127.0.0.1';

    // PMT/PAT parsing state
    this.pmtPid = null;
    this.pmtVersion = -1;
    this.pmtKey = null; // CRC-based key for detecting PMT content changes
    this.patVersion = -1;
    this.transportStreamId = null; // Track TSID for source change detection
    this.klvPids = new Set();
    this.patBuffer = null;
    this.pmtBuffer = null;

    // PES assembly buffers per PID
    this.pesBuffers = new Map();
    this.stats = { packets: 0, klvPackets: 0 };

    // Gap detection for stream changes
    this.lastPacketTime = 0;
    this.gapThreshold = 500; // Reset if no packets for 500ms
  }

  /**
   * Start the splitter
   */
  async start(options = {}) {
    if (this.isRunning) return;

    this.inputPort = options.inputPort || 5000;
    this.outputPort = options.outputPort || 5001;
    this.outputHost = options.outputHost || '127.0.0.1';

    // Reset state
    this.pmtPid = null;
    this.pmtVersion = -1;
    this.pmtKey = null;
    this.patVersion = -1;
    this.transportStreamId = null;
    this.klvPids.clear();
    this.pesBuffers.clear();
    this.stats = { packets: 0, klvPackets: 0 };

    // Create receiving socket
    this.server = dgram.createSocket('udp4');

    // Create forwarding socket
    this.forwardSocket = dgram.createSocket('udp4');

    this.server.on('message', (msg) => {
      this.stats.packets++;

      // Forward immediately (low latency)
      this.forwardSocket.send(msg, 0, msg.length, this.outputPort, this.outputHost);

      // Extract KLV in parallel (non-blocking)
      this._processTS(msg);
    });

    this.server.on('error', (err) => {
      console.error('UDP Splitter error:', err.message);
      this.emit('error', err);
    });

    return new Promise((resolve, reject) => {
      this.server.bind(this.inputPort, () => {
        this.isRunning = true;
        console.log(`UDP KLV Splitter: ${this.inputPort} -> ${this.outputHost}:${this.outputPort}`);
        console.log(`UDP KLV Splitter: Dynamic PID detection via PMT`);
        this.emit('started');
        resolve();
      });
    });
  }

  /**
   * Process TS packets
   */
  _processTS(buffer) {
    const now = Date.now();

    // Detect stream gap (source switch)
    if (this.lastPacketTime > 0 && now - this.lastPacketTime > this.gapThreshold) {
      console.log(`[PMT] Stream gap detected (${now - this.lastPacketTime}ms), resetting state`);
      this.pmtPid = null;
      this.pmtVersion = -1;
      this.pmtKey = null;
      this.patVersion = -1;
      this.transportStreamId = null;
      this.pmtBuffer = null;
      this.klvPids.clear();
      this.pesBuffers.clear();
    }
    this.lastPacketTime = now;

    let offset = 0;

    while (offset + 188 <= buffer.length) {
      // Find sync byte
      if (buffer[offset] !== 0x47) {
        offset++;
        continue;
      }

      const packet = buffer.slice(offset, offset + 188);
      offset += 188;

      // Parse TS header
      const pid = ((packet[1] & 0x1F) << 8) | packet[2];
      const pusi = (packet[1] & 0x40) !== 0;
      const adaptation = (packet[3] & 0x30) >> 4;

      // Calculate payload offset
      let payloadStart = 4;
      if (adaptation === 2 || adaptation === 3) {
        if (packet[4] > 182) continue;
        payloadStart = 5 + packet[4];
      }
      if (payloadStart >= 188) continue;

      const payload = packet.slice(payloadStart);
      if (payload.length === 0) continue;

      // PAT (Program Association Table) - PID 0x0000
      if (pid === 0x0000) {
        this._processPAT(payload, pusi);
        continue;
      }

      // PMT (Program Map Table) - may span multiple TS packets
      if (pid === this.pmtPid) {
        if (pusi) {
          // New section starts - buffer always begins with pointer field
          this.pmtBuffer = payload;
        } else if (this.pmtBuffer) {
          // Continue accumulating PMT data
          this.pmtBuffer = Buffer.concat([this.pmtBuffer, payload]);
        }
        // Only parse when we have complete section
        if (this.pmtBuffer && this.pmtBuffer.length >= 4) {
          // pmtBuffer always starts with pointer field (from pusi packet)
          const pointerField = this.pmtBuffer[0];
          const data = this.pmtBuffer.slice(1 + pointerField);

          if (data.length >= 3 && data[0] === 0x02) {
            const sectionLength = ((data[1] & 0x0F) << 8) | data[2];
            // Wait for complete section (section_length + 3 header bytes)
            if (data.length >= sectionLength + 3) {
              this._processPMT(this.pmtBuffer, true);
            }
          }
        }
        continue;
      }

      // KLV data
      if (this.klvPids.has(pid)) {
        this._processKLV(packet, pid, pusi, payload);
      }
    }
  }

  /**
   * Parse PAT to find PMT PID
   */
  _processPAT(payload, pusi) {
    let data = payload;

    // Handle pointer field for PUSI
    if (pusi && payload.length > 0) {
      const pointerField = payload[0];
      data = payload.slice(1 + pointerField);
    }

    if (data.length < 8) return;

    // Check table_id = 0x00 (PAT)
    if (data[0] !== 0x00) return;

    const sectionLength = ((data[1] & 0x0F) << 8) | data[2];
    const patVersion = (data[5] >> 1) & 0x1F;
    const transportStreamId = (data[3] << 8) | data[4];

    if (data.length < 8 + sectionLength - 5) return;

    // Detect stream change via transport_stream_id (most reliable for source switching)
    // This works even when switching quickly between sources without a gap
    const tsidChanged = (this.transportStreamId !== null && transportStreamId !== this.transportStreamId);
    const streamChanged = tsidChanged || (patVersion !== this.patVersion);

    if (tsidChanged) {
      console.log(`[PMT] Source change detected: TSID ${this.transportStreamId} -> ${transportStreamId}`);
      // Full reset on TSID change
      this.pmtVersion = -1;
      this.pmtKey = null;
      this.pmtBuffer = null;
      this.klvPids.clear();
      this.pesBuffers.clear();
    }

    this.transportStreamId = transportStreamId;
    this.patVersion = patVersion;

    // Skip to program entries (after 8 byte header)
    let offset = 8;
    const endOffset = 3 + sectionLength - 4; // -4 for CRC

    while (offset + 4 <= endOffset && offset + 4 <= data.length) {
      const programNum = (data[offset] << 8) | data[offset + 1];
      const pmtPid = ((data[offset + 2] & 0x1F) << 8) | data[offset + 3];

      // Program 0 is NIT, skip it
      if (programNum !== 0) {
        // Reset if PMT PID changed OR stream changed (new source)
        if (pmtPid !== this.pmtPid || streamChanged) {
          this.pmtPid = pmtPid;
          this.pmtVersion = -1; // Force re-parsing of PMT
          this.pmtKey = null;
          this.pmtBuffer = null;
          this.klvPids.clear();
          this.pesBuffers.clear();
          console.log(`[PMT] PAT parsed: PMT PID = 0x${pmtPid.toString(16)} (PAT v${patVersion}, TSID=${transportStreamId})`);
        }
      }
      offset += 4;
    }
  }

  /**
   * Parse PMT to find KLV PIDs
   */
  _processPMT(payload, pusi) {
    let data = payload;

    // Handle pointer field for PUSI
    if (pusi && payload.length > 0) {
      const pointerField = payload[0];
      data = payload.slice(1 + pointerField);
    }

    if (data.length < 12) return;

    // Check table_id = 0x02 (PMT)
    if (data[0] !== 0x02) return;

    const sectionLength = ((data[1] & 0x0F) << 8) | data[2];
    const programNumber = (data[3] << 8) | data[4];
    const version = (data[5] >> 1) & 0x1F;

    // Use CRC32 at end of section as a unique identifier for this exact PMT content
    // This handles cases where different sources have same version but different content
    const crcOffset = 3 + sectionLength - 4;
    const pmtCrc = (crcOffset + 4 <= data.length)
      ? data.readUInt32BE(crcOffset)
      : 0;

    // Skip if same PMT content (same version AND same CRC)
    // This ensures we re-parse if PMT content changes, even with same version
    const pmtKey = `${programNumber}:${version}:${pmtCrc}`;
    if (pmtKey === this.pmtKey) return;

    console.log(`[PMT] Parsing PMT: program=${programNumber}, v${version}, CRC=0x${pmtCrc.toString(16)}`);
    this.pmtKey = pmtKey;
    this.pmtVersion = version;

    const programInfoLength = ((data[10] & 0x0F) << 8) | data[11];

    // Start of stream entries
    let offset = 12 + programInfoLength;
    const endOffset = 3 + sectionLength - 4; // -4 for CRC

    const newKlvPids = new Set();
    const dataPids = []; // Track all data stream PIDs for fallback

    while (offset + 5 <= endOffset && offset + 5 <= data.length) {
      const streamType = data[offset];
      const elementaryPid = ((data[offset + 1] & 0x1F) << 8) | data[offset + 2];
      const esInfoLength = ((data[offset + 3] & 0x0F) << 8) | data[offset + 4];

      // Check if this is a KLV stream
      // stream_type: 0x06 (private), 0x15 (PES metadata), 0x21 (KLVA in some implementations)
      const isDataStream = (streamType === 0x06 || streamType === 0x15 || streamType === 0x21);

      if (isDataStream) {
        dataPids.push(elementaryPid);

        // Parse descriptors to find KLVA registration
        let descOffset = offset + 5;
        const descEnd = descOffset + esInfoLength;
        let isKLVA = false;

        while (descOffset + 2 <= descEnd && descOffset + 2 <= data.length) {
          const descTag = data[descOffset];
          const descLen = data[descOffset + 1];

          if (descOffset + 2 + descLen > data.length) break;

          // Registration descriptor (tag 0x05)
          if (descTag === 0x05 && descLen >= 4) {
            const formatId = data.readUInt32BE(descOffset + 2);
            if (formatId === KLVA_ID) {
              isKLVA = true;
              break;
            }
          }

          // Also check for metadata descriptor (tag 0x26)
          // or private data indicator (tag 0x0F)
          if (descTag === 0x26 || descTag === 0x0F) {
            // Some streams mark KLVA this way
            isKLVA = true;
          }

          descOffset += 2 + descLen;
        }

        if (isKLVA) {
          newKlvPids.add(elementaryPid);
        }
      }

      offset += 5 + esInfoLength;
    }

    // Fallback: if no KLVA descriptors found, assume all data streams are KLV
    // (ffmpeg may strip registration descriptors during transcoding)
    if (newKlvPids.size === 0 && dataPids.length > 0) {
      console.log(`[PMT] No KLVA descriptors found, using all data PIDs as fallback: ${dataPids.map(p => '0x' + p.toString(16)).join(', ')}`);
      dataPids.forEach(pid => newKlvPids.add(pid));
    }

    // Update KLV PIDs if changed
    if (!this._setsEqual(newKlvPids, this.klvPids)) {
      this.klvPids = newKlvPids;
      this.pesBuffers.clear(); // Clear buffers on PID change

      if (newKlvPids.size > 0) {
        const pidsStr = [...newKlvPids].map(p => '0x' + p.toString(16)).join(', ');
        console.log(`[PMT] KLV PIDs detected: ${pidsStr}`);
        this.emit('klv-pids', [...newKlvPids]);
      } else {
        console.log(`[PMT] No KLV PIDs found in stream`);
      }
    }
  }

  /**
   * Process KLV PES packets
   */
  _processKLV(packet, pid, pusi, payload) {
    // Assemble PES
    if (pusi) {
      // New PES - process previous if exists
      if (this.pesBuffers.has(pid)) {
        this._extractKLV(this.pesBuffers.get(pid), pid);
      }
      this.pesBuffers.set(pid, payload);
    } else if (this.pesBuffers.has(pid)) {
      // Continue PES
      const existing = this.pesBuffers.get(pid);
      if (existing.length < 65536) {
        this.pesBuffers.set(pid, Buffer.concat([existing, payload]));
      }
    }
  }

  /**
   * Extract KLV from PES packet
   */
  _extractKLV(pesData, pid) {
    if (pesData.length < 9) return;

    // Check PES start code
    if (pesData[0] !== 0x00 || pesData[1] !== 0x00 || pesData[2] !== 0x01) return;

    // Get PES header length
    const headerLen = 9 + (pesData.length > 8 ? pesData[8] : 0);
    if (pesData.length <= headerLen) return;

    const klvData = pesData.slice(headerLen);

    // Check for UAS key
    if (klvData.length >= 16 && klvData.slice(0, 16).equals(UAS_KEY)) {
      this.stats.klvPackets++;
      if (this.stats.klvPackets <= 3 || this.stats.klvPackets % 100 === 0) {
        console.log(`UDP Splitter: KLV packet #${this.stats.klvPackets} from PID 0x${pid.toString(16)} (${klvData.length} bytes)`);
      }
      // Emit KLV data with PID for multi-sensor tracking
      this.emit('klv', { data: klvData, pid });
    }
  }

  /**
   * Compare two Sets for equality
   */
  _setsEqual(a, b) {
    if (a.size !== b.size) return false;
    for (const item of a) {
      if (!b.has(item)) return false;
    }
    return true;
  }

  /**
   * Stop the splitter
   */
  async stop() {
    if (!this.isRunning) return;

    this.isRunning = false;

    if (this.server) {
      this.server.close();
      this.server = null;
    }

    if (this.forwardSocket) {
      this.forwardSocket.close();
      this.forwardSocket = null;
    }

    this.pesBuffers.clear();
    this.klvPids.clear();
    this.pmtPid = null;
    this.pmtVersion = -1;
    this.pmtKey = null;
    this.patVersion = -1;
    this.transportStreamId = null;
    this.pmtBuffer = null;

    console.log(`UDP KLV Splitter stopped (${this.stats.klvPackets} KLV packets extracted)`);
    this.emit('stopped');
  }

  getStats() {
    return { ...this.stats, klvPids: [...this.klvPids] };
  }
}

export default UDPKLVSplitter;
