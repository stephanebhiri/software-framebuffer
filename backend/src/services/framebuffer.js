/**
 * FrameBuffer Service
 * Manages the C framebuffer process for ultra-stable video frame synchronization
 * Provides decoupled input/output with rock-solid timing
 */
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class FrameBufferService extends EventEmitter {
  constructor() {
    super();
    this.process = null;
    this.isRunning = false;
    this.stats = {
      framesIn: 0,
      framesOut: 0,
      framesRepeated: 0
    };
    this.config = {
      inputPort: 5001,
      outputPort: 5002,
      outputHost: '127.0.0.1',
      width: 640,
      height: 480,
      fps: 25,
      bitrate: 2000,
      rawOutput: false,  // -r flag: output raw RTP instead of H.264 MPEG-TS
      vp8Output: false,  // -v flag: output VP8 RTP (WebRTC-ready)
      shmOutput: false,  // -s flag: output raw I420 via shared memory
      shmPath: '/tmp/framebuffer.sock'  // shared memory socket path
    };
  }

  /**
   * Get path to framebuffer binary
   */
  getBinaryPath() {
    const paths = [
      join(__dirname, '../../bin/framebuffer'),
      join(__dirname, '../framebuffer/framebuffer')
    ];

    for (const p of paths) {
      if (existsSync(p)) {
        return p;
      }
    }
    return null;
  }

  /**
   * Start the framebuffer process
   * @param {object} options - Configuration options
   */
  async start(options = {}) {
    if (this.isRunning) {
      console.log('FrameBuffer: Already running');
      return;
    }

    const binaryPath = this.getBinaryPath();
    if (!binaryPath) {
      throw new Error('FrameBuffer binary not found. Build it with: cd backend/src/framebuffer && make');
    }

    // Merge options
    Object.assign(this.config, options);

    const args = [
      '-i', String(this.config.inputPort),
      '-o', String(this.config.outputPort),
      '-H', this.config.outputHost,
      '-w', String(this.config.width),
      '-h', String(this.config.height),
      '-f', String(this.config.fps),
      '-b', String(this.config.bitrate)
    ];

    // Add output mode flag (priority: shm > vp8 > raw)
    if (this.config.shmOutput) {
      args.push('-s', this.config.shmPath);  // SHM output for webrtc-gateway
    } else if (this.config.vp8Output) {
      args.push('-v');  // VP8 takes priority
    } else if (this.config.rawOutput) {
      args.push('-r');
    }

    console.log(`FrameBuffer: Starting ${binaryPath} ${args.join(' ')}`);

    // Disable macOS hardware decoders (vtdec) which fail on some 4K MPEG2 content
    // Force software decoding with multi-threading for better performance
    const env = {
      ...process.env,
      GST_PLUGIN_FEATURE_RANK: 'vtdec:0,vtdec_hw:0,vtdechw:0',
      // Enable multi-threading for FFmpeg decoders (0 = auto, uses all cores)
      LIBAV_THREADS: '0'
    };

    this.process = spawn(binaryPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env
    });

    this.process.stdout.on('data', (data) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        // Parse stats from output
        const statsMatch = line.match(/Stats: in=(\d+) out=(\d+) repeated=(\d+)/);
        if (statsMatch) {
          this.stats.framesIn = parseInt(statsMatch[1]);
          this.stats.framesOut = parseInt(statsMatch[2]);
          this.stats.framesRepeated = parseInt(statsMatch[3]);
          this.emit('stats', this.stats);
        }

        // Log important messages
        if (line.includes('[FrameBuffer]')) {
          console.log(line);
        }
      }
    });

    this.process.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) {
        console.error('[FrameBuffer ERR]', msg);
      }
    });

    this.process.on('close', (code) => {
      console.log(`FrameBuffer: Process exited with code ${code}`);
      this.isRunning = false;
      this.process = null;
      this.emit('closed', code);
    });

    this.process.on('error', (err) => {
      console.error('FrameBuffer: Process error:', err.message);
      this.emit('error', err);
    });

    this.isRunning = true;

    // Wait for the process to initialize
    await new Promise(resolve => setTimeout(resolve, 1000));

    console.log('FrameBuffer: Started');
    this.emit('started');
  }

  /**
   * Stop the framebuffer process
   */
  async stop() {
    if (!this.process) {
      return;
    }

    console.log('FrameBuffer: Stopping');

    this.process.kill('SIGTERM');

    // Wait for graceful shutdown
    await new Promise(resolve => setTimeout(resolve, 500));

    if (this.process && !this.process.killed) {
      this.process.kill('SIGKILL');
    }

    this.process = null;
    this.isRunning = false;
    this.stats = { framesIn: 0, framesOut: 0, framesRepeated: 0 };
    console.log('FrameBuffer: Stopped');
  }

  /**
   * Get current status
   */
  getStatus() {
    return {
      running: this.isRunning,
      config: this.config,
      stats: this.stats
    };
  }

  /**
   * Get the output port (for WebRTC pipeline to connect to)
   */
  getOutputPort() {
    return this.config.outputPort;
  }

  /**
   * Get the input port (for upstream to send to)
   */
  getInputPort() {
    return this.config.inputPort;
  }

  /**
   * Check if raw output mode is enabled
   */
  isRawOutput() {
    return this.config.rawOutput;
  }

  /**
   * Check if VP8 output mode is enabled
   */
  isVp8Output() {
    return this.config.vp8Output;
  }

  /**
   * Get the output mode name
   */
  getOutputMode() {
    if (this.config.shmOutput) return 'shm';
    if (this.config.vp8Output) return 'vp8';
    if (this.config.rawOutput) return 'raw';
    return 'h264';
  }

  /**
   * Check if SHM output mode is enabled
   */
  isShmOutput() {
    return this.config.shmOutput;
  }

  /**
   * Get the SHM socket path
   */
  getShmPath() {
    return this.config.shmPath;
  }
}

export default FrameBufferService;
