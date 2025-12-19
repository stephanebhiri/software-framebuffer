/**
 * KLV Display Backend
 * Express + WebSocket server for STANAG 4609 metadata streaming
 * Supports file playback, live UDP streams, and WebRTC
 */
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'fs';
import { randomUUID } from 'crypto';

import { spawn } from 'child_process';
import { parseKLV, formatKLVForDisplay } from './parsers/klv.js';
import FFmpegService from './services/ffmpeg.js';
import GStreamerService from './services/gstreamer.js';
import WebRTCService from './services/webrtc.js';

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
let gstreamerService = null;
let webrtcService = null;
let currentSource = null;
let streamMode = null; // 'file' or 'udp'

// Initialize services
webrtcService = new WebRTCService();

// WebSocket handling with heartbeat
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
      if (webrtcService) {
        webrtcService.removeClient(client.id);
      }
      clients.delete(ws);
    }
  });

  ws.on('error', (error) => {
    console.error(`WebSocket error for client:`, error.message);
    const client = clients.get(ws);
    if (client && webrtcService) {
      webrtcService.removeClient(client.id);
    }
    clients.delete(ws);
  });

  // Send current status
  ws.send(JSON.stringify({
    type: 'status',
    clientId,
    streaming: !!(ffmpegService || gstreamerService),
    source: currentSource,
    mode: streamMode,
    hlsUrl: (streamMode === 'file' && ffmpegService) ? '/hls/playlist.m3u8' : null,
    webrtcAvailable: webrtcService?.isReady || false,
    webrtc: streamMode === 'udp',
    rtpCapabilities: (streamMode === 'udp' && webrtcService?.isReady) ? webrtcService.getRtpCapabilities() : null
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
      await handleWebRTCInit(ws, client);
      break;
    case 'webrtc-create-transport':
      await handleCreateTransport(ws, client);
      break;
    case 'webrtc-connect-transport':
      await handleConnectTransport(ws, client, data);
      break;
    case 'webrtc-consume':
      await handleConsume(ws, client, data);
      break;
    case 'webrtc-resume':
      await handleResume(ws, client);
      break;
  }
}

// ===== WebRTC Signaling Handlers =====

async function handleWebRTCInit(ws, client) {
  try {
    if (!webrtcService.isReady) {
      await webrtcService.init();
    }
    const rtpCapabilities = webrtcService.getRtpCapabilities();
    ws.send(JSON.stringify({
      type: 'webrtc-init-response',
      rtpCapabilities
    }));
  } catch (error) {
    ws.send(JSON.stringify({
      type: 'error',
      message: `WebRTC init failed: ${error.message}`
    }));
  }
}

async function handleCreateTransport(ws, client) {
  try {
    const transportParams = await webrtcService.createClientTransport(client.id);
    ws.send(JSON.stringify({
      type: 'webrtc-transport-created',
      transportParams
    }));
  } catch (error) {
    ws.send(JSON.stringify({
      type: 'error',
      message: `Transport creation failed: ${error.message}`
    }));
  }
}

async function handleConnectTransport(ws, client, data) {
  try {
    await webrtcService.connectTransport(client.id, data.dtlsParameters);
    ws.send(JSON.stringify({
      type: 'webrtc-transport-connected'
    }));
  } catch (error) {
    ws.send(JSON.stringify({
      type: 'error',
      message: `Transport connection failed: ${error.message}`
    }));
  }
}

async function handleConsume(ws, client, data) {
  try {
    const consumerParams = await webrtcService.createConsumer(client.id, data.rtpCapabilities);
    ws.send(JSON.stringify({
      type: 'webrtc-consumer-created',
      consumerParams
    }));
  } catch (error) {
    ws.send(JSON.stringify({
      type: 'error',
      message: `Consumer creation failed: ${error.message}`
    }));
  }
}

async function handleResume(ws, client) {
  try {
    await webrtcService.resumeConsumer(client.id);
    ws.send(JSON.stringify({
      type: 'webrtc-resumed'
    }));
  } catch (error) {
    ws.send(JSON.stringify({
      type: 'error',
      message: `Resume failed: ${error.message}`
    }));
  }
}

// ===== Stream Control =====

function broadcast(message) {
  const data = JSON.stringify(message);
  for (const [ws] of clients) {
    if (ws.readyState === 1) { // OPEN
      ws.send(data);
    }
  }
}

// ===== FILE STREAM MODE =====
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

// ===== UDP STREAM MODE with WebRTC (GStreamer) =====
async function startUDPStream(port = 5000) {
  console.log('Starting UDP stream on port:', port);
  await stopStream();

  currentSource = `udp://0.0.0.0:${port}`;
  streamMode = 'udp';

  // Initialize WebRTC and get RTP port
  let rtpPort;
  try {
    rtpPort = await webrtcService.startIngest();
    console.log(`WebRTC ingest ready, RTP port: ${rtpPort}`);
  } catch (error) {
    console.error('WebRTC ingest failed:', error);
    return;
  }

  // Start GStreamer pipeline (UDP → VP8/RTP → mediasoup + KLV extraction)
  gstreamerService = new GStreamerService();

  // Handle KLV events from GStreamer
  gstreamerService.on('klv', (klvData) => {
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
      console.error('KLV parsing error:', error.message);
    }
  });

  // Handle GStreamer pipeline errors
  gstreamerService.on('pipeline-failed', async (reason) => {
    console.error('GStreamer pipeline failed:', reason);
    broadcast({ type: 'stream-error', message: 'Pipeline failed: ' + reason });
    await stopStream();
  });

  gstreamerService.on('pipeline-stalled', (elapsed) => {
    console.warn('GStreamer pipeline stalled, attempting recovery');
    broadcast({ type: 'stream-warning', message: 'Stream stalled, recovering...' });
  });

  gstreamerService.on('stream-ended', () => {
    broadcast({ type: 'stream-ended' });
  });

  // Start the GStreamer pipeline
  gstreamerService.startUDP(port, rtpPort);

  broadcast({
    type: 'stream-started',
    mode: 'udp',
    source: currentSource,
    webrtc: true,
    rtpCapabilities: webrtcService.getRtpCapabilities()
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

async function stopStream() {
  if (ffmpegService) {
    ffmpegService.stop();
    ffmpegService = null;
  }
  if (gstreamerService) {
    gstreamerService.stop();
    gstreamerService = null;
  }
  if (webrtcService?.producer) {
    await webrtcService.stop();
    // Reinitialize for next use
    webrtcService = new WebRTCService();
  }
  currentSource = null;
  streamMode = null;
  broadcast({ type: 'stream-stopped' });
}

// REST API
app.get('/api/status', (req, res) => {
  res.json({
    streaming: !!(ffmpegService || gstreamerService),
    source: currentSource,
    mode: streamMode,
    clients: clients.size,
    webrtcReady: webrtcService?.isReady || false
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

// Simulator control
let simulatorProcess = null;
const SIMULATOR_PID_FILE = join(__dirname, '../.simulator.pid');

function killSimulator() {
  return new Promise((resolve) => {
    const pidsToKill = new Set();

    // Get PID from tracked process
    if (simulatorProcess && simulatorProcess.pid) {
      pidsToKill.add(simulatorProcess.pid);
    }

    // Get PID from file (for orphan recovery)
    if (existsSync(SIMULATOR_PID_FILE)) {
      try {
        const pid = parseInt(readFileSync(SIMULATOR_PID_FILE, 'utf8'));
        if (pid) pidsToKill.add(pid);
      } catch (e) {}
      try { unlinkSync(SIMULATOR_PID_FILE); } catch (e) {}
    }

    // Kill all found PIDs
    for (const pid of pidsToKill) {
      try {
        process.kill(pid, 'SIGKILL'); // SIGKILL for immediate termination
      } catch (e) {
        // Process already dead
      }
    }

    simulatorProcess = null;

    // Wait a bit for processes to die
    setTimeout(resolve, 100);
  });
}

const SAMPLE_FILES = [
  { id: 'cheyenne', name: 'Cheyenne', file: '/Users/stephane/Documents/CV_Stephane_Bhiri/KLV_Display/samples/QGISFMV_Samples/MISB/Cheyenne.ts' },
  { id: 'falls', name: 'Falls', file: '/Users/stephane/Documents/CV_Stephane_Bhiri/KLV_Display/samples/QGISFMV_Samples/MISB/falls.ts' },
  { id: 'klv_test', name: 'KLV Test Sync', file: '/Users/stephane/Documents/CV_Stephane_Bhiri/KLV_Display/samples/QGISFMV_Samples/MISB/klv_metadata_test_sync.ts' },
  { id: 'day_flight', name: 'Day Flight', file: '/Users/stephane/Documents/CV_Stephane_Bhiri/KLV_Display/samples/Day_Flight.mpg' },
  { id: 'night_flight', name: 'Night Flight IR', file: '/Users/stephane/Documents/CV_Stephane_Bhiri/KLV_Display/samples/Night_Flight_IR.mpg' },
  { id: 'esri_4k', name: 'Esri 4K MPEG2', file: '/Users/stephane/Documents/CV_Stephane_Bhiri/KLV_Display/samples/QGISFMV_Samples/MISB/Esri_multiplexer_0.mp4' },
  { id: 'misb_4k', name: 'MISB 4K H264', file: '/Users/stephane/Documents/CV_Stephane_Bhiri/KLV_Display/samples/QGISFMV_Samples/multiplexor/MISB.mp4' },
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

  // Kill existing simulator and wait
  await killSimulator();

  // Start new FFmpeg simulator
  simulatorProcess = spawn('ffmpeg', [
    '-fflags', '+genpts+igndts',
    '-err_detect', 'ignore_err',
    '-re',
    '-stream_loop', '-1',
    '-i', file.file,
    '-map', '0:v?',    // video
    '-map', '0:d?',    // data (KLV)
    '-c', 'copy',
    '-f', 'mpegts',
    `udp://127.0.0.1:${port}?pkt_size=1316`
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

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

  // Save PID for orphan recovery
  writeFileSync(SIMULATOR_PID_FILE, String(simulatorProcess.pid));
  console.log(`Simulator started: ${file.name} -> udp://127.0.0.1:${port} (PID: ${simulatorProcess.pid})`);
  res.json({ success: true, file: file.name, port });
});

app.post('/api/simulator/stop', async (req, res) => {
  await killSimulator();
  res.json({ success: true });
});

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

  // Stop accepting new connections
  clearInterval(heartbeatInterval);

  // Close all WebSocket connections
  wss.clients.forEach(ws => {
    ws.close(1001, 'Server shutting down');
  });

  // Stop streams
  try {
    await stopStream();
  } catch (error) {
    console.error('Error stopping streams:', error);
  }

  // Stop simulator
  try {
    await killSimulator();
  } catch (error) {
    console.error('Error killing simulator:', error);
  }

  // Close WebRTC worker
  if (webrtcService?.worker) {
    try {
      webrtcService.worker.close();
    } catch (error) {
      console.error('Error closing WebRTC worker:', error);
    }
  }

  // Close HTTP server
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });

  // Force exit after timeout
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
