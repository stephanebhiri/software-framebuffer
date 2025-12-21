/**
 * Process Orchestrator
 * Supervises all pipeline processes, prevents orphans, handles cleanup
 */
import { spawn, execSync } from 'child_process';
import { EventEmitter } from 'events';

class ProcessOrchestrator extends EventEmitter {
  constructor() {
    super();
    this.processes = new Map(); // name -> { process, config, restarts }
    this.isShuttingDown = false;
    this.healthCheckInterval = null;

    // Clean orphans on startup
    this.cleanOrphans();

    // Setup signal handlers
    this.setupSignalHandlers();
  }

  /**
   * Clean orphan processes from previous runs
   */
  cleanOrphans() {
    const patterns = [
      'framesync',
      'webrtc_pipeline.py',
      'udp.*splitter'
    ];

    for (const pattern of patterns) {
      try {
        const pids = execSync(`pgrep -f "${pattern}" 2>/dev/null || true`, { encoding: 'utf8' })
          .trim()
          .split('\n')
          .filter(p => p);

        if (pids.length > 0) {
          console.log(`[Orchestrator] Cleaning ${pids.length} orphan ${pattern} process(es)`);
          for (const pid of pids) {
            try {
              process.kill(parseInt(pid), 'SIGKILL');
            } catch (e) {
              // Process already dead
            }
          }
        }
      } catch (e) {
        // pgrep not found or no matches
      }
    }
  }

  /**
   * Register and start a managed process
   */
  register(name, command, args = [], options = {}) {
    if (this.processes.has(name)) {
      console.log(`[Orchestrator] ${name} already registered, stopping first`);
      this.stop(name);
    }

    const config = {
      command,
      args,
      options: {
        autoRestart: false,
        maxRestarts: 3,
        restartDelay: 1000,
        ...options
      }
    };

    const entry = {
      process: null,
      config,
      restarts: 0,
      lastStart: null
    };

    this.processes.set(name, entry);
    return this.start(name);
  }

  /**
   * Start a registered process
   */
  start(name) {
    const entry = this.processes.get(name);
    if (!entry) {
      throw new Error(`Process ${name} not registered`);
    }

    if (entry.process && !entry.process.killed) {
      console.log(`[Orchestrator] ${name} already running (PID ${entry.process.pid})`);
      return entry.process;
    }

    const { command, args, options } = entry.config;

    console.log(`[Orchestrator] Starting ${name}: ${command} ${args.join(' ')}`);

    const proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...options.spawnOptions
    });

    entry.process = proc;
    entry.lastStart = Date.now();

    proc.on('exit', (code, signal) => {
      console.log(`[Orchestrator] ${name} exited (code=${code}, signal=${signal})`);

      if (!this.isShuttingDown && entry.config.options.autoRestart) {
        if (entry.restarts < entry.config.options.maxRestarts) {
          entry.restarts++;
          console.log(`[Orchestrator] Restarting ${name} (attempt ${entry.restarts}/${entry.config.options.maxRestarts})`);
          setTimeout(() => this.start(name), entry.config.options.restartDelay);
        } else {
          console.error(`[Orchestrator] ${name} exceeded max restarts`);
          this.emit('process-failed', name);
        }
      }

      this.emit('process-exit', name, code, signal);
    });

    proc.on('error', (err) => {
      console.error(`[Orchestrator] ${name} error:`, err.message);
      this.emit('process-error', name, err);
    });

    // Reset restart counter after successful run (30 seconds)
    setTimeout(() => {
      if (entry.process && !entry.process.killed) {
        entry.restarts = 0;
      }
    }, 30000);

    this.emit('process-start', name, proc.pid);
    return proc;
  }

  /**
   * Stop a process
   */
  stop(name, signal = 'SIGTERM') {
    const entry = this.processes.get(name);
    if (!entry || !entry.process) {
      return;
    }

    const proc = entry.process;
    if (proc.killed) {
      return;
    }

    console.log(`[Orchestrator] Stopping ${name} (PID ${proc.pid})`);

    proc.kill(signal);

    // Force kill after 2 seconds
    setTimeout(() => {
      if (!proc.killed) {
        console.log(`[Orchestrator] Force killing ${name}`);
        proc.kill('SIGKILL');
      }
    }, 2000);

    entry.process = null;
  }

  /**
   * Stop all processes
   * @param {boolean} permanent - If true, prevents auto-restart (used for shutdown)
   */
  stopAll(permanent = false) {
    console.log('[Orchestrator] Stopping all processes...');
    if (permanent) {
      this.isShuttingDown = true;
    }

    for (const name of this.processes.keys()) {
      this.stop(name);
    }

    // Clear process map if not permanent
    if (!permanent) {
      this.processes.clear();
    }
  }

  /**
   * Get process status
   */
  getStatus(name) {
    const entry = this.processes.get(name);
    if (!entry) {
      return { registered: false };
    }

    return {
      registered: true,
      running: entry.process && !entry.process.killed,
      pid: entry.process?.pid,
      restarts: entry.restarts,
      uptime: entry.lastStart ? Date.now() - entry.lastStart : 0
    };
  }

  /**
   * Get all statuses
   */
  getAllStatus() {
    const status = {};
    for (const name of this.processes.keys()) {
      status[name] = this.getStatus(name);
    }
    return status;
  }

  /**
   * Start health check monitoring
   */
  startHealthCheck(intervalMs = 5000) {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    this.healthCheckInterval = setInterval(() => {
      for (const [name, entry] of this.processes) {
        if (entry.config.options.autoRestart && entry.process?.killed) {
          console.log(`[Orchestrator] Health check: ${name} is dead, restarting`);
          this.start(name);
        }
      }
    }, intervalMs);
  }

  /**
   * Setup signal handlers for graceful shutdown
   */
  setupSignalHandlers() {
    const shutdown = (signal) => {
      console.log(`[Orchestrator] Received ${signal}, shutting down...`);
      this.stopAll(true);  // permanent shutdown

      // Give processes time to exit
      setTimeout(() => {
        process.exit(0);
      }, 3000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    process.on('exit', () => {
      this.stopAll(true);
    });

    process.on('uncaughtException', (err) => {
      console.error('[Orchestrator] Uncaught exception:', err);
      this.stopAll(true);
    });
  }

  /**
   * Unregister a process
   */
  unregister(name) {
    this.stop(name);
    this.processes.delete(name);
  }
}

// Singleton instance
const orchestrator = new ProcessOrchestrator();

export default orchestrator;
export { ProcessOrchestrator };
