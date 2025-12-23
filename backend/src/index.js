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
import WebRTCGatewayC from './services/webrtc-gateway-c.js';
import FrameBufferService from './services/framebuffer.js';
import UDPKLVSplitter from './services/udp-klv-splitter.js';
import orchestrator from './services/orchestrator.js';

// Shared memory path for FrameBuffer <-> WebRTC Gateway communication
const SHM_PATH = '/tmp/framebuffer.sock';

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
let framebufferService = null;  // FrameBuffer for seamless source switching
let currentSource = null;
let streamMode = null; // 'file' or 'udp'

// ===== WebRTC Service Setup (C Gateway - Zero UDP forwarding) =====
function setupWebRTCService() {
  webrtcService = new WebRTCGatewayC();

  // Handle SDP offer from C gateway
  webrtcService.on('offer', (clientId, sdp) => {
    console.log(`WebRTC C: Sending offer to ${clientId}`);
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

  // Handle ICE candidate from C gateway
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

  // Handle client connection state
  webrtcService.on('client-connected', (clientId) => {
    console.log(`WebRTC C: Client ${clientId} connected`);
    for (const [ws, client] of clients) {
      if (client.id === clientId && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'webrtc-connected' }));
        break;
      }
    }
  });

  // Handle pipeline errors
  webrtcService.on('error', (err) => {
    console.error('WebRTC C: Error:', err.message);
    broadcast({ type: 'stream-error', message: err.message });
  });

  webrtcService.on('closed', (code) => {
    console.log('WebRTC C: Closed with code:', code);
    if (streamMode === 'udp') {
      broadcast({ type: 'stream-ended' });
    }
  });

  return webrtcService;
}

