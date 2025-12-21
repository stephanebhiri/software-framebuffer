/**
 * GStreamer WebRTC Service
 * Manages Python subprocess and IPC for WebRTC signaling
 * Replaces mediasoup with GStreamer's native webrtcbin
 */
import { spawn } from 'child_process';
import { createServer } from 'net';
import { EventEmitter } from 'events';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { unlinkSync, existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class GStreamerWebRTCService extends EventEmitter {
  constructor() {
    super();
    this.pythonProcess = null;
    this.ipcServer = null;
    this.ipcSocket = null;
    this.ipcPath = `/tmp/klv-webrtc-${process.pid}.sock`;
    this.clients = new Map(); // clientId -> { pendingIce: [] }
    this.isReady = false;
    this.messageBuffer = '';
    this.currentSource = null;
  }

  /**
   * Start the GStreamer WebRTC pipeline
   * @param {string} sourceType - 'udp' or 'file'
   * @param {object} config - Source configuration { port, codec, file, etc. }
   */
  async start(sourceType, config) {
    console.log(`GStreamer WebRTC: Starting ${sourceType}`, config);

    // Cleanup any stale socket
    if (existsSync(this.ipcPath)) {
      try {
        unlinkSync(this.ipcPath);
      } catch (e) {
        console.warn('Failed to cleanup stale socket:', e.message);
      }
    }

    // Start IPC server first
    await this._startIPCServer();

    // Start Python process
    const pythonScript = join(__dirname, '../../gstreamer/webrtc_pipeline.py');
    console.log(`GStreamer WebRTC: Spawning Python process: ${pythonScript}`);

    this.pythonProcess = spawn('python3', [pythonScript, this.ipcPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' }
    });

    this.pythonProcess.stdout.on('data', (data) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        console.log('[GStreamer]', line);
      }
    });

    this.pythonProcess.stderr.on('data', (data) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        console.error('[GStreamer ERR]', line);
      }
    });

    this.pythonProcess.on('close', (code) => {
      console.log(`GStreamer WebRTC: Process exited with code ${code}`);
      this.isReady = false;
      this.emit('closed', code);
    });

    this.pythonProcess.on('error', (err) => {
      console.error('GStreamer WebRTC: Process error:', err.message);
      this.emit('error', err);
    });

    // Wait for IPC connection
    try {
      await this._waitForConnection(10000);
    } catch (e) {
      console.error('GStreamer WebRTC: IPC connection timeout');
      this.stop();
      throw e;
    }

    // Send start command
    this._sendCommand({
      type: 'start',
      source_type: sourceType,
      source_config: config
    });

    this.currentSource = { type: sourceType, config };
    this.isReady = true;
    console.log('GStreamer WebRTC: Ready');
  }

  _startIPCServer() {
    return new Promise((resolve, reject) => {
      this.ipcServer = createServer((socket) => {
        console.log('GStreamer WebRTC: Python connected via IPC');
        this.ipcSocket = socket;

        socket.on('data', (data) => {
          this._handleIPCData(data);
        });

        socket.on('close', () => {
          console.log('GStreamer WebRTC: IPC socket closed');
          this.ipcSocket = null;
        });

        socket.on('error', (err) => {
          console.error('GStreamer WebRTC: IPC socket error:', err.message);
        });
      });

      this.ipcServer.on('error', (err) => {
        console.error('GStreamer WebRTC: IPC server error:', err.message);
        reject(err);
      });

      this.ipcServer.listen(this.ipcPath, () => {
        console.log(`GStreamer WebRTC: IPC server listening on ${this.ipcPath}`);
        resolve();
      });
    });
  }

  _waitForConnection(timeout = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('IPC connection timeout'));
      }, timeout);

      const check = setInterval(() => {
        if (this.ipcSocket) {
          clearTimeout(timer);
          clearInterval(check);
          resolve();
        }
      }, 100);
    });
  }

  _handleIPCData(data) {
    // Handle line-delimited JSON
    this.messageBuffer += data.toString();
    const lines = this.messageBuffer.split('\n');
    this.messageBuffer = lines.pop(); // Keep incomplete line

    for (const line of lines) {
      if (line.trim()) {
        try {
          const msg = JSON.parse(line);
          this._handleIPCMessage(msg);
        } catch (e) {
          console.error('GStreamer WebRTC: Failed to parse IPC message:', e.message, line);
        }
      }
    }
  }

  _handleIPCMessage(msg) {
    switch (msg.type) {
      case 'pipeline_started':
        console.log('GStreamer WebRTC: Pipeline started');
        this.emit('pipeline-started');
        break;

      case 'offer':
        console.log(`GStreamer WebRTC: Offer for ${msg.client_id}`);
        this.emit('offer', msg.client_id, msg.sdp);
        break;

      case 'ice_candidate':
        this.emit('ice-candidate', msg.client_id, {
          candidate: msg.candidate,
          sdpMLineIndex: msg.sdp_mline_index
        });
        break;

      case 'client_connected':
        console.log(`GStreamer WebRTC: Client ${msg.client_id} connected`);
        this.emit('client-connected', msg.client_id);
        break;

      case 'client_failed':
        console.log(`GStreamer WebRTC: Client ${msg.client_id} failed`);
        this.emit('client-failed', msg.client_id);
        break;

      case 'klv':
        // Decode base64 KLV data
        const klvData = Buffer.from(msg.data, 'base64');
        this.emit('klv', klvData);
        break;

      case 'hot_swap_complete':
        console.log('GStreamer WebRTC: Hot-swap complete');
        this.emit('hot-swap-complete');
        break;

      case 'eos':
        console.log('GStreamer WebRTC: End of stream');
        this.emit('eos');
        break;

      case 'stopped':
        console.log('GStreamer WebRTC: Pipeline stopped');
        this.emit('stopped');
        break;

      case 'error':
        console.error('GStreamer WebRTC: Error:', msg.message);
        this.emit('pipeline-error', msg.message);
        break;

      default:
        console.log('GStreamer WebRTC: Unknown message type:', msg.type);
    }
  }

  _sendCommand(cmd) {
    if (this.ipcSocket) {
      try {
        this.ipcSocket.write(JSON.stringify(cmd) + '\n');
      } catch (e) {
        console.error('GStreamer WebRTC: Failed to send command:', e.message);
      }
    } else {
      console.warn('GStreamer WebRTC: IPC socket not connected');
    }
  }

  /**
   * Add a WebRTC client
   * @param {string} clientId - Unique client identifier
   */
  addClient(clientId) {
    console.log(`GStreamer WebRTC: Adding client ${clientId}`);
    this.clients.set(clientId, { pendingIce: [] });
    this._sendCommand({
      type: 'add_client',
      client_id: clientId
    });
  }

  /**
   * Remove a WebRTC client
   * @param {string} clientId - Client to remove
   */
  removeClient(clientId) {
    console.log(`GStreamer WebRTC: Removing client ${clientId}`);
    this._sendCommand({
      type: 'remove_client',
      client_id: clientId
    });
    this.clients.delete(clientId);
  }

  /**
   * Set remote SDP answer from browser
   * @param {string} clientId - Client identifier
   * @param {string} sdp - SDP answer string
   */
  setAnswer(clientId, sdp) {
    console.log(`GStreamer WebRTC: Setting answer for ${clientId}`);
    this._sendCommand({
      type: 'set_answer',
      client_id: clientId,
      sdp: sdp
    });
  }

  /**
   * Add ICE candidate from browser
   * @param {string} clientId - Client identifier
   * @param {string} candidate - ICE candidate string
   * @param {number} sdpMLineIndex - SDP media line index
   */
  addIceCandidate(clientId, candidate, sdpMLineIndex) {
    this._sendCommand({
      type: 'add_ice_candidate',
      client_id: clientId,
      candidate: candidate,
      sdp_mline_index: sdpMLineIndex
    });
  }

  /**
   * Hot-swap to a new source
   * @param {string} sourceType - 'udp' or 'file'
   * @param {object} config - Source configuration
   */
  hotSwap(sourceType, config) {
    console.log(`GStreamer WebRTC: Hot-swap to ${sourceType}`, config);
    this._sendCommand({
      type: 'hot_swap',
      source_type: sourceType,
      source_config: config
    });
    this.currentSource = { type: sourceType, config };
  }

  /**
   * Get current status
   */
  getStatus() {
    return {
      ready: this.isReady,
      clients: this.clients.size,
      source: this.currentSource
    };
  }

  /**
   * Stop the service
   */
  async stop() {
    console.log('GStreamer WebRTC: Stopping');

    if (this.ipcSocket) {
      try {
        this._sendCommand({ type: 'stop' });
        // Give Python time to cleanup
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (e) {
        // Ignore
      }
    }

    if (this.pythonProcess) {
      this.pythonProcess.kill('SIGTERM');
      // Give it time to exit gracefully
      await new Promise(resolve => setTimeout(resolve, 500));
      if (this.pythonProcess && !this.pythonProcess.killed) {
        this.pythonProcess.kill('SIGKILL');
      }
      this.pythonProcess = null;
    }

    if (this.ipcSocket) {
      this.ipcSocket.destroy();
      this.ipcSocket = null;
    }

    if (this.ipcServer) {
      this.ipcServer.close();
      this.ipcServer = null;
    }

    if (existsSync(this.ipcPath)) {
      try {
        unlinkSync(this.ipcPath);
      } catch (e) {
        // Ignore
      }
    }

    this.clients.clear();
    this.isReady = false;
    this.currentSource = null;
    this.removeAllListeners();

    console.log('GStreamer WebRTC: Stopped');
  }
}

export default GStreamerWebRTCService;
