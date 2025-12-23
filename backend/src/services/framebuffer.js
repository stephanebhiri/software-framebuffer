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
      jitterBuffer: 2000,  // 2 seconds jitter buffer
      codec: 'h264',       // raw, h264, h265, vp8, vp9
      container: 'mpegts', // rtp, mpegts, shm, raw, file
      shmPath: '/tmp/framebuffer.sock',
      outputFile: null     // for file container
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

    // Build args matching the C binary's actual supported options:
    // -i PORT, -o PORT, -H HOST, -w WIDTH, -h HEIGHT, -f FPS, -b KBPS
    // -r (raw RTP), -v (VP8 RTP), -s [PATH] (shared memory)
    const args = [
      '-i', String(this.config.inputPort),
      '-w', String(this.config.width),
      '-h', String(this.config.height),
      '-f', String(this.config.fps),
      '-b', String(this.config.bitrate)
    ];

    // Add output mode
    if (this.config.container === 'shm') {
      // Shared memory output: -s [PATH]
      args.push('-s', this.config.shmPath);
      // Clean up stale socket before starting
      try {
        const fs = await import('fs');
        if (fs.existsSync(this.config.shmPath)) {
          fs.unlinkSync(this.config.shmPath);
          console.log(`FrameBuffer: Cleaned up stale socket ${this.config.shmPath}`);
        }
      } catch (e) {
        // Ignore cleanup errors
      }
    } else if (this.config.codec === 'vp8') {
      // VP8 RTP output: -v
      args.push('-v');
      args.push('-o', String(this.config.outputPort));
      args.push('-H', this.config.outputHost);
    } else if (this.config.codec === 'raw') {
      // Raw RTP output: -r
      args.push('-r');
      args.push('-o', String(this.config.outputPort));
      args.push('-H', this.config.outputHost);
    } else {
      // Default H.264 MPEG-TS output
      args.push('-o', String(this.config.outputPort));
      args.push('-H', this.config.outputHost);
    }

    console.log(`FrameBuffer: Starting ${binaryPath} ${args.join(' ')}`);

    // Decoder rank configuration:
    // - Disable vtdec (macOS hardware decoder): crashes on MPEG2 4K with error -12911
    // - Boost mpeg2dec (libmpeg2) rank: faster than avdec_mpeg2video for 4K MPEG2
    //   Default ranks: avdec_mpeg2video=256 (primary), mpeg2dec=128 (secondary)
    //   We set mpeg2dec:512 to prioritize the faster libmpeg2 decoder
    const env = {
      ...process.env,
      GST_PLUGIN_FEATURE_RANK: 'vtdec:0,vtdec_hw:0,vtdechw:0,mpeg2dec:512'
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

    // Wait for the socket to be created (for shm mode)
    if (this.config.container === 'shm') {
      const fs = await import('fs');
      const maxWait = 3000; // 3 seconds max
      const pollInterval = 100;
      let waited = 0;
      while (waited < maxWait) {
        if (fs.existsSync(this.config.shmPath)) {
          console.log(`FrameBuffer: Socket ready after ${waited}ms`);
          break;
        }
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        waited += pollInterval;
      }
      if (waited >= maxWait) {
        console.warn('FrameBuffer: Socket not found after timeout, continuing anyway');
      }
      // Extra delay to ensure socket is listening
      await new Promise(resolve => setTimeout(resolve, 200));
    } else {
      // Wait for the process to initialize
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

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
   * Check if raw codec is enabled
   */
  isRawOutput() {
    return this.config.codec === 'raw';
  }

  /**
   * Check if VP8 codec is enabled
   */
  isVp8Output() {
    return this.config.codec === 'vp8';
  }

  /**
   * Get the output mode name (codec/container)
   */
  getOutputMode() {
    return `${this.config.codec}/${this.config.container}`;
  }

  /**
   * Check if shared memory container is enabled
   */
  isShmOutput() {
    return this.config.container === 'shm';
  }

  /**
   * Get the shared memory path
   */
  getShmPath() {
    return this.config.shmPath;
  }

  /**
   * Restart with same config (for source switching)
   */
  async restart() {
    const savedConfig = { ...this.config };
    await this.stop();
    await this.start(savedConfig);
  }
}

export default FrameBufferService;
