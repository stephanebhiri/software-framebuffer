/**
 * UDP KLV Splitter
 * Receives UDP MPEG-TS, extracts KLV metadata, forwards stream to FrameSync
 */
import dgram from 'dgram';
import { EventEmitter } from 'events';

// SMPTE 336M UAS Local Set key
const UAS_KEY = Buffer.from([
  0x06, 0x0E, 0x2B, 0x34, 0x02, 0x0B, 0x01, 0x01,
  0x0E, 0x01, 0x03, 0x01, 0x01, 0x00, 0x00, 0x00
]);

// Common KLV PIDs in STANAG 4609
const KLV_PIDS = new Set([0x0042, 0x0044, 0x0100, 0x0101, 0x0102, 0x01f1, 0x1000]);

export class UDPKLVSplitter extends EventEmitter {
  constructor() {
    super();
    this.server = null;
    this.forwardSocket = null;
    this.isRunning = false;
    this.inputPort = 5000;
    this.outputPort = 5001;
    this.outputHost = '127.0.0.1';

    // PES assembly buffers per PID
    this.pesBuffers = new Map();
    this.stats = { packets: 0, klvPackets: 0 };
  }

  /**
   * Start the splitter
   */
  async start(options = {}) {
    if (this.isRunning) return;

    this.inputPort = options.inputPort || 5000;
    this.outputPort = options.outputPort || 5001;
    this.outputHost = options.outputHost || '127.0.0.1';

    // Create receiving socket
    this.server = dgram.createSocket('udp4');

    // Create forwarding socket
    this.forwardSocket = dgram.createSocket('udp4');

    this.server.on('message', (msg) => {
      this.stats.packets++;

      // Log first packet and every 1000 packets
      if (this.stats.packets === 1 || this.stats.packets % 1000 === 0) {
        console.log(`UDP Splitter: ${this.stats.packets} packets, forwarding ${msg.length} bytes`);
      }

      // Extract KLV from TS packets
      this._processTS(msg);

      // Forward entire packet to FrameSync
      this.forwardSocket.send(msg, this.outputPort, this.outputHost, (err) => {
        if (err && this.stats.packets < 5) {
          console.error('UDP Splitter forward error:', err.message);
        }
      });
    });

    this.server.on('error', (err) => {
      console.error('UDP Splitter error:', err.message);
      this.emit('error', err);
    });

    return new Promise((resolve, reject) => {
      this.server.bind(this.inputPort, () => {
        this.isRunning = true;
        console.log(`UDP KLV Splitter: ${this.inputPort} -> ${this.outputHost}:${this.outputPort}`);
        this.emit('started');
        resolve();
      });
    });
  }

  /**
   * Process TS packets and extract KLV
   */
  _processTS(buffer) {
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

      // Only process KLV PIDs
      if (!KLV_PIDS.has(pid)) continue;

      const pusi = (packet[1] & 0x40) !== 0;
      const adaptation = (packet[3] & 0x30) >> 4;

      // Calculate payload offset
      let payloadStart = 4;
      if (adaptation === 2 || adaptation === 3) {
        payloadStart = 5 + packet[4];
      }
      if (payloadStart >= 188) continue;

      const payload = packet.slice(payloadStart);

      // Assemble PES
      if (pusi) {
        // New PES - process previous if exists
        if (this.pesBuffers.has(pid)) {
          this._extractKLV(this.pesBuffers.get(pid));
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
  }

  /**
   * Extract KLV from PES packet
   */
  _extractKLV(pesData) {
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
        console.log(`UDP Splitter: KLV packet #${this.stats.klvPackets} (${klvData.length} bytes)`);
      }
      this.emit('klv', klvData);
    }
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
    console.log(`UDP KLV Splitter stopped (${this.stats.klvPackets} KLV packets extracted)`);
    this.emit('stopped');
  }

  getStats() {
    return this.stats;
  }
}

export default UDPKLVSplitter;
