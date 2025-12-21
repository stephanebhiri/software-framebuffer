/**
 * KLV Display Backend
 * Express + WebSocket server for STANAG 4609 metadata streaming
 * Uses GStreamer webrtcbin for WebRTC (replacing mediasoup)
 */
import express from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'fs';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';

import { parseKLV, formatKLVForDisplay } from './parsers/klv.js';
import FFmpegService from './services/ffmpeg.js';
import GStreamerWebRTCService from './services/gstreamer-webrtc.js';
import FrameBufferService from './services/framebuffer.js';
import UDPKLVSplitter from './services/udp-klv-splitter.js';
import WebRTCGatewayService from './services/webrtc-gateway.js';
import UDPDuplicator from './services/udp-duplicator.js';
import orchestrator from './services/orchestrator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Middleware
app.use(cors());
app.use(express.json());

// Static files for HLS
const hlsDir = join(__dirname, '../hls');
if (!existsSync(hlsDir)) mkdirSync(hlsDir, { recursive: true });
app.use('/hls', express.static(hlsDir));

// Store active clients and current stream
const clients = new Map(); // ws -> { id, ... }
let ffmpegService = null;
let webrtcService = null;
let frameBufferService = null;
let klvSplitter = null;
let webrtcGateway = null;  // New C-based WebRTC gateway
let udpDuplicator = null;  // UDP duplicator for monitoring
let currentSource = null;
let streamMode = null; // 'file' or 'udp'
let useFrameBuffer = true; // Enable FrameBuffer for stable output timing
let useShmArchitecture = true; // Use new SHM + webrtc-gateway architecture
const MONITOR_PORT = 5004; // Port for ffplay monitoring

// ===== WebRTC Service Setup =====
function setupWebRTCService() {
  webrtcService = new GStreamerWebRTCService();

  // Handle SDP offer from GStreamer
  webrtcService.on('offer', (clientId, sdp) => {
    console.log(`WebRTC: Sending offer to ${clientId}`);
    for (const [ws, client] of clients) {
      if (client.id === clientId && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'webrtc-offer',
          sdp
        }));
        break;
      }
    }
  });

  // Handle ICE candidate from GStreamer
  webrtcService.on('ice-candidate', (clientId, candidate) => {
    for (const [ws, client] of clients) {
      if (client.id === clientId && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'webrtc-ice-candidate',
          candidate: candidate.candidate,
          sdpMLineIndex: candidate.sdpMLineIndex
        }));
        break;
      }
    }
  });

  // Handle KLV data from GStreamer
  webrtcService.on('klv', (klvData) => {
    try {
      const { packets } = parseKLV(klvData);
      for (const packet of packets) {
        const formatted = formatKLVForDisplay(packet);
        broadcast({
          type: 'klv',
          data: formatted
        });
      }
    } catch (error) {
      // KLV parsing errors are common, don't spam logs
    }
  });

  // Handle client connection state
  webrtcService.on('client-connected', (clientId) => {
    console.log(`WebRTC: Client ${clientId} connected`);
    for (const [ws, client] of clients) {
      if (client.id === clientId && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'webrtc-connected' }));
        break;
      }
    }
  });

  webrtcService.on('client-failed', (clientId) => {
    console.log(`WebRTC: Client ${clientId} failed`);
  });

  // Handle hot-swap complete
  webrtcService.on('hot-swap-complete', () => {
    console.log('WebRTC: Hot-swap complete');
    broadcast({ type: 'stream-switched', source: currentSource });
  });

  // Handle pipeline errors
  webrtcService.on('pipeline-error', (message) => {
    console.error('WebRTC: Pipeline error:', message);
    broadcast({ type: 'stream-error', message });
  });

  webrtcService.on('closed', (code) => {
    console.log('WebRTC: Service closed with code:', code);
    if (streamMode === 'udp') {
      broadcast({ type: 'stream-ended' });
    }
  });

  return webrtcService;
}

