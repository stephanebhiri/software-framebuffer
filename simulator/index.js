#!/usr/bin/env node
/**
 * STANAG 4609 Simulator
 * Generates a real-time MPEG-TS stream with video and KLV metadata
 *
 * Usage: node simulator/index.js [--udp host:port] [--tcp port]
 */

import dgram from 'dgram';
import net from 'net';
import { spawn } from 'child_process';
import { encodeKLVPacket } from './klv-encoder.js';
import { createPAT, createPMT, createKLVPackets, createNullPacket, PID_KLV } from './ts-muxer.js';
import { FlightSimulator } from './flight-simulator.js';

const UDP_HOST = process.env.UDP_HOST || '127.0.0.1';
const UDP_PORT = parseInt(process.env.UDP_PORT || '5000');
const KLV_RATE = 10; // KLV updates per second

class StanagSimulator {
  constructor() {
    this.flight = new FlightSimulator();
    this.udpSocket = null;
    this.running = false;
    this.frameCount = 0;
  }

  /**
   * Start UDP streaming
   */
  async startUDP(host = UDP_HOST, port = UDP_PORT) {
    this.udpSocket = dgram.createSocket('udp4');
    this.running = true;

    console.log(`STANAG 4609 Simulator`);
    console.log(`Streaming to UDP ${host}:${port}`);
    console.log(`KLV on PID 0x1f1 (497)`);
    console.log(`Press Ctrl+C to stop\n`);

    // Send PAT/PMT periodically
    this.sendPSI(host, port);
    setInterval(() => this.sendPSI(host, port), 500);

    // Generate and send KLV at specified rate
    setInterval(() => {
      if (!this.running) return;
      this.sendKLV(host, port);
    }, 1000 / KLV_RATE);

    // Log status
    setInterval(() => {
      const meta = this.flight.update();
      console.log(`[${new Date().toISOString().slice(11,23)}] ` +
        `Lat: ${meta.sensorLatitude.toFixed(5)}° ` +
        `Lon: ${meta.sensorLongitude.toFixed(5)}° ` +
        `Alt: ${meta.sensorAltitude.toFixed(0)}m ` +
        `Hdg: ${meta.platformHeading.toFixed(0)}°`);
    }, 1000);
  }

  /**
   * Send PSI tables (PAT + PMT)
   */
  sendPSI(host, port) {
    const pat = createPAT();
    const pmt = createPMT();
    this.udpSocket.send(pat, port, host);
    this.udpSocket.send(pmt, port, host);
  }

  /**
   * Generate and send KLV packet
   */
  sendKLV(host, port) {
    // Get current flight state
    const metadata = this.flight.update();

    // Encode to KLV
    const klvPacket = encodeKLVPacket(metadata);

    // Wrap in TS packets
    const tsPackets = createKLVPackets(klvPacket);

    // Send each TS packet
    for (const packet of tsPackets) {
      this.udpSocket.send(packet, port, host);
    }
  }

  /**
   * Stop streaming
   */
  stop() {
    this.running = false;
    if (this.udpSocket) {
      this.udpSocket.close();
    }
  }
}

/**
 * Start simulator with video using FFmpeg
 * FFmpeg generates test video and we inject KLV
 */
async function startWithVideo(host, port) {
  const simulator = new StanagSimulator();
  const udpSocket = dgram.createSocket('udp4');

  console.log(`STANAG 4609 Simulator with Video`);
  console.log(`Streaming to UDP ${host}:${port}`);
  console.log(`Video: PID 0x1e1 (481) - Test pattern`);
  console.log(`KLV:   PID 0x1f1 (497) - Flight telemetry`);
  console.log(`Press Ctrl+C to stop\n`);

  // Start FFmpeg to generate video TS stream
  const ffmpeg = spawn('ffmpeg', [
    '-re', // Real-time
    '-f', 'lavfi',
    '-i', 'testsrc=size=640x480:rate=25', // Test pattern
    '-f', 'lavfi',
    '-i', 'sine=frequency=1000:sample_rate=48000', // Audio tone
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-b:v', '1M',
    '-c:a', 'aac',
    '-b:a', '64k',
    '-f', 'mpegts',
    '-muxrate', '2M',
    `udp://${host}:${port}?pkt_size=188`
  ], {
    stdio: ['ignore', 'ignore', 'pipe']
  });

  ffmpeg.stderr.on('data', (data) => {
    const msg = data.toString();
    if (msg.includes('Error')) {
      console.error('FFmpeg:', msg);
    }
  });

  // Inject KLV packets
  setInterval(() => {
    const metadata = simulator.flight.update();
    const klvPacket = encodeKLVPacket(metadata);
    const tsPackets = createKLVPackets(klvPacket);

    for (const packet of tsPackets) {
      udpSocket.send(packet, port, host);
    }
  }, 1000 / KLV_RATE);

  // Log status
  setInterval(() => {
    const meta = simulator.flight.update();
    console.log(`[${new Date().toISOString().slice(11,23)}] ` +
      `Lat: ${meta.sensorLatitude.toFixed(5)}° ` +
      `Lon: ${meta.sensorLongitude.toFixed(5)}° ` +
      `Alt: ${meta.sensorAltitude.toFixed(0)}m ` +
      `Hdg: ${meta.platformHeading.toFixed(0)}°`);
  }, 1000);

  process.on('SIGINT', () => {
    console.log('\nStopping...');
    ffmpeg.kill();
    udpSocket.close();
    process.exit(0);
  });
}

/**
 * KLV-only mode (no video)
 */
async function startKLVOnly(host, port) {
  const simulator = new StanagSimulator();
  await simulator.startUDP(host, port);

  process.on('SIGINT', () => {
    console.log('\nStopping...');
    simulator.stop();
    process.exit(0);
  });
}

// Main
const args = process.argv.slice(2);
const host = args[0] || UDP_HOST;
const port = parseInt(args[1] || UDP_PORT);
const withVideo = args.includes('--video');

if (withVideo) {
  startWithVideo(host, port);
} else {
  startKLVOnly(host, port);
}
