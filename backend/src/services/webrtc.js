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
    this.clients = new Map(); // clientId -> { transport, consumer }
    this.isReady = false;
    this.rtpPort = null;
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
      this.emit('error', error);
    });

    // Create router
    this.router = await this.worker.createRouter({
      mediaCodecs: MEDIASOUP_CONFIG.router.mediaCodecs
    });

    console.log('mediasoup initialized');
    this.isReady = true;
    return this.router.rtpCapabilities;
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

    transport.on('dtlsstatechange', (state) => {
      if (state === 'closed') {
        console.log(`Transport closed for client ${clientId}`);
        this.removeClient(clientId);
      }
    });

    this.clients.set(clientId, { transport, consumer: null });
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
   * Remove client
   */
  removeClient(clientId) {
    const client = this.clients.get(clientId);
    if (client) {
      if (client.consumer) client.consumer.close();
      if (client.transport) client.transport.close();
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
