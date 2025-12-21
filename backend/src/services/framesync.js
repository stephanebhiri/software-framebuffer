/**
 * FrameSync Service
 * Manages SoftwareFrameSync process for stream stabilization
 * Provides A/B switching, TBC, and format normalization
 */
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class FrameSyncService extends EventEmitter {
  constructor() {
    super();
    this.process = null;
    this.isRunning = false;
    this.config = {
      inputPort: 5000,
      outputPort: 5001,
      outputHost: '127.0.0.1',
      outputFormat: 'mpegts',  // mpegts for WebRTC pipeline compatibility
      width: 640,
      height: 480,
      fps: 25,
      bitrate: 2000,
      watchdogMs: 10000,  // 10 seconds to allow decoder recovery
      resumeMs: 100
    };
  }

  /**
   * Get path to framesync binary
   */
  getBinaryPath() {
    // Check in backend/bin first, then in SoftwareFrameSync project
    const paths = [
      join(__dirname, '../../bin/framesync'),
      '/Users/stephane/Documents/CV_Stephane_Bhiri/SoftwareFrameSync/framesync'
    ];

    for (const p of paths) {
      if (existsSync(p)) {
        return p;
      }
    }
    return null;
  }

  /**
   * Start the framesync process
   * @param {object} options - Configuration options
   */
  async start(options = {}) {
    if (this.isRunning) {
      console.log('FrameSync: Already running');
      return;
    }

    const binaryPath = this.getBinaryPath();
    if (!binaryPath) {
      throw new Error('FrameSync binary not found. Build it with: cd SoftwareFrameSync && make');
    }

    // Merge options
    Object.assign(this.config, options);

    const args = [
      '-i', String(this.config.inputPort),
      '-o', String(this.config.outputPort),
      '-H', this.config.outputHost,
      '-F', this.config.outputFormat,
      '-w', String(this.config.width),
      '-h', String(this.config.height),
      '-f', String(this.config.fps),
      '-b', String(this.config.bitrate),
      '-W', String(this.config.watchdogMs),
      '-R', String(this.config.resumeMs)
    ];

    console.log(`FrameSync: Starting ${binaryPath} ${args.join(' ')}`);

    this.process = spawn(binaryPath, args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.process.stdout.on('data', (data) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        console.log('[FrameSync]', line);

        // Detect state changes
        if (line.includes('SWITCHED TO FALLBACK')) {
          this.emit('fallback');
        } else if (line.includes('SWITCHED TO INGEST')) {
          this.emit('ingest');
        }
      }
    });

    this.process.stderr.on('data', (data) => {
      console.error('[FrameSync ERR]', data.toString().trim());
    });

    this.process.on('close', (code) => {
      console.log(`FrameSync: Process exited with code ${code}`);
      this.isRunning = false;
      this.process = null;
      this.emit('closed', code);
    });

    this.process.on('error', (err) => {
      console.error('FrameSync: Process error:', err.message);
      this.emit('error', err);
    });

    this.isRunning = true;

    // Wait a bit for the process to initialize
    await new Promise(resolve => setTimeout(resolve, 500));

    console.log('FrameSync: Started');
    this.emit('started');
  }

  /**
   * Stop the framesync process
   */
  async stop() {
    if (!this.process) {
      return;
    }

    console.log('FrameSync: Stopping');

    this.process.kill('SIGTERM');

    // Wait for graceful shutdown
    await new Promise(resolve => setTimeout(resolve, 500));

    if (this.process && !this.process.killed) {
      this.process.kill('SIGKILL');
    }

    this.process = null;
    this.isRunning = false;
    console.log('FrameSync: Stopped');
  }

  /**
   * Get current status
   */
  getStatus() {
    return {
      running: this.isRunning,
      config: this.config
    };
  }

  /**
   * Get the output port (for WebRTC pipeline to connect to)
   */
  getOutputPort() {
    return this.config.outputPort;
  }
}

export default FrameSyncService;
