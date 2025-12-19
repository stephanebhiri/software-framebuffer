/**
 * WebRTC Service using mediasoup
 * Handles video streaming to browsers via WebRTC
 * Video input comes from GStreamer via RTP
 */
import * as mediasoup from 'mediasoup';
import { EventEmitter } from 'events';

// mediasoup configuration
const MEDIASOUP_CONFIG = {
  worker: {
    rtcMinPort: 10000,
    rtcMaxPort: 10100,
    logLevel: 'warn',
    logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp']
  },
  router: {
    mediaCodecs: [
      {
        kind: 'video',
        mimeType: 'video/VP8',
        clockRate: 90000,
        parameters: {}
      },
      {
        kind: 'video',
        mimeType: 'video/H264',
        clockRate: 90000,
        parameters: {
          'packetization-mode': 1,
          'profile-level-id': '42e01f',
          'level-asymmetry-allowed': 1
        }
      }
    ]
  },
  webRtcTransport: {
    listenIps: [
      { ip: '0.0.0.0', announcedIp: null }
    ],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: 1000000
  }
};

export class WebRTCService extends EventEmitter {
  constructor() {
    super();
    this.worker = null;
    this.router = null;
    this.producer = null;
    this.plainTransport = null;
    this.clients = new Map(); // clientId -> { transport, consumer, connectionTimeout }
    this.isReady = false;
    this.rtpPort = null;

    // Recovery settings
    this.workerRestartAttempts = 0;
    this.maxWorkerRestarts = 3;
    this.workerRestartDelay = 3000;

    // Timeouts
    this.transportConnectTimeout = 15000;
  }

  /**
   * Initialize mediasoup worker and router
   */
  async init() {
    console.log('Initializing mediasoup...');

    // Create worker
    this.worker = await mediasoup.createWorker(MEDIASOUP_CONFIG.worker);

    this.worker.on('died', (error) => {
      console.error('mediasoup worker died:', error);
      this._handleWorkerCrash(error);
    });

    // Create router
    this.router = await this.worker.createRouter({
      mediaCodecs: MEDIASOUP_CONFIG.router.mediaCodecs
    });

    console.log('mediasoup initialized');
    this.isReady = true;
    this.workerRestartAttempts = 0; // Reset on successful init
    return this.router.rtpCapabilities;
  }

  /**
   * Handle worker crash with auto-recovery
   */
  _handleWorkerCrash(error) {
    this.isReady = false;
    this.router = null;
    this.producer = null;
    this.plainTransport = null;
    this.rtpPort = null;

    // Notify all clients
    this.emit('worker-died', error);

    // Clear all client transports (they're now invalid)
    for (const [clientId, client] of this.clients) {
      if (client.connectionTimeout) clearTimeout(client.connectionTimeout);
    }
    this.clients.clear();

    // Attempt restart
    if (this.workerRestartAttempts < this.maxWorkerRestarts) {
      this.workerRestartAttempts++;
      console.log(`mediasoup: Restart attempt ${this.workerRestartAttempts}/${this.maxWorkerRestarts} in ${this.workerRestartDelay}ms`);

      setTimeout(async () => {
        try {
          await this.init();
          console.log('mediasoup: Worker restarted successfully');
          this.emit('worker-restarted');
        } catch (err) {
          console.error('mediasoup: Worker restart failed:', err.message);
          this.emit('worker-restart-failed', err);
        }
      }, this.workerRestartDelay);
    } else {
      console.error(`mediasoup: Max restart attempts (${this.maxWorkerRestarts}) reached`);
      this.emit('worker-failed', 'max_restarts_exceeded');
    }
  }

  /**
   * Get router RTP capabilities for client
   */
  getRtpCapabilities() {
    if (!this.router) {
      throw new Error('Router not initialized');
    }
    return this.router.rtpCapabilities;
  }

  /**
   * Start video ingest - creates RTP transport for GStreamer to send to
   * @returns {number} RTP port that GStreamer should send VP8 RTP to
   */
  async startIngest() {
    if (!this.router) {
      await this.init();
    }

    console.log('Starting WebRTC video ingest...');

    // Create plain RTP transport for GStreamer input
    this.plainTransport = await this.router.createPlainTransport({
      listenIp: { ip: '127.0.0.1', announcedIp: null },
      rtcpMux: false,
      comedia: true
    });

    this.rtpPort = this.plainTransport.tuple.localPort;
    console.log(`Plain transport: RTP port ${this.rtpPort}`);

    // Create producer for video
    this.producer = await this.plainTransport.produce({
      kind: 'video',
      rtpParameters: {
        codecs: [
          {
            mimeType: 'video/VP8',
            payloadType: 96,
            clockRate: 90000
          }
        ],
        encodings: [{ ssrc: 22222222 }]
      }
    });

    console.log(`Producer created: ${this.producer.id}`);
    this.emit('producer-ready', this.producer.id);

    // Return the RTP port for GStreamer to send to
    return this.rtpPort;
  }

