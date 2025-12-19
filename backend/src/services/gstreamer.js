import { spawn } from 'child_process';
import { EventEmitter } from 'events';

/**
 * GStreamer Service - MPEG-TS demux, VP8 transcode, KLV extraction
 * More resilient than FFmpeg for degraded/unstable streams (STANAG 4609)
 *
 * Architecture:
 *   UDP/File → tee → [video: tsdemux→h264→vp8→RTP→mediasoup]
 *                  → [raw TS: stdout→Node.js KLV parsing]
 */
class GStreamerService extends EventEmitter {
  constructor() {
    super();
    this.pipeline = null;
    this.isRunning = false;
    this.setMaxListeners(10);

    // Restart management
    this.restartAttempts = 0;
    this.maxRestartAttempts = 3;
    this.restartDelay = 2000;
    this.lastPipelineStr = null;

    // Health monitoring
    this.lastActivityTime = 0;
    this.healthCheckInterval = null;
    this.activityTimeoutMs = 10000;
  }

  /**
   * Start UDP reception with video transcoding and KLV extraction
   * @param {number} udpPort - UDP port for MPEG-TS input
   * @param {number} rtpPort - RTP port for VP8 output to mediasoup
   */
  startUDP(udpPort, rtpPort) {
    this._stopPipeline();
    this.isRunning = true;
    this.restartAttempts = 0; // Reset on new start

    const pipelineStr = this._buildPipeline(
      `udpsrc port=${udpPort} buffer-size=2097152`,
      rtpPort
    );

    this._launchPipeline(pipelineStr);
    console.log(`GStreamer: UDP started on :${udpPort} → RTP :${rtpPort}`);
  }

  /**
   * Start file playback with video transcoding and KLV extraction
   * @param {string} filePath - Path to MPEG-TS file
   * @param {number} rtpPort - RTP port for VP8 output to mediasoup
   */
  startFile(filePath, rtpPort) {
    this._stopPipeline();
    this.isRunning = true;
    this.restartAttempts = 0; // Reset on new start

    const pipelineStr = this._buildPipeline(
      `filesrc location="${filePath}"`,
      rtpPort
    );

    this._launchPipeline(pipelineStr);
    console.log(`GStreamer: File started ${filePath} → RTP :${rtpPort}`);
  }

  /**
   * Build GStreamer pipeline string
   * Single pipeline with tee: one branch for video, one for raw TS (KLV extraction)
   */
  _buildPipeline(source, rtpPort) {
    return `
      ${source}
      ! tee name=t
      t. ! queue max-size-buffers=100 leaky=downstream
         ! tsparse set-timestamps=true
         ! tsdemux latency=100
         ! queue max-size-buffers=100 max-size-time=500000000 leaky=downstream
         ! h264parse
         ! avdec_h264 output-corrupt=true
         ! videoconvert
         ! videoscale
         ! video/x-raw,width=1280,height=720
         ! vp8enc deadline=1 cpu-used=8 threads=4 keyframe-max-dist=30
         ! rtpvp8pay pt=96 ssrc=22222222
         ! udpsink host=127.0.0.1 port=${rtpPort} sync=false async=false
      t. ! queue leaky=downstream
         ! fdsink fd=1 sync=false
    `.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /**
   * Launch GStreamer pipeline and setup KLV extraction from stdout
   */
  _launchPipeline(pipelineStr) {
    this.lastPipelineStr = pipelineStr;
    this.lastActivityTime = Date.now();

    this.pipeline = spawn('bash', ['-c', `gst-launch-1.0 -e ${pipelineStr}`], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Stderr: log errors and detect input issues
    this.pipeline.stderr.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('ERROR') || msg.includes('CRITICAL')) {
        console.error('GStreamer:', msg.trim().substring(0, 200));
        this.emit('pipeline-error', msg);
      }
      // Detect packet loss / degraded stream
      if (msg.includes('dropping') || msg.includes('late')) {
        this.emit('packet-loss', msg.trim().substring(0, 100));
      }
    });

    // Stdout: raw TS packets for KLV extraction
    this._setupKLVExtraction();

    this.pipeline.on('close', (code) => {
      console.log(`GStreamer pipeline closed, code: ${code}`);
      this._clearHealthCheck();
      this.pipeline = null;

      // Auto-restart on unexpected exit
      if (this.isRunning && code !== 0) {
        this._attemptRestart();
      } else if (code === 0) {
        // Normal end (e.g., file playback finished)
        this.emit('stream-ended');
      }
    });

    this.pipeline.on('error', (err) => {
      console.error('GStreamer spawn error:', err.message);
      this.emit('pipeline-error', err.message);
    });

