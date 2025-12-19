/**
 * UDP Receiver for STANAG 4609 streams
 * Receives MPEG-TS packets, extracts KLV data, and pipes to FFmpeg for HLS
 */
import dgram from 'dgram';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';

const TS_PACKET_SIZE = 188;
const TS_SYNC_BYTE = 0x47;
// Known KLV PIDs - FFmpeg remaps PIDs when muxing to mpegts
// Different source files use different PIDs
const KLV_PIDS = [
  0x0044, // 68 - klv_metadata_test_sync.ts original
  0x0100, // 256 - FFmpeg mpegts muxer default for stream 0
  0x0101, // 257 - FFmpeg mpegts muxer for stream 1
  0x0102, // 258 - FFmpeg mpegts muxer for stream 2
  0x01f1, // 497 - Day_Flight.mpg, Night_Flight_IR.mpg original
  0x1000, // 4096 - falls.ts
];

export class UDPReceiver extends EventEmitter {
  constructor(port = 5000, host = '0.0.0.0', hlsDir = null) {
    super();
    this.port = port;
    this.host = host;
    this.hlsDir = hlsDir;
    this.socket = null;
    this.ffmpeg = null;
    this.pesBuffer = Buffer.alloc(0);
  }

  /**
   * Start listening for UDP packets
   */
  start() {
    this.socket = dgram.createSocket('udp4');

    // Start FFmpeg for HLS transcoding if hlsDir is provided
    if (this.hlsDir) {
      this.startFFmpeg();
    }

    this.socket.on('message', (msg) => {
      this.processPacket(msg);
    });

    this.socket.on('error', (err) => {
      console.error('UDP error:', err);
      this.emit('error', err);
    });

    this.socket.on('listening', () => {
      const addr = this.socket.address();
      console.log(`UDP receiver listening on ${addr.address}:${addr.port}`);
      this.emit('listening', addr);
    });

    this.socket.bind(this.port, this.host);
  }

  /**
   * Start FFmpeg process for HLS transcoding
   */
  startFFmpeg() {
    console.log('Starting FFmpeg HLS transcoder...');

    this.ffmpeg = spawn('ffmpeg', [
      '-f', 'mpegts',
      '-i', 'pipe:0',
      '-map', '0:v?',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-g', '30',
      '-sc_threshold', '0',
      '-f', 'hls',
      '-hls_time', '2',
      '-hls_list_size', '5',
      '-hls_flags', 'delete_segments+append_list',
      '-hls_segment_filename', `${this.hlsDir}/segment_%03d.ts`,
      `${this.hlsDir}/playlist.m3u8`
    ], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.ffmpeg.stderr.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('frame=') || msg.includes('fps=')) {
        // Progress - ignore
      } else if (msg.includes('Error') || msg.includes('error')) {
        console.error('FFmpeg error:', msg.trim());
      }
    });

    this.ffmpeg.on('close', (code) => {
      console.log('FFmpeg exited with code:', code);
      this.ffmpeg = null;
    });

    this.emit('hls-ready');
  }

  /**
   * Process incoming TS packet
   */
  processPacket(data) {
    // Emit raw TS data for external processing (e.g., WebRTC)
    this.emit('ts-data', data);

    // Forward all TS packets to FFmpeg for video transcoding (HLS mode)
    if (this.ffmpeg && this.ffmpeg.stdin.writable) {
      this.ffmpeg.stdin.write(data);
    }

    // Parse KLV from the stream
    for (let offset = 0; offset + TS_PACKET_SIZE <= data.length; offset += TS_PACKET_SIZE) {
      const packet = data.subarray(offset, offset + TS_PACKET_SIZE);

      if (packet[0] !== TS_SYNC_BYTE) continue;

      // Extract PID
      const pid = ((packet[1] & 0x1f) << 8) | packet[2];

      // Only extract KLV from known KLV PIDs
      if (!KLV_PIDS.includes(pid)) continue;

      // Payload unit start indicator
      const pusi = (packet[1] & 0x40) !== 0;

      // Adaptation field control
      const afc = (packet[3] >> 4) & 0x03;

      // Calculate payload offset
      let payloadOffset = 4;
      if (afc === 0x02 || afc === 0x03) {
        const afLength = packet[4];
        payloadOffset = 5 + afLength;
      }

      if (payloadOffset >= TS_PACKET_SIZE) continue;

      const payload = packet.subarray(payloadOffset);

      if (pusi) {
        // New PES packet starts
        if (this.pesBuffer.length > 0) {
          this.processPES(this.pesBuffer);
        }
        this.pesBuffer = payload;
      } else if (this.pesBuffer.length > 0) {
        this.pesBuffer = Buffer.concat([this.pesBuffer, payload]);
      }
    }
  }

  /**
   * Process PES packet to extract KLV
   */
  processPES(pes) {
    let klvData;

    // Check for PES encapsulation (0x000001)
    if (pes[0] === 0x00 && pes[1] === 0x00 && pes[2] === 0x01) {
      const streamId = pes[3];
      // 0xbd = private stream 1 (KLV)
      // 0xfc = metadata stream
      if (streamId !== 0xbd && streamId !== 0xfc) return;

      const headerDataLength = pes[8];
      const dataOffset = 9 + headerDataLength;
      if (dataOffset >= pes.length) return;

      klvData = pes.subarray(dataOffset);
    } else {
      // Raw KLV without PES encapsulation
      klvData = pes;
    }

    // Verify it looks like KLV (UAS Local Set key starts with 0x06 0x0e 0x2b 0x34)
    if (klvData.length > 4 && klvData[0] === 0x06 && klvData[1] === 0x0e && klvData[2] === 0x2b && klvData[3] === 0x34) {
      this.emit('klv', klvData);
    }
  }

  /**
   * Stop receiving
   */
  stop() {
    if (this.ffmpeg) {
      this.ffmpeg.stdin.end();
      this.ffmpeg.kill('SIGTERM');
      this.ffmpeg = null;
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }
}

export default UDPReceiver;