// Initialize service
webrtcService = setupWebRTCService();

// ===== WebRTC Gateway Setup (new SHM-based architecture) =====
function setupWebRTCGateway() {
  const gateway = new WebRTCGatewayService();

  // Forward SDP offer to all clients (gateway creates offer, browser answers)
  gateway.on('offer', (sdp) => {
    console.log('WebRTC Gateway: Sending offer to clients');
    for (const [ws, client] of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'webrtc-offer',
          sdp
        }));
      }
    }
  });

  // Forward SDP answer to all clients (if browser sent offer)
  gateway.on('answer', (sdp) => {
    console.log('WebRTC Gateway: Sending answer to clients');
    for (const [ws, client] of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'webrtc-answer',
          sdp
        }));
      }
    }
  });

  // Forward ICE candidates to all clients
  gateway.on('ice-candidate', (candidate) => {
    for (const [ws, client] of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'webrtc-ice-candidate',
          candidate: candidate.candidate,
          sdpMLineIndex: candidate.sdpMLineIndex
        }));
      }
    }
  });

  gateway.on('client-connected', () => {
    console.log('WebRTC Gateway: Client connected');
    broadcast({ type: 'webrtc-connected' });
  });

  gateway.on('client-disconnected', () => {
    console.log('WebRTC Gateway: Client disconnected');
  });

  gateway.on('error', (error) => {
    console.error('WebRTC Gateway error:', error);
    broadcast({ type: 'stream-error', message: error.message });
  });

  gateway.on('closed', (code) => {
    console.log('WebRTC Gateway closed with code:', code);
    webrtcGateway = null;
  });

  return gateway;
}

// ===== WebSocket Connection Handling =====
wss.on('connection', (ws) => {
  const clientId = randomUUID();
  ws.isAlive = true;
  clients.set(ws, { id: clientId });
  console.log(`Client connected: ${clientId}`);

  // Heartbeat pong response
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      await handleClientMessage(ws, data);
    } catch (e) {
      console.error('Error handling message:', e);
      ws.send(JSON.stringify({ type: 'error', message: e.message }));
    }
  });

  ws.on('close', () => {
    const client = clients.get(ws);
    if (client) {
      console.log(`Client disconnected: ${client.id}`);
      // Clean up WebRTC resources
      if (webrtcService?.isReady) {
        webrtcService.removeClient(client.id);
      }
      clients.delete(ws);
    }
  });

  ws.on('error', (error) => {
    console.error(`WebSocket error for client:`, error.message);
    const client = clients.get(ws);
    if (client && webrtcService?.isReady) {
      webrtcService.removeClient(client.id);
    }
    clients.delete(ws);
  });

  // Send current status
  const webrtcReady = webrtcService?.isReady || webrtcGateway?.isReady;
  ws.send(JSON.stringify({
    type: 'status',
    clientId,
    streaming: !!(ffmpegService || webrtcReady),
    source: currentSource,
    mode: streamMode,
    hlsUrl: (streamMode === 'file' && ffmpegService) ? '/hls/playlist.m3u8' : null,
    webrtc: streamMode === 'udp' && webrtcReady
  }));
});

// WebSocket heartbeat interval (30s)
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      console.log('Terminating dead WebSocket connection');
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(heartbeatInterval);
});