    // Start health monitoring
    this._startHealthCheck();
  }

  /**
   * Attempt pipeline restart after failure
   */
  _attemptRestart() {
    if (this.restartAttempts >= this.maxRestartAttempts) {
      console.error(`GStreamer: Max restart attempts (${this.maxRestartAttempts}) reached`);
      this.isRunning = false;
      this.emit('pipeline-failed', 'max_restarts_exceeded');
      return;
    }

    this.restartAttempts++;
    console.log(`GStreamer: Restart attempt ${this.restartAttempts}/${this.maxRestartAttempts} in ${this.restartDelay}ms`);

    setTimeout(() => {
      if (this.isRunning && this.lastPipelineStr) {
        console.log('GStreamer: Restarting pipeline...');
        this._launchPipeline(this.lastPipelineStr);
      }
    }, this.restartDelay);
  }

  /**
   * Start health monitoring - detect stalled pipelines
   */
  _startHealthCheck() {
    this._clearHealthCheck();
    this.healthCheckInterval = setInterval(() => {
      const elapsed = Date.now() - this.lastActivityTime;
      if (elapsed > this.activityTimeoutMs) {
        console.warn(`GStreamer: No activity for ${elapsed}ms - pipeline may be stalled`);
        this.emit('pipeline-stalled', elapsed);
        // Force restart
        this._stopPipeline();
        if (this.isRunning) {
          this.isRunning = true; // Keep running state for restart
          this._attemptRestart();
        }
      }
    }, 5000);
  }

  /**
   * Clear health check interval
   */
  _clearHealthCheck() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  /**
   * Parse raw MPEG-TS from stdout to extract KLV metadata
   */
  _setupKLVExtraction() {
    const TS_PACKET_SIZE = 188;
    const SYNC_BYTE = 0x47;
    const KLV_PIDS = new Set([0x0042, 0x0044, 0x0100, 0x0101, 0x0102, 0x01f1, 0x1000]);

    let tsBuffer = Buffer.alloc(0);
    const pesBuffers = new Map();

    this.pipeline.stdout.on('data', (chunk) => {
      this.lastActivityTime = Date.now();
      tsBuffer = Buffer.concat([tsBuffer, chunk]);

      // Process complete TS packets
      while (tsBuffer.length >= TS_PACKET_SIZE) {
        // Find sync byte
        const syncIndex = tsBuffer.indexOf(SYNC_BYTE);
        if (syncIndex === -1) {
          tsBuffer = Buffer.alloc(0);
          break;
        }
        if (syncIndex > 0) {
          tsBuffer = tsBuffer.subarray(syncIndex);
          continue;
        }
        if (tsBuffer.length < TS_PACKET_SIZE) break;

        const packet = tsBuffer.subarray(0, TS_PACKET_SIZE);
        tsBuffer = tsBuffer.subarray(TS_PACKET_SIZE);

        // Parse PID
        const pid = ((packet[1] & 0x1f) << 8) | packet[2];
        if (!KLV_PIDS.has(pid)) continue;

        // Parse TS header
        const pusi = (packet[1] & 0x40) !== 0;
        const adaptationField = (packet[3] & 0x30) >> 4;

        let payloadStart = 4;
        if (adaptationField === 2) continue; // No payload
        if (adaptationField === 3) payloadStart = 5 + packet[4];
        if (payloadStart >= TS_PACKET_SIZE) continue;

        const payload = packet.subarray(payloadStart);

        // Assemble PES packets
        if (pusi) {
          // New PES - emit previous if complete
          if (pesBuffers.has(pid) && pesBuffers.get(pid).length > 0) {
            this._emitKLV(pesBuffers.get(pid));
          }
          pesBuffers.set(pid, Buffer.from(payload));
        } else if (pesBuffers.has(pid)) {
          const existing = pesBuffers.get(pid);
          pesBuffers.set(pid, Buffer.concat([existing, payload]));
          // Memory guard: 64KB max per PES
          if (pesBuffers.get(pid).length > 65536) {
            pesBuffers.delete(pid);
          }
        }
      }

      // Memory guard: 1MB max TS buffer
      if (tsBuffer.length > 1024 * 1024) {
        tsBuffer = tsBuffer.subarray(-TS_PACKET_SIZE * 100);
      }
    });

    // Cleanup on close
    this.pipeline.on('close', () => {
      pesBuffers.clear();
      tsBuffer = Buffer.alloc(0);
    });
  }

  /**
   * Extract and emit KLV data from PES packet
   */
  _emitKLV(pesData) {
    if (pesData.length < 9) return;

    // Verify PES header
    if (pesData[0] !== 0x00 || pesData[1] !== 0x00 || pesData[2] !== 0x01) return;

    const streamId = pesData[3];
    if (streamId !== 0xbd && streamId !== 0xfc) return; // private_stream_1 or metadata

    const headerDataLength = pesData[8];
    const klvStart = 9 + headerDataLength;
    if (klvStart >= pesData.length) return;

    const klvData = pesData.subarray(klvStart);

    // Verify SMPTE 336M UAS Local Set key
    if (klvData.length >= 4 &&
        klvData[0] === 0x06 && klvData[1] === 0x0e &&
        klvData[2] === 0x2b && klvData[3] === 0x34) {
      this.emit('klv', klvData);
    }
  }

  /**
   * Stop pipeline only (internal use for restart)
   */
  _stopPipeline() {
    this.isRunning = false;

    if (this.pipeline) {
      // Destroy streams to prevent memory leaks
      this.pipeline.stdin?.destroy();
      this.pipeline.stdout?.destroy();
      this.pipeline.stderr?.destroy();

      // Graceful shutdown
      this.pipeline.kill('SIGTERM');

      // Force kill after 500ms
      const pid = this.pipeline.pid;
      setTimeout(() => {
        try {
          process.kill(pid, 'SIGKILL');
        } catch (e) {
          // Already dead
        }
      }, 500);

      this.pipeline = null;
    }
  }

  /**
   * Stop pipeline and cleanup all listeners
   */
  stop() {
    this._clearHealthCheck();
    this._stopPipeline();
    this.restartAttempts = 0;
    this.lastPipelineStr = null;
    this.removeAllListeners();
    console.log('GStreamer: Stopped');
  }

  get running() {
    return this.isRunning && this.pipeline !== null;
  }
}

export default GStreamerService;
