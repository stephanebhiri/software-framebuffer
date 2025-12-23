/**
 * C WebRTC Gateway Service
 * Spawns the C webrtc-gateway binary and communicates via stdin/stdout JSON
 * This replaces the Python pipeline for better performance (no UDP forwarding)
 */
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class WebRTCGatewayC extends EventEmitter {
  constructor() {
    super();
    this.process = null;
    this.clients = new Map();
    this.pendingClients = new Set(); // Clients waiting for offer
    this.isReady = false;
    this.messageBuffer = '';
    this.currentOffer = null; // Cache offer for late joiners
  }

  /**
   * Get path to webrtc-gateway binary
   */
  getBinaryPath() {
    const paths = [
      join(__dirname, '../../bin/webrtc-gateway'),
      join(__dirname, '../framebuffer/webrtc-gateway')
    ];

    for (const p of paths) {
      if (existsSync(p)) {
        return p;
      }
    }
    return null;
  }

  /**
   * Start the WebRTC gateway
   * @param {string} sourceType - 'udp' for UDP input, 'shm' for shared memory input
   * @param {Object} config - Configuration
   * @param {number} config.port - UDP port (for udp mode)
   * @param {string} config.shmPath - Shared memory socket path (for shm mode)
   * @param {number} config.width - Video width
   * @param {number} config.height - Video height
   * @param {number} config.fps - Framerate (for shm mode)
   * @param {number} config.bitrate - VP8 bitrate in kbps
   */
  async start(sourceType, config) {
    console.log(`WebRTC Gateway C: Starting ${sourceType}`, config);

    const binaryPath = this.getBinaryPath();
    if (!binaryPath) {
      throw new Error('webrtc-gateway binary not found. Build with: cd backend/src/framebuffer && make');
    }

    const width = config.width || 640;
    const height = config.height || 480;
    const bitrate = config.bitrate || 2000;
    const fps = config.fps || 30;

    const args = ['-w', String(width), '-h', String(height), '-b', String(bitrate)];

    if (sourceType === 'shm') {
      // Shared memory input mode (from FrameBuffer)
      const shmPath = config.shmPath || '/tmp/framebuffer.sock';
      args.push('-s', shmPath);
      args.push('-f', String(fps));
    } else {
      // UDP input mode (direct MPEG-TS)
      const port = config.port || 5000;
      args.push('-p', String(port));
    }

    console.log(`WebRTC Gateway C: ${binaryPath} ${args.join(' ')}`);

    // Disable vtdec (macOS hardware decoder) - crashes on MPEG2 4K
    const env = {
      ...process.env,
      GST_PLUGIN_FEATURE_RANK: 'vtdec:0,vtdec_hw:0,vtdechw:0'
    };

    this.process = spawn(binaryPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env
    });

    // Handle stdout (JSON messages)
    this.process.stdout.on('data', (data) => {
      this.messageBuffer += data.toString();
      this._processMessages();
    });

    // Handle stderr (debug output)
    this.process.stderr.on('data', (data) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        console.log('[WebRTC-C]', line);
      }
    });

    this.process.on('close', (code) => {
      console.log(`WebRTC Gateway C: Process exited with code ${code}`);
      this.isReady = false;
      this.emit('closed', code);
    });

    this.process.on('error', (err) => {
      console.error('WebRTC Gateway C: Process error:', err.message);
      this.emit('error', err);
    });

    // Wait for ready signal
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('WebRTC Gateway C: Timeout waiting for ready'));
      }, 10000);

      const onReady = () => {
        clearTimeout(timeout);
        this.removeListener('error', onError);
        resolve();
      };

      const onError = (err) => {
        clearTimeout(timeout);
        this.removeListener('ready', onReady);
        reject(err);
      };

      this.once('ready', onReady);
      this.once('error', onError);
    });
  }

  /**
   * Process JSON messages from stdout
   */
  _processMessages() {
    const lines = this.messageBuffer.split('\n');
    this.messageBuffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        this._handleMessage(msg);
      } catch (e) {
        console.warn('WebRTC Gateway C: Invalid JSON:', line);
      }
    }
  }

  /**
   * Handle message from gateway
   */
  _handleMessage(msg) {
    switch (msg.type) {
      case 'ready':
        console.log('WebRTC Gateway C: Ready');
        this.isReady = true;
        this.emit('ready');
        break;

      case 'offer':
        console.log(`WebRTC Gateway C: Offer received (broadcasting to ${this.pendingClients.size} clients)`);
        this.currentOffer = msg.sdp;
        // Broadcast offer to ALL pending clients
        for (const clientId of this.pendingClients) {
          this.emit('offer', clientId, msg.sdp);
        }
        break;

      case 'answer':
        console.log(`WebRTC Gateway C: Answer for ${msg.client_id || 'default'}`);
        this.emit('answer', msg.client_id || 'default', msg.sdp);
        break;

      case 'ice_candidate':
      case 'ice':
        // Broadcast ICE candidates to ALL connected clients
        for (const [clientId] of this.clients) {
          this.emit('ice-candidate', clientId, {
            candidate: msg.candidate,
            sdpMLineIndex: msg.sdp_mline_index || msg.sdpMLineIndex || 0
          });
        }
        break;

      case 'client_connected':
        console.log(`WebRTC Gateway C: Client connected`);
        this.emit('client-connected', msg.client_id || 'default');
        break;

      case 'error':
        console.error('WebRTC Gateway C: Error:', msg.message);
        this.emit('error', new Error(msg.message));
        break;

      default:
        console.log('WebRTC Gateway C: Unknown message:', msg);
    }
  }

  /**
   * Send JSON message to gateway
   */
  _send(msg) {
    if (this.process && this.process.stdin.writable) {
      this.process.stdin.write(JSON.stringify(msg) + '\n');
    }
  }

  /**
   * Add a WebRTC client
   */
  addClient(clientId) {
    console.log(`WebRTC Gateway C: Adding client ${clientId}`);
    this.clients.set(clientId, { pendingIce: [] });
    this.pendingClients.add(clientId);

    // If we already have an offer, send it immediately
    if (this.currentOffer) {
      console.log(`WebRTC Gateway C: Sending cached offer to ${clientId}`);
      this.emit('offer', clientId, this.currentOffer);
    } else {
      // First client - start the pipeline
      if (this.clients.size === 1) {
        this._send({ type: 'start' });
      }
    }
  }

  /**
   * Remove a WebRTC client
   */
  removeClient(clientId) {
    console.log(`WebRTC Gateway C: Removing client ${clientId}`);
    this.clients.delete(clientId);
    this.pendingClients.delete(clientId);
  }

  /**
   * Set SDP answer from browser
   */
  setAnswer(clientId, sdp) {
    console.log(`WebRTC Gateway C: Setting answer for ${clientId}`);
    this._send({ type: 'answer', sdp, client_id: clientId });
  }

  /**
   * Add ICE candidate from browser
   */
  addIceCandidate(clientId, candidate, sdpMLineIndex) {
    this._send({
      type: 'ice',
      candidate,
      sdpMLineIndex: sdpMLineIndex || 0,
      client_id: clientId
    });
  }

  /**
   * Stop the gateway
   */
  async stop() {
    if (!this.process) return;

    console.log('WebRTC Gateway C: Stopping');
    this._send({ type: 'stop' });

    // Wait a bit then force kill
    await new Promise(r => setTimeout(r, 500));
    if (this.process && !this.process.killed) {
      this.process.kill('SIGTERM');
    }

    this.process = null;
    this.isReady = false;
    this.clients.clear();
    this.pendingClients.clear();
    this.currentOffer = null;
  }
}

export default WebRTCGatewayC;