// ===== Message Handler =====
async function handleClientMessage(ws, data) {
  const client = clients.get(ws);
  if (!client) return;

  console.log('Received message:', data.type);

  switch (data.type) {
    // Stream control
    case 'start':
      await startFileStream(data.file);
      break;
    case 'start-udp':
      await startUDPStream(data.port || 5000);
      break;
    case 'stop':
      await stopStream();
      break;

    // WebRTC signaling
    case 'webrtc-init':
      // Client wants to join WebRTC
      if (useShmArchitecture && webrtcGateway?.isReady) {
        // New SHM architecture: start pipeline on webrtc-gateway
        webrtcGateway.startPipeline();
      } else if (webrtcService?.isReady) {
        // Legacy Python-based WebRTC
        webrtcService.addClient(client.id);
      } else {
        ws.send(JSON.stringify({
          type: 'error',
          message: 'WebRTC not ready. Start a UDP stream first.'
        }));
      }
      break;

    case 'webrtc-offer':
      // Browser sends SDP offer (for SHM architecture where browser initiates)
      if (useShmArchitecture && webrtcGateway?.isReady) {
        webrtcGateway.setOffer(data.sdp);
      }
      break;

    case 'webrtc-answer':
      // Browser sends SDP answer
      if (useShmArchitecture && webrtcGateway?.isReady) {
        webrtcGateway.setAnswer(data.sdp);
      } else if (webrtcService?.isReady) {
        webrtcService.setAnswer(client.id, data.sdp);
      }
      break;

    case 'webrtc-ice-candidate':
      // Browser sends ICE candidate
      if (useShmArchitecture && webrtcGateway?.isReady && data.candidate) {
        webrtcGateway.addIceCandidate(
          data.candidate,
          data.sdpMLineIndex || 0,
          data.sdpMid
        );
      } else if (webrtcService?.isReady && data.candidate) {
        webrtcService.addIceCandidate(
          client.id,
          data.candidate,
          data.sdpMLineIndex || 0
        );
      }
      break;
  }
}

