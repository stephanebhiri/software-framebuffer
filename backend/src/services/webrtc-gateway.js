/**
 * WebRTC Gateway Service
 *
 * Manages the webrtc-gateway C process which handles:
 * - Reading raw I420 frames from FrameBuffer via shared memory (shmsrc)
 * - VP8 encoding
 * - WebRTC streaming via webrtcbin
 *
 * This service handles signaling between browsers and the gateway.
 */
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { createInterface } from 'readline';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class WebRTCGatewayService extends EventEmitter {
  constructor() {
    super();
    this.process = null;
    this.isReady = false;
    this.pendingClients = new Map(); // clientId -> { resolve, reject }
    this.connectedClients = new Set();

    // Gateway binary path
    this.gatewayPath = join(__dirname, '../../bin/webrtc-gateway');
  }

  /**
   * Start the webrtc-gateway process
   * @param {Object} options
   * @param {number} options.udpPort - UDP port for VP8 RTP input from FrameBuffer
   * @param {string} options.stunServer - STUN server URL
   */
  async start(options = {}) {
    if (this.process) {
      await this.stop();
    }

    const {
      udpPort = 5002,
      stunServer = 'stun://stun.l.google.com:19302'
    } = options;

    // Check if gateway binary exists
    if (!existsSync(this.gatewayPath)) {
      throw new Error(`WebRTC gateway not found at ${this.gatewayPath}. Run 'make' in src/framebuffer/`);
    }

    const args = [
      '-p', String(udpPort),
      '-t', stunServer
    ];

    console.log(`Starting webrtc-gateway: ${this.gatewayPath} ${args.join(' ')}`);

    return new Promise((resolve, reject) => {
      this.process = spawn(this.gatewayPath, args, {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      // Read JSON messages from stdout
      const rl = createInterface({
        input: this.process.stdout,
        crlfDelay: Infinity
      });

      rl.on('line', (line) => {
        this._handleMessage(line);
      });

      // Log stderr
      this.process.stderr.on('data', (data) => {
        console.log('[webrtc-gateway]', data.toString().trim());
      });

      this.process.on('close', (code) => {
        console.log(`webrtc-gateway exited with code ${code}`);
        this.isReady = false;
        this.process = null;
        this.emit('closed', code);
      });

      this.process.on('error', (error) => {
        console.error('webrtc-gateway error:', error);
        reject(error);
      });

      // Wait for 'ready' message
      const timeout = setTimeout(() => {
        reject(new Error('webrtc-gateway startup timeout'));
      }, 10000);

      this.once('ready', () => {
        clearTimeout(timeout);
        this.isReady = true;
        resolve();
      });
    });
  }

  /**
   * Stop the webrtc-gateway process
   */
  async stop() {
    if (!this.process) return;

    return new Promise((resolve) => {
      this.process.once('close', () => {
        this.process = null;
        this.isReady = false;
        this.connectedClients.clear();
        resolve();
      });

      // Send stop message
      this._sendMessage({ type: 'stop' });

      // Force kill after timeout
      setTimeout(() => {
        if (this.process) {
          this.process.kill('SIGKILL');
        }
      }, 2000);
    });
  }

  /**
   * Handle incoming JSON message from gateway
   */
  _handleMessage(line) {
    try {
      const msg = JSON.parse(line);

      switch (msg.type) {
        case 'ready':
          console.log('webrtc-gateway ready');
          this.emit('ready');
          break;

        case 'offer':
          // Gateway created an offer (for future multi-client support)
          this.emit('offer', msg.sdp);
          break;

        case 'answer':
          // Gateway created an answer to browser's offer
          this.emit('answer', msg.sdp);
          break;

        case 'ice':
          // Gateway generated an ICE candidate
          this.emit('ice-candidate', {
            candidate: msg.candidate,
            sdpMLineIndex: msg.sdpMLineIndex
          });
          break;

        case 'ice-state':
          console.log('ICE state:', msg.state);
          this.emit('ice-state', msg.state);
          break;

        case 'connection-state':
          console.log('Connection state:', msg.state);
          this.emit('connection-state', msg.state);
          if (msg.state === 'connected') {
            this.emit('client-connected');
          } else if (msg.state === 'failed' || msg.state === 'disconnected') {
            this.emit('client-disconnected');
          }
          break;

        case 'error':
          console.error('Gateway error:', msg.message);
          this.emit('error', new Error(msg.message));
          break;

        case 'eos':
          console.log('Gateway: end of stream');
          this.emit('eos');
          break;

        default:
          console.log('Unknown gateway message:', msg);
      }
    } catch (error) {
      console.error('Failed to parse gateway message:', line, error);
    }
  }

  /**
   * Send JSON message to gateway
   */
  _sendMessage(msg) {
    if (!this.process || !this.process.stdin.writable) {
      console.error('Cannot send message: gateway not running');
      return false;
    }

    const json = JSON.stringify(msg);
    this.process.stdin.write(json + '\n');
    return true;
  }

  /**
   * Start the pipeline
   */
  startPipeline() {
    return this._sendMessage({ type: 'start' });
  }

  /**
   * Handle SDP offer from browser
   * @param {string} sdp - SDP offer string
   */
  setOffer(sdp) {
    return this._sendMessage({ type: 'offer', sdp });
  }

  /**
   * Handle SDP answer from browser (if we sent offer)
   * @param {string} sdp - SDP answer string
   */
  setAnswer(sdp) {
    return this._sendMessage({ type: 'answer', sdp });
  }

  /**
   * Add ICE candidate from browser
   * @param {string} candidate - ICE candidate string
   * @param {number} sdpMLineIndex - SDP M-Line index
   * @param {string} sdpMid - SDP mid (optional)
   */
  addIceCandidate(candidate, sdpMLineIndex, sdpMid) {
    return this._sendMessage({
      type: 'ice',
      candidate,
      sdpMLineIndex,
      sdpMid
    });
  }

  /**
   * Get service status
   */
  getStatus() {
    return {
      running: !!this.process,
      ready: this.isReady,
      clients: this.connectedClients.size
    };
  }
}

export default WebRTCGatewayService;