  /**
   * Get the RTP port for GStreamer
   */
  getRtpPort() {
    return this.rtpPort;
  }

  /**
   * Create WebRTC transport for a client
   */
  async createClientTransport(clientId) {
    if (!this.router) {
      throw new Error('Router not initialized');
    }

    const transport = await this.router.createWebRtcTransport({
      ...MEDIASOUP_CONFIG.webRtcTransport,
      listenIps: [{ ip: '0.0.0.0', announcedIp: '127.0.0.1' }]
    });

    // Connection timeout
    const connectionTimeout = setTimeout(() => {
      const client = this.clients.get(clientId);
      if (client && client.transport && !client.transport.closed) {
        console.warn(`Transport connection timeout for client ${clientId}`);
        this.removeClient(clientId);
      }
    }, this.transportConnectTimeout);

    // DTLS state monitoring
    transport.on('dtlsstatechange', (state) => {
      if (state === 'connected') {
        const client = this.clients.get(clientId);
        if (client?.connectionTimeout) {
          clearTimeout(client.connectionTimeout);
          client.connectionTimeout = null;
        }
      }
      if (state === 'closed' || state === 'failed') {
        console.log(`Transport ${state} for client ${clientId}`);
        this.removeClient(clientId);
      }
    });

    // ICE state monitoring
    transport.on('icestatechange', (state) => {
      if (state === 'disconnected') {
        console.warn(`ICE disconnected for client ${clientId}`);
        // Give time to reconnect before cleanup
        setTimeout(() => {
          const client = this.clients.get(clientId);
          if (client?.transport?.iceState === 'disconnected') {
            console.warn(`ICE still disconnected for ${clientId}, removing`);
            this.removeClient(clientId);
          }
        }, 5000);
      }
    });

    // Transport error handler
    transport.on('error', (error) => {
      console.error(`Transport error for client ${clientId}:`, error.message);
      this.removeClient(clientId);
    });

    this.clients.set(clientId, { transport, consumer: null, connectionTimeout });
    console.log(`Created transport for client ${clientId}`);

    return {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters
    };
  }

  /**
   * Connect client transport with DTLS parameters
   */
  async connectTransport(clientId, dtlsParameters) {
    const client = this.clients.get(clientId);
    if (!client) {
      throw new Error(`Client ${clientId} not found`);
    }

    await client.transport.connect({ dtlsParameters });
    console.log(`Transport connected for client ${clientId}`);
  }

  /**
   * Create consumer for client to receive video
   */
  async createConsumer(clientId, rtpCapabilities) {
    const client = this.clients.get(clientId);
    if (!client) {
      throw new Error(`Client ${clientId} not found`);
    }

    if (!this.producer) {
      throw new Error('No producer available');
    }

    if (!this.router.canConsume({ producerId: this.producer.id, rtpCapabilities })) {
      throw new Error('Client cannot consume this producer');
    }

    const consumer = await client.transport.consume({
      producerId: this.producer.id,
      rtpCapabilities,
      paused: false
    });

    client.consumer = consumer;
    console.log(`Created consumer for client ${clientId}`);

    return {
      id: consumer.id,
      producerId: this.producer.id,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters
    };
  }

  /**
   * Resume consumer
   */
  async resumeConsumer(clientId) {
    const client = this.clients.get(clientId);
    if (client?.consumer) {
      await client.consumer.resume();
      console.log(`Consumer resumed for client ${clientId}`);
    }
  }

  /**
   * Remove client and cleanup resources
   */
  removeClient(clientId) {
    const client = this.clients.get(clientId);
    if (client) {
      if (client.connectionTimeout) clearTimeout(client.connectionTimeout);
      if (client.consumer && !client.consumer.closed) client.consumer.close();
      if (client.transport && !client.transport.closed) client.transport.close();
      this.clients.delete(clientId);
      console.log(`Client ${clientId} removed`);
    }
  }

  /**
   * Stop the service
   */
  async stop() {
    // Close producer
    if (this.producer) {
      this.producer.close();
      this.producer = null;
    }

    // Close RTP transport
    if (this.plainTransport) {
      this.plainTransport.close();
      this.plainTransport = null;
    }
    this.rtpPort = null;

    // Close all client transports
    for (const [clientId] of this.clients) {
      this.removeClient(clientId);
    }

    // Close router
    if (this.router) {
      this.router.close();
      this.router = null;
    }

    // Close worker
    if (this.worker) {
      this.worker.close();
      this.worker = null;
    }

    this.isReady = false;
    this.removeAllListeners();
    console.log('WebRTC service stopped');
  }
}

export default WebRTCService;