// ===== Stream Control =====
function broadcast(message) {
  const data = JSON.stringify(message);
  for (const [ws] of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

// ===== FILE STREAM MODE (HLS) =====
async function startFileStream(filePath) {
  console.log('Starting file stream:', filePath);
  await stopStream();

  currentSource = filePath;
  streamMode = 'file';
  ffmpegService = new FFmpegService();

  // Start HLS transcoding
  ffmpegService.startHLSTranscode(filePath, hlsDir);

  // Start KLV extraction
  ffmpegService.startKLVExtraction(filePath);

  let klvBuffer = Buffer.alloc(0);

  ffmpegService.on('klv-data', (chunk) => {
    klvBuffer = Buffer.concat([klvBuffer, chunk]);
    processKLVBuffer(klvBuffer, (remaining) => { klvBuffer = remaining; });
  });

  ffmpegService.on('close', () => {
    broadcast({ type: 'stream-ended' });
    ffmpegService = null;
  });

  broadcast({
    type: 'stream-started',
    mode: 'file',
    source: filePath,
    hlsUrl: '/hls/playlist.m3u8'
  });
}

// ===== UDP STREAM MODE with WebRTC =====
async function startUDPStream(port = 5000) {
  console.log('Starting UDP stream on port:', port);

  // Check for hot-swap
  const isHotSwap = useShmArchitecture ? webrtcGateway?.isReady : webrtcService?.isReady;

  if (isHotSwap) {
    // Hot-swap: FrameBuffer handles source changes gracefully
    console.log('Hot-swap: switching source (FrameBuffer handles transition)');
    currentSource = `udp://0.0.0.0:${port}`;
    broadcast({ type: 'source-switching' });
    return;
  }

  // Cold start: stop everything and start fresh
  await stopStream();

  currentSource = `udp://0.0.0.0:${port}`;
  streamMode = 'udp';

  // Port allocation:
  // port     = Simulator output, KLV Splitter input
  // port + 1 = KLV Splitter output, FrameBuffer input
  let splitterOutputPort = port + 1;
  const shmPath = '/tmp/framebuffer.sock';

  // Start KLV Splitter first (extracts metadata, forwards stream)
  try {
    klvSplitter = new UDPKLVSplitter();
    await klvSplitter.start({
      inputPort: port,
      outputPort: splitterOutputPort,
      outputHost: '127.0.0.1'
    });

    // Handle KLV events from splitter
    klvSplitter.on('klv', (klvData) => {
      try {
        const { packets } = parseKLV(klvData);
        for (const packet of packets) {
          const formatted = formatKLVForDisplay(packet);
          broadcast({ type: 'klv', data: formatted });
        }
      } catch (error) {
        // KLV parsing errors are common
      }
    });
  } catch (error) {
    console.warn('KLV Splitter failed:', error.message);
    klvSplitter = null;
    splitterOutputPort = port; // Fallback: FrameBuffer reads directly
  }

  // ===== NEW VP8 RTP ARCHITECTURE =====
  // FrameBuffer (-v) → VP8 RTP UDP → UDPDuplicator → webrtc-gateway → WebRTC
  //                                               → ffplay (monitor port)
  // This preserves the perfect timing from FrameBuffer's VP8 output
  if (useShmArchitecture && useFrameBuffer) {
    const framebufferOutputPort = port + 3;  // FrameBuffer outputs here
    const webrtcGatewayPort = port + 2;      // WebRTC gateway listens here

    try {
      // Start FrameBuffer with VP8 RTP output
      // MPEG2 4K decodes at ~4fps, so use 5fps to minimize repeated frames
      // H.264 typically decodes fast enough for 15fps
      const isMpeg2 = simulatorCodec === 'mpeg2';
      const outputFps = isMpeg2 ? 5 : 15;
      console.log(`Output fps: ${outputFps} (codec: ${simulatorCodec || 'unknown'})`);
      frameBufferService = new FrameBufferService();
      await frameBufferService.start({
        inputPort: splitterOutputPort,
        outputPort: framebufferOutputPort,
        outputHost: '127.0.0.1',
        width: 640,
        height: 480,
        fps: outputFps,
        bitrate: 2000,
        vp8Output: true  // VP8 RTP output (perfect timing)
      });
      console.log(`FrameBuffer started (VP8 RTP mode @ ${outputFps}fps) -> UDP:${framebufferOutputPort}`);

      // Listen for stats events
      frameBufferService.on('stats', (stats) => {
        broadcast({ type: 'framebuffer-stats', stats });
      });

      // Start UDP Duplicator to split stream for WebRTC and monitoring
      udpDuplicator = new UDPDuplicator();
      udpDuplicator.start(framebufferOutputPort, [
        { host: '127.0.0.1', port: webrtcGatewayPort },  // For webrtc-gateway
        { host: '127.0.0.1', port: MONITOR_PORT }        // For ffplay monitoring
      ]);
      console.log(`UDP Duplicator: ${framebufferOutputPort} -> ${webrtcGatewayPort} + ${MONITOR_PORT} (monitor)`);

      // Start WebRTC Gateway (receives VP8 RTP from duplicator)
      webrtcGateway = setupWebRTCGateway();
      await webrtcGateway.start({
        udpPort: webrtcGatewayPort
      });
      console.log(`WebRTC Gateway started (listening on UDP:${webrtcGatewayPort})`);

      broadcast({
        type: 'stream-started',
        mode: 'udp',
        source: currentSource,
        webrtc: true,
        architecture: 'vp8-rtp',
        framebuffer: true,
        monitorPort: MONITOR_PORT
      });

      console.log(`\n>>> Monitor with ffplay: ffplay -protocol_whitelist file,udp,rtp -i rtp://127.0.0.1:${MONITOR_PORT}\n`);

      return;
    } catch (error) {
      console.warn('VP8 RTP architecture failed, falling back to legacy:', error.message);
      // Clean up partial state
      if (frameBufferService?.isRunning) {
        await frameBufferService.stop();
        frameBufferService = null;
      }
      if (udpDuplicator?.isRunning) {
        udpDuplicator.stop();
        udpDuplicator = null;
      }
      if (webrtcGateway) {
        await webrtcGateway.stop();
        webrtcGateway = null;
      }
      // Fall through to legacy architecture
    }
  }

  // ===== LEGACY ARCHITECTURE =====
  // FrameBuffer → VP8 UDP → Python WebRTC
  let webrtcPort = port;
  let framebufferOutputPort = port + 2;
  let outputMode = 'vp8';

  if (useFrameBuffer) {
    try {
      frameBufferService = new FrameBufferService();
      await frameBufferService.start({
        inputPort: splitterOutputPort,
        outputPort: framebufferOutputPort,
        outputHost: '127.0.0.1',
        width: 640,
        height: 480,
        fps: 25,
        bitrate: 2000,
        vp8Output: outputMode === 'vp8',
        rawOutput: outputMode === 'raw'
      });
      console.log(`FrameBuffer started (${outputMode.toUpperCase()} mode)`);
      webrtcPort = framebufferOutputPort;
      console.log(`FrameBuffer: Input ${splitterOutputPort} -> Output ${webrtcPort}`);

      // Listen for stats events
      frameBufferService.on('stats', (stats) => {
        broadcast({ type: 'framebuffer-stats', stats });
      });
    } catch (error) {
      console.warn('FrameBuffer not available, using direct input:', error.message);
      frameBufferService = null;
      webrtcPort = splitterOutputPort;
      outputMode = 'h264';  // Fallback to H.264 MPEG-TS
    }
  } else {
    webrtcPort = splitterOutputPort;
    outputMode = 'h264';
  }

  // Reinitialize service if needed
  if (!webrtcService) {
    webrtcService = setupWebRTCService();
  }

  // Start GStreamer WebRTC pipeline
  try {
    await webrtcService.start('udp', {
      port: webrtcPort,
      codec: simulatorCodec,
      vp8: outputMode === 'vp8',   // VP8 RTP passthrough (no encode)
      raw: outputMode === 'raw',   // Raw RTP input (encode to VP8)
      width: 640,                  // Must match FrameBuffer output
      height: 480
    });
    console.log(`WebRTC pipeline started on port ${webrtcPort} (${outputMode.toUpperCase()} mode)`);
  } catch (error) {
    console.error('Failed to start WebRTC:', error);
    broadcast({ type: 'error', message: error.message });
    return;
  }

  broadcast({
    type: 'stream-started',
    mode: 'udp',
    source: currentSource,
    webrtc: true,
    architecture: 'legacy',
    framebuffer: frameBufferService?.isRunning || false
  });
}

// ===== COMMON =====
function processKLVBuffer(buffer, updateCallback) {
  const { packets, consumed } = parseKLV(buffer);

  if (consumed > 0) {
    updateCallback(buffer.subarray(consumed));
  }

  for (const packet of packets) {
    const formatted = formatKLVForDisplay(packet);
    broadcast({
      type: 'klv',
      data: formatted
    });
  }
}

// Full stop
async function stopStream() {
  console.log('Stopping stream');

  // Stop all managed processes via orchestrator
  orchestrator.stopAll();

  if (ffmpegService) {
    ffmpegService.stop();
    ffmpegService = null;
  }

  if (webrtcGateway?.isReady) {
    await webrtcGateway.stop();
    webrtcGateway = null;
  }

  if (webrtcService?.isReady) {
    await webrtcService.stop();
    // Reinitialize for next use
    webrtcService = setupWebRTCService();
  }

  if (frameBufferService?.isRunning) {
    await frameBufferService.stop();
    frameBufferService = null;
  }

  if (klvSplitter?.isRunning) {
    await klvSplitter.stop();
    klvSplitter = null;
  }

  if (udpDuplicator?.isRunning) {
    udpDuplicator.stop();
    udpDuplicator = null;
  }

  currentSource = null;
  streamMode = null;
  broadcast({ type: 'stream-stopped' });
}

// ===== REST API =====
app.get('/api/status', (req, res) => {
  res.json({
    streaming: !!(ffmpegService || webrtcService?.isReady || webrtcGateway?.isReady),
    source: currentSource,
    mode: streamMode,
    clients: clients.size,
    webrtcReady: webrtcService?.isReady || webrtcGateway?.isReady || false,
    architecture: useShmArchitecture ? 'shm' : 'legacy',
    simulator: simulatorProcess ? { running: true, codec: simulatorCodec } : { running: false },
    webrtc: webrtcService?.getStatus() || null,
    webrtcGateway: webrtcGateway?.getStatus() || { running: false },
    framebuffer: frameBufferService?.getStatus() || { running: false },
    processes: orchestrator.getAllStatus()
  });
});

app.post('/api/stream/file', async (req, res) => {
  const { file } = req.body;
  if (!file) {
    return res.status(400).json({ error: 'File path required' });
  }
  try {
    await startFileStream(file);
    res.json({ success: true, mode: 'file' });
  } catch (error) {
    console.error('Failed to start file stream:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/stream/udp', async (req, res) => {
  const { port } = req.body;
  try {
    await startUDPStream(port || 5000);
    res.json({ success: true, mode: 'udp', port: port || 5000 });
  } catch (error) {
    console.error('Failed to start UDP stream:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/stream/stop', async (req, res) => {
  try {
    await stopStream();
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to stop stream:', error);
    res.status(500).json({ error: error.message });
  }
});

// ===== Simulator Control =====
let simulatorProcess = null;
let simulatorCodec = 'h264';
const SIMULATOR_PID_FILE = join(__dirname, '../.simulator.pid');

function killSimulator() {
  return new Promise((resolve) => {
    const pidsToKill = new Set();

    if (simulatorProcess && simulatorProcess.pid) {
      pidsToKill.add(simulatorProcess.pid);
    }

    if (existsSync(SIMULATOR_PID_FILE)) {
      try {
        const pid = parseInt(readFileSync(SIMULATOR_PID_FILE, 'utf8'));
        if (pid) pidsToKill.add(pid);
      } catch (e) {}
      try { unlinkSync(SIMULATOR_PID_FILE); } catch (e) {}
    }

    for (const pid of pidsToKill) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (e) {}
    }

    simulatorProcess = null;
    setTimeout(resolve, 100);
  });
}

const SAMPLE_FILES = [
  { id: 'cheyenne', name: 'Cheyenne', file: '/Users/stephane/Documents/CV_Stephane_Bhiri/KLV_Display/samples/QGISFMV_Samples/MISB/Cheyenne.ts', codec: 'h264' },
  { id: 'falls', name: 'Falls', file: '/Users/stephane/Documents/CV_Stephane_Bhiri/KLV_Display/samples/QGISFMV_Samples/MISB/falls.ts', codec: 'h264' },
  { id: 'klv_test', name: 'KLV Test Sync', file: '/Users/stephane/Documents/CV_Stephane_Bhiri/KLV_Display/samples/QGISFMV_Samples/MISB/klv_metadata_test_sync.ts', codec: 'h264' },
  { id: 'day_flight', name: 'Day Flight', file: '/Users/stephane/Documents/CV_Stephane_Bhiri/KLV_Display/samples/Day_Flight.mpg', codec: 'h264' },
  { id: 'night_flight', name: 'Night Flight IR', file: '/Users/stephane/Documents/CV_Stephane_Bhiri/KLV_Display/samples/Night_Flight_IR.mpg', codec: 'h264' },
  { id: 'esri_4k', name: 'Esri 4K MPEG2', file: '/Users/stephane/Documents/CV_Stephane_Bhiri/KLV_Display/samples/QGISFMV_Samples/MISB/Esri_multiplexer_0.mp4', codec: 'mpeg2' },
  { id: 'misb_4k', name: 'MISB 4K H264', file: '/Users/stephane/Documents/CV_Stephane_Bhiri/KLV_Display/samples/QGISFMV_Samples/multiplexor/MISB.mp4', codec: 'h264' },
];

app.get('/api/simulator/files', (req, res) => {
  res.json({ files: SAMPLE_FILES });
});

app.post('/api/simulator/start', async (req, res) => {
  const { fileId, port = 5000 } = req.body;
  const file = SAMPLE_FILES.find(f => f.id === fileId);

  if (!file) {
    return res.status(400).json({ error: 'Unknown file' });
  }

  await killSimulator();

  const ffmpegArgs = file.codec === 'mpeg2' ? [
    '-fflags', '+genpts+igndts+discardcorrupt',
    '-err_detect', 'ignore_err',
    '-re',
    '-stream_loop', '-1',
    '-i', file.file,
    '-map', '0:v:0',
    '-map', '0:d:0?',
    '-c', 'copy',
    '-muxdelay', '0',
    '-muxpreload', '0',
    '-f', 'mpegts',
    '-mpegts_copyts', '1',
    `udp://127.0.0.1:${port}?pkt_size=1316&buffer_size=65535`
  ] : [
    '-fflags', '+genpts+igndts',
    '-err_detect', 'ignore_err',
    '-re',
    '-stream_loop', '-1',
    '-i', file.file,
    '-map', '0:v?',
    '-map', '0:d?',
    '-c', 'copy',
    '-f', 'mpegts',
    `udp://127.0.0.1:${port}?pkt_size=1316`
  ];

  simulatorProcess = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

  simulatorProcess.stderr.on('data', (data) => {
    const msg = data.toString();
    if (msg.includes('frame=') && Math.random() < 0.01) {
      console.log('Simulator:', msg.trim().slice(0, 50));
    }
  });

  simulatorProcess.on('close', (code) => {
    console.log('Simulator stopped, code:', code);
    simulatorProcess = null;
    if (existsSync(SIMULATOR_PID_FILE)) unlinkSync(SIMULATOR_PID_FILE);
  });

  writeFileSync(SIMULATOR_PID_FILE, String(simulatorProcess.pid));
  simulatorCodec = file.codec || 'h264';
  console.log(`Simulator started: ${file.name} -> udp://127.0.0.1:${port} (PID: ${simulatorProcess.pid}, codec: ${simulatorCodec})`);

  // Check if UDP stream is already running
  const webrtcReady = webrtcService?.isReady || webrtcGateway?.isReady;

  if (streamMode === 'udp' && webrtcReady) {
    // Handle source switch when UDP stream is running
    // With FrameBuffer, we do NOT need to restart the pipeline!
    console.log(`Source switch to ${file.name} - FrameBuffer will handle transition`);
    broadcast({ type: 'source-switching', file: file.name });
    res.json({ success: true, file: file.name, port, codec: simulatorCodec });
  } else {
    // Start UDP stream processing (KLV splitter, FrameBuffer, WebRTC Gateway)
    try {
      await startUDPStream(port);
      res.json({ success: true, file: file.name, port, codec: simulatorCodec });
    } catch (error) {
      console.error('Failed to start UDP stream:', error);
      res.json({ success: true, file: file.name, port, codec: simulatorCodec, warning: 'Simulator started but stream processing failed' });
    }
  }
});

app.post('/api/simulator/stop', async (req, res) => {
  await killSimulator();
  res.json({ success: true });
});

// ===== Server Start =====
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`KLV Display backend running on http://localhost:${PORT}`);
  console.log(`WebSocket available on ws://localhost:${PORT}`);
  console.log(`\nModes:`);
  console.log(`  File:     POST /api/stream/file  { "file": "/path/to/file.ts" }`);
  console.log(`  UDP+RTC:  POST /api/stream/udp   { "port": 5000 }`);
});

// ===== Graceful Shutdown =====
let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n${signal} received, shutting down gracefully...`);

  clearInterval(heartbeatInterval);

  wss.clients.forEach(ws => {
    ws.close(1001, 'Server shutting down');
  });

  try {
    await stopStream();
  } catch (error) {
    console.error('Error stopping streams:', error);
  }

  try {
    await killSimulator();
  } catch (error) {
    console.error('Error killing simulator:', error);
  }

  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });

  setTimeout(() => {
    console.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection:', reason);
});
