/**
 * FFmpeg service for demuxing video and KLV streams
 */
import { spawn } from 'child_process';
import { EventEmitter } from 'events';

export class FFmpegService extends EventEmitter {
  constructor() {
    super();
    this.process = null;
    this.klvBuffer = Buffer.alloc(0);
  }

  /**
   * Start extracting KLV data from a file
   * @param {string} inputPath - Path to .ts or .mpg file
   */
  startKLVExtraction(inputPath) {
    // Extract KLV data stream
    this.process = spawn('ffmpeg', [
      '-i', inputPath,
      '-map', '0:d',      // Select data stream
      '-c', 'copy',       // Copy without re-encoding
      '-f', 'data',       // Output as raw data
      'pipe:1'            // Output to stdout
    ], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    this.process.stdout.on('data', (chunk) => {
      this.klvBuffer = Buffer.concat([this.klvBuffer, chunk]);
      this.emit('klv-data', chunk);
    });

    this.process.stderr.on('data', (data) => {
      // FFmpeg outputs progress to stderr
      const msg = data.toString();
      if (msg.includes('Error') || msg.includes('error')) {
        this.emit('error', new Error(msg));
      }
    });

    this.process.on('close', (code) => {
      this.emit('close', code);
    });

    return this;
  }

  /**
   * Start HLS transcoding for web playback
   * @param {string} inputPath - Path to input file
   * @param {string} outputDir - Directory for HLS segments
   */
  startHLSTranscode(inputPath, outputDir) {
    const hlsProcess = spawn('ffmpeg', [
      '-i', inputPath,
      '-map', '0:v',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-g', '30',
      '-sc_threshold', '0',
      '-f', 'hls',
      '-hls_time', '2',
      '-hls_list_size', '10',
      '-hls_flags', 'delete_segments+append_list',
      '-hls_segment_filename', `${outputDir}/segment_%03d.ts`,
      `${outputDir}/playlist.m3u8`
    ]);

    hlsProcess.stderr.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('Error')) {
        console.error('HLS Error:', msg);
      }
    });

    return hlsProcess;
  }

  /**
   * Start extracting KLV data from UDP stream
   * @param {number} port - UDP port to listen on
   */
  startUDPKLVExtraction(port) {
    console.log(`FFmpeg: Starting KLV extraction from UDP port ${port}`);

    this.process = spawn('ffmpeg', [
      '-i', `udp://127.0.0.1:${port}?fifo_size=1000000&overrun_nonfatal=1`,
      '-map', '0:d?',     // Select data stream if exists
      '-c', 'copy',       // Copy without re-encoding
      '-f', 'data',       // Output as raw data
      'pipe:1'            // Output to stdout
    ], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    this.process.stdout.on('data', (chunk) => {
      this.klvBuffer = Buffer.concat([this.klvBuffer, chunk]);
      this.emit('klv-data', chunk);
    });

    this.process.stderr.on('data', (data) => {
      const msg = data.toString();
      // Only log errors, not progress
      if (msg.includes('Error') && !msg.includes('Option')) {
        console.error('FFmpeg KLV:', msg.trim());
      }
    });

    this.process.on('close', (code) => {
      console.log(`FFmpeg KLV extraction stopped (code ${code})`);
      this.emit('close', code);
    });

    return this;
  }

  /**
   * Get accumulated KLV buffer
   */
  getKLVBuffer() {
    return this.klvBuffer;
  }

  /**
   * Stop extraction
   */
  stop() {
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
  }
}

export default FFmpegService;
