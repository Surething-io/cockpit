import { spawn, type ChildProcess } from 'child_process';
import { createHash } from 'crypto';
import { createWriteStream, type WriteStream } from 'fs';
import { getServiceLogPath, ensureDir, getLogsDir } from './paths';

// ============================================
// Types
// ============================================

export interface RunningService {
  id: string;
  cwd: string;
  command: string;
  pid: number;
  startedAt: number;
  url?: string;
  logFile: string;
}

// ============================================
// Service Manager (Singleton)
// ============================================

class ServiceManager {
  private services = new Map<string, RunningService>();
  private processes = new Map<string, ChildProcess>();
  private logStreams = new Map<string, WriteStream>();
  private lastAccessTime = new Map<string, number>(); // cwd -> last access timestamp
  private cleanupTimer: NodeJS.Timeout | null = null;

  /**
   * Generate a unique ID for a service
   */
  private generateId(cwd: string, command: string): string {
    const hash = createHash('md5').update(`${cwd}:${command}`).digest('hex').slice(0, 8);
    return `${hash}-${Date.now()}`;
  }

  /**
   * Generate a hash for command (for log file naming)
   */
  private getCommandHash(command: string): string {
    return createHash('md5').update(command).digest('hex').slice(0, 8);
  }

  /**
   * Parse URL from log output
   */
  private parseUrl(text: string): string | undefined {
    // Match patterns like: http://localhost:3000, https://0.0.0.0:8080, etc.
    const urlPattern = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|[\w.-]+):\d+/g;
    const matches = text.match(urlPattern);
    return matches?.[0];
  }

  /**
   * Start a new service
   */
  async start(cwd: string, command: string): Promise<RunningService> {
    const id = this.generateId(cwd, command);
    const commandHash = this.getCommandHash(command);
    const logFile = getServiceLogPath(cwd, commandHash);

    // Ensure logs directory exists
    await ensureDir(getLogsDir(cwd));

    // Create log write stream (overwrite mode)
    const logStream = createWriteStream(logFile, { flags: 'w' });
    this.logStreams.set(id, logStream);

    // Parse command (simple split by space, could be improved)
    const [cmd, ...args] = command.split(' ');

    // Spawn process
    const proc = spawn(cmd, args, {
      cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const service: RunningService = {
      id,
      cwd,
      command,
      pid: proc.pid!,
      startedAt: Date.now(),
      logFile,
    };

    this.services.set(id, service);
    this.processes.set(id, proc);

    // Handle stdout
    proc.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      logStream.write(text);

      // Try to parse URL from output
      if (!service.url) {
        const url = this.parseUrl(text);
        if (url) {
          service.url = url;
          this.services.set(id, service);
        }
      }
    });

    // Handle stderr
    proc.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      logStream.write(text);

      // Try to parse URL from stderr too
      if (!service.url) {
        const url = this.parseUrl(text);
        if (url) {
          service.url = url;
          this.services.set(id, service);
        }
      }
    });

    // Handle process exit
    proc.on('exit', (code, signal) => {
      logStream.write(`\n[Process exited with code ${code}, signal ${signal}]\n`);
      logStream.end();
      this.services.delete(id);
      this.processes.delete(id);
      this.logStreams.delete(id);
    });

    return service;
  }

  /**
   * Stop a service
   */
  stop(id: string): boolean {
    const proc = this.processes.get(id);
    if (!proc) return false;

    proc.kill('SIGTERM');

    // Force kill after 5 seconds if not exited
    setTimeout(() => {
      if (this.processes.has(id)) {
        proc.kill('SIGKILL');
      }
    }, 5000);

    return true;
  }

  /**
   * Get all running services
   */
  getAll(): RunningService[] {
    // Update access time for all projects
    const projects = new Set(Array.from(this.services.values()).map(s => s.cwd));
    const now = Date.now();
    projects.forEach(cwd => this.lastAccessTime.set(cwd, now));

    return Array.from(this.services.values());
  }

  /**
   * Get services for a specific project
   */
  getByProject(cwd: string): RunningService[] {
    // Update access time for this project
    this.lastAccessTime.set(cwd, Date.now());
    return Array.from(this.services.values()).filter(s => s.cwd === cwd);
  }

  /**
   * Get a single service by ID
   */
  get(id: string): RunningService | undefined {
    return this.services.get(id);
  }

  /**
   * Check if a service is running
   */
  isRunning(id: string): boolean {
    return this.services.has(id);
  }

  /**
   * Stop all services for a specific project
   */
  stopAllByProject(cwd: string): void {
    const servicesToStop = this.getByProject(cwd);
    for (const service of servicesToStop) {
      this.stop(service.id);
    }
    this.lastAccessTime.delete(cwd);
  }

  /**
   * Cleanup inactive projects (no access in 1 minute)
   */
  private cleanupInactiveProjects(): void {
    const now = Date.now();
    const INACTIVE_TIMEOUT = 60 * 1000; // 1 minute

    // Get all projects with running services
    const projectsWithServices = new Set(Array.from(this.services.values()).map(s => s.cwd));

    // Check each project's last access time
    for (const cwd of projectsWithServices) {
      const lastAccess = this.lastAccessTime.get(cwd) || 0;
      if (now - lastAccess > INACTIVE_TIMEOUT) {
        console.log(`[ServiceManager] Auto-stopping services for inactive project: ${cwd}`);
        this.stopAllByProject(cwd);
      }
    }
  }

  /**
   * Start cleanup timer
   */
  startCleanupTimer(): void {
    if (this.cleanupTimer) return;

    // Check every 3 seconds for inactive projects
    this.cleanupTimer = setInterval(() => {
      this.cleanupInactiveProjects();
    }, 3000);
  }

  /**
   * Stop cleanup timer
   */
  stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Stop all services (cleanup)
   */
  stopAll(): void {
    for (const id of this.services.keys()) {
      this.stop(id);
    }
    this.lastAccessTime.clear();
  }
}

// Export singleton instance
export const serviceManager = new ServiceManager();

// Start cleanup timer
serviceManager.startCleanupTimer();

// Cleanup on process exit
process.on('exit', () => {
  serviceManager.stopCleanupTimer();
  serviceManager.stopAll();
});

process.on('SIGINT', () => {
  serviceManager.stopCleanupTimer();
  serviceManager.stopAll();
  process.exit(0);
});

process.on('SIGTERM', () => {
  serviceManager.stopCleanupTimer();
  serviceManager.stopAll();
  process.exit(0);
});
