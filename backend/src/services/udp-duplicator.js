/**
 * UDP Duplicator
 * Receives UDP packets on one port and forwards to multiple destinations
 * Used to split FrameBuffer output for both WebRTC gateway and ffplay monitoring
 */
import dgram from 'dgram';
import { EventEmitter } from 'events';

class UDPDuplicator extends EventEmitter {
  constructor() {
    super();
    this.socket = null;
    this.destinations = [];
    this.isRunning = false;
    this.packetCount = 0;
  }

  /**
   * Start the duplicator
   * @param {number} listenPort - Port to listen on
   * @param {Array<{host: string, port: number}>} destinations - Where to forward packets
   */
  start(listenPort, destinations) {
    if (this.isRunning) {
      this.stop();
    }

    this.destinations = destinations;
    this.socket = dgram.createSocket('udp4');

    this.socket.on('message', (msg, rinfo) => {
      this.packetCount++;

      // Forward to all destinations
      for (const dest of this.destinations) {
        this.socket.send(msg, dest.port, dest.host, (err) => {
          if (err && this.packetCount < 10) {
            console.error(`UDP Duplicator: Failed to send to ${dest.host}:${dest.port}`, err.message);
          }
        });
      }

      // Log occasionally
      if (this.packetCount % 5000 === 0) {
        console.log(`UDP Duplicator: ${this.packetCount} packets forwarded to ${this.destinations.length} destinations`);
      }
    });

    this.socket.on('error', (err) => {
      console.error('UDP Duplicator error:', err.message);
      this.emit('error', err);
    });

    this.socket.bind(listenPort, () => {
      console.log(`UDP Duplicator: Listening on port ${listenPort}, forwarding to:`);
      for (const dest of this.destinations) {
        console.log(`  - ${dest.host}:${dest.port}`);
      }
      this.isRunning = true;
      this.emit('ready');
    });
  }

  stop() {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.isRunning = false;
    this.packetCount = 0;
    console.log('UDP Duplicator: Stopped');
  }

  getStatus() {
    return {
      running: this.isRunning,
      packetCount: this.packetCount,
      destinations: this.destinations.length
    };
  }
}

export default UDPDuplicator;