// Initialize service
webrtcService = setupWebRTCService();

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
  ws.send(JSON.stringify({
    type: 'status',
    clientId,
    streaming: !!(ffmpegService || webrtcService?.isReady),
    source: currentSource,
    mode: streamMode,
    hlsUrl: (streamMode === 'file' && ffmpegService) ? '/hls/playlist.m3u8' : null,
    webrtc: streamMode === 'udp' && webrtcService?.isReady
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

    // WebRTC signaling (new webrtcbin-based)
    case 'webrtc-init':
      // Client wants to join WebRTC
      if (webrtcService?.isReady) {
        webrtcService.addClient(client.id);
      } else {
        ws.send(JSON.stringify({
          type: 'error',
          message: 'WebRTC not ready. Start a UDP stream first.'
        }));
      }
      break;

    case 'webrtc-answer':
      // Browser sends SDP answer
      if (webrtcService?.isReady) {
        webrtcService.setAnswer(client.id, data.sdp);
      }
      break;

    case 'webrtc-ice-candidate':
      // Browser sends ICE candidate
      if (webrtcService?.isReady && data.candidate) {
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

// ===== UDP STREAM MODE with WebRTC (KLVSplitter + FrameBuffer + WebRTC Gateway) =====
// Architecture: Source -> UDP:5000 -> KLVSplitter -> UDP:5001 -> FrameBuffer -> SharedMem -> WebRTC Gateway -> Chrome
//                                         ↓
//                                    Parse KLV -> WebSocket -> Frontend
let klvSplitter = null;

async function startUDPStream(port = 5000) {
  console.log('Starting UDP stream on port:', port);

  // Stop everything and start fresh
  await stopStream();

  currentSource = `udp://0.0.0.0:${port}`;
  streamMode = 'udp';

  // Reinitialize WebRTC service if needed
  if (!webrtcService) {
    webrtcService = setupWebRTCService();
  }

  const forwardPort = port + 1;  // KLVSplitter forwards to port+1

  try {
    // 1. Start KLV Splitter: UDP input → extract KLV + forward to FrameBuffer
    if (!klvSplitter) {
      klvSplitter = new UDPKLVSplitter();
      klvSplitter.on('klv', ({ data: klvData, pid }) => {
        try {
          const { packets } = parseKLV(klvData);
          for (const pkt of packets) {
            const formatted = formatKLVForDisplay(pkt);
            // Use PID as primary sensor identifier (reliable for multi-PID streams)
            // Fall back to imageSourceSensor name for display
            const sensorName = pkt.imageSourceSensor || pkt.sensorName || `PID-${pid.toString(16)}`;
            const sensorId = `pid-${pid.toString(16)}`;
            // Debug: log unique sensors
            if (!klvSplitter._seenSensors) klvSplitter._seenSensors = new Set();
            if (!klvSplitter._seenSensors.has(sensorId)) {
              klvSplitter._seenSensors.add(sensorId);
              console.log(`[KLV] New sensor detected: PID 0x${pid.toString(16)} "${sensorName}"`);
            }
            broadcast({ type: 'klv', sensorId, sensorName, data: formatted });
          }
        } catch (err) {
          // Ignore parse errors
        }
      });
    }
    await klvSplitter.start({
      inputPort: port,
      outputPort: forwardPort,
      outputHost: '127.0.0.1'
    });
    console.log(`KLV Splitter started: UDP:${port} → UDP:${forwardPort} + KLV extraction`);

    // 2. Start FrameBuffer: UDP input (forwarded) → decode → SharedMem output
    if (!framebufferService) {
      framebufferService = new FrameBufferService();
    }
    await framebufferService.start({
      inputPort: forwardPort,  // Listen on forwarded port
      width: 640,
      height: 480,
      fps: 30,
      jitterBuffer: 500,   // 0.5 seconds jitter buffer
      codec: 'raw',        // Raw frames for SharedMem
      container: 'shm',    // Shared memory output
      shmPath: SHM_PATH
    });
    console.log(`FrameBuffer started: UDP:${forwardPort} → SharedMem:${SHM_PATH}`);

    // 2. Start WebRTC Gateway: SharedMem input → VP8 encode → WebRTC
    await webrtcService.start('shm', {
      shmPath: SHM_PATH,
      width: 640,
      height: 480,
      fps: 30,
      bitrate: 2000
    });
    console.log(`WebRTC Gateway started: SharedMem:${SHM_PATH} → WebRTC`);
  } catch (error) {
    console.error('Failed to start UDP stream:', error);
    broadcast({ type: 'error', message: error.message });
    return;
  }

  broadcast({
    type: 'stream-started',
    mode: 'udp',
    source: currentSource,
    webrtc: true
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

  // Stop KLV Splitter
  if (klvSplitter?.isRunning) {
    await klvSplitter.stop();
  }

  // Stop FrameBuffer
  if (framebufferService?.isRunning) {
    await framebufferService.stop();
  }

  // Stop WebRTC Gateway
  if (webrtcService?.isReady) {
    await webrtcService.stop();
    // Reinitialize for next use
    webrtcService = setupWebRTCService();
  }

  currentSource = null;
  streamMode = null;
  broadcast({ type: 'stream-stopped' });
}

// ===== REST API =====
app.get('/api/status', (req, res) => {
  res.json({
    streaming: !!(ffmpegService || webrtcService?.isReady),
    source: currentSource,
    mode: streamMode,
    clients: clients.size,
    webrtcReady: webrtcService?.isReady || false,
    framebufferRunning: framebufferService?.isRunning || false,
    framebufferStats: framebufferService?.stats || null,
    simulator: simulatorProcess ? { running: true, codec: simulatorCodec } : { running: false },
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
let simulatorFileId = null;
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
  { id: 'truck', name: 'Truck', file: '/Users/stephane/Documents/CV_Stephane_Bhiri/KLV_Display/samples/FMV tutorial data/Truck.ts', codec: 'h264' },
  { id: 'klv_test', name: 'KLV Test Sync', file: '/Users/stephane/Documents/CV_Stephane_Bhiri/KLV_Display/samples/QGISFMV_Samples/MISB/klv_metadata_test_sync.ts', codec: 'h264' },
  { id: 'day_flight', name: 'Day Flight', file: '/Users/stephane/Documents/CV_Stephane_Bhiri/KLV_Display/samples/Day_Flight.mpg', codec: 'h264' },
  { id: 'night_flight', name: 'Night Flight IR', file: '/Users/stephane/Documents/CV_Stephane_Bhiri/KLV_Display/samples/Night_Flight_IR.mpg', codec: 'h264' },
  { id: 'esri_4k', name: 'Esri 4K MPEG2', file: '/Users/stephane/Documents/CV_Stephane_Bhiri/KLV_Display/samples/QGISFMV_Samples/MISB/Esri_multiplexer_0.mp4', codec: 'mpeg2' },
  { id: 'misb_4k', name: 'MISB 4K H264', file: '/Users/stephane/Documents/CV_Stephane_Bhiri/KLV_Display/samples/QGISFMV_Samples/multiplexor/MISB.mp4', codec: 'h264' },
];

app.get('/api/simulator/files', (req, res) => {
  res.json({ files: SAMPLE_FILES });
});

app.get('/api/simulator/status', (req, res) => {
  res.json({
    running: !!simulatorProcess,
    fileId: simulatorFileId,
    codec: simulatorCodec
  });
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
    simulatorFileId = null;
    if (existsSync(SIMULATOR_PID_FILE)) unlinkSync(SIMULATOR_PID_FILE);
  });

  writeFileSync(SIMULATOR_PID_FILE, String(simulatorProcess.pid));
  simulatorCodec = file.codec || 'h264';
  simulatorFileId = fileId;
  console.log(`Simulator started: ${file.name} -> udp://127.0.0.1:${port} (PID: ${simulatorProcess.pid}, codec: ${simulatorCodec})`);

  // FrameBuffer is DECOUPLED from simulator - it handles codec changes internally
  // No restart needed here - FrameBuffer auto-recovers on input errors
  if (streamMode === 'udp') {
    console.log(`Source switch to ${file.name} - FrameBuffer handles codec changes internally`);
    broadcast({ type: 'source-switching', file: file.name });

    // Notify frontend after source settles
    setTimeout(() => {
      broadcast({ type: 'source-switched', file: file.name, codec: file.codec });
    }, 2000);
  }

  res.json({ success: true, file: file.name, port, codec: simulatorCodec });
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

  // Stop framebuffer if running
  try {
    if (framebufferService?.isRunning) {
      await framebufferService.stop();
    }
  } catch (error) {
    console.error('Error stopping framebuffer:', error);
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
