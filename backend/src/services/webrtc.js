/**
 * WebRTC Service using mediasoup
 * Handles video streaming from UDP to browsers via WebRTC
 */
import * as mediasoup from 'mediasoup';
import { spawn } from 'child_process';
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
    this.ffmpeg = null;
    this.isReady = false;
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
   * Start video ingest - returns a writable stream for TS data
   */
  async startIngest() {
    if (!this.router) {
      await this.init();
    }

    console.log('Starting WebRTC video ingest...');

    // Create plain RTP transport for FFmpeg input
    this.plainTransport = await this.router.createPlainTransport({
      listenIp: { ip: '127.0.0.1', announcedIp: null },
      rtcpMux: false,
      comedia: true
    });

    console.log(`Plain transport: RTP port ${this.plainTransport.tuple.localPort}`);

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

    // Start FFmpeg to transcode piped TS to RTP VP8
    const rtpPort = this.plainTransport.tuple.localPort;
    this.startFFmpeg(rtpPort);

    this.emit('producer-ready', this.producer.id);

    // Return stdin for piping data
    return this.ffmpeg?.stdin;
  }

  /**
   * Start FFmpeg process - reads from stdin, outputs RTP to mediasoup
   */
  startFFmpeg(rtpPort) {
    const rtpTarget = `rtp://127.0.0.1:${rtpPort}`;

    console.log(`Starting FFmpeg transcoder -> ${rtpTarget}`);

    this.ffmpeg = spawn('ffmpeg', [
      '-fflags', '+genpts',
      '-f', 'mpegts',
      '-i', 'pipe:0',           // Read from stdin
      '-map', '0:v:0?',          // Map first video stream if exists
      '-c:v', 'libvpx',
      '-deadline', 'realtime',
      '-cpu-used', '8',
      '-b:v', '1M',
      '-g', '30',
      '-an',                     // No audio
      '-f', 'rtp',
      '-ssrc', '22222222',
      '-payload_type', '96',
      rtpTarget
    ], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.ffmpeg.stderr.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('frame=')) {
        // Progress update
        if (Math.random() < 0.02) {
          console.log('FFmpeg:', msg.trim().slice(0, 60));
        }
      } else if (msg.includes('Error') || msg.includes('error')) {
        console.error('FFmpeg error:', msg.trim());
      } else if (msg.includes('Output')) {
        console.log('FFmpeg output started');
      }
    });

    this.ffmpeg.on('close', (code) => {
      console.log('FFmpeg exited with code:', code);
      this.ffmpeg = null;
    });

    this.ffmpeg.on('error', (err) => {
      console.error('FFmpeg spawn error:', err);
    });
  }

  /**
   * Write TS data to FFmpeg
   */
  writeData(data) {
    if (this.ffmpeg?.stdin?.writable) {
      this.ffmpeg.stdin.write(data);
      return true;
    }
    return false;
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
    if (this.ffmpeg) {
      this.ffmpeg.stdin.end();
      this.ffmpeg.kill('SIGTERM');
      this.ffmpeg = null;
    }

    if (this.producer) {
      this.producer.close();
      this.producer = null;
    }

    if (this.plainTransport) {
      this.plainTransport.close();
      this.plainTransport = null;
    }

    for (const [clientId] of this.clients) {
      this.removeClient(clientId);
    }

    if (this.router) {
      this.router.close();
      this.router = null;
    }

    if (this.worker) {
      this.worker.close();
      this.worker = null;
    }

    this.isReady = false;
    console.log('WebRTC service stopped');
  }
}

export default WebRTCService;
