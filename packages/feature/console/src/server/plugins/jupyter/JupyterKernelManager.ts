/**
 * Jupyter Kernel Manager
 *
 * Manages kernel lifecycle via a Python bridge script (jupyter_bridge.py).
 * One kernel per notebook bubble. globalThis singleton for cross-module sharing.
 *
 * Pattern: follows LSPServerRegistry.ts (idle timeout, cleanup on exit).
 */

import { spawn, type ChildProcess } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import { createInterface, type Interface } from 'readline';

// ============================================
// Types
// ============================================

export interface KernelOutput {
  msg_id: string;
  msg_type: string;
  content: Record<string, unknown>;
}

interface KernelInstance {
  bubbleId: string;
  cwd: string;
  bridge: ChildProcess;
  readline: Interface;
  ready: boolean;
  readyPromise: Promise<void>;
  lastUsedAt: number;
  outputListeners: Set<(msg: KernelOutput) => void>;
  errorMessage?: string;
}

// ============================================
// Constants
// ============================================

const GLOBAL_KEY = Symbol.for('jupyter_kernel_manager');
const IDLE_TIMEOUT = 10 * 60 * 1000;  // 10 minutes
const IDLE_CHECK_INTERVAL = 60 * 1000;

type GlobalWithKernel = typeof globalThis & {
  [key: symbol]: JupyterKernelManager | undefined;
};

// ============================================
// Manager
// ============================================

class JupyterKernelManager {
  private instances = new Map<string, KernelInstance>();
  private idleTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Clean up all kernels on process exit
    process.on('exit', () => {
      this.shutdownAll();
    });
  }

  /**
   * Find python3 executable
   */
  private findPython(): string {
    // Could add detection logic; for now use 'python3' and fallback to 'python'
    return 'python3';
  }

  /**
   * Resolve jupyter_bridge.py path.
   * Production: ~/.cockpit/kernels/jupyter_bridge.py (copied by postinstall)
   * Dev: COCKPIT_ROOT/kernels/jupyter_bridge.py or legacy src path
   */
  private resolveBridgePath(): string {
    const installedPath = join(homedir(), '.cockpit', 'kernels', 'jupyter_bridge.py');
    if (existsSync(installedPath)) {
      return installedPath;
    }

    const root = process.env.COCKPIT_ROOT;
    if (root) {
      const devPath = join(root, 'kernels', 'jupyter_bridge.py');
      if (existsSync(devPath)) {
        return devPath;
      }
    }

    // Fallback for extreme compatibility
    return join(__dirname, 'jupyter_bridge.py');
  }

  /**
   * Get or create a kernel for a bubble
   */
  async getOrCreate(bubbleId: string, cwd: string): Promise<KernelInstance> {
    const existing = this.instances.get(bubbleId);
    if (existing) {
      existing.lastUsedAt = Date.now();
      await existing.readyPromise;
      return existing;
    }

    const python = this.findPython();
    const bridgePath = this.resolveBridgePath();

    const bridge = spawn(python, ['-u', bridgePath], {
      cwd,
      env: {
        ...process.env,
        JUPYTER_CWD: cwd,
        PYTHONUNBUFFERED: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const readline = createInterface({ input: bridge.stdout! });

    let resolveReady: () => void;
    let rejectReady: (err: Error) => void;
    const readyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const instance: KernelInstance = {
      bubbleId,
      cwd,
      bridge,
      readline,
      ready: false,
      readyPromise,
      lastUsedAt: Date.now(),
      outputListeners: new Set(),
    };

    this.instances.set(bubbleId, instance);

    // Read bridge stdout line by line
    readline.on('line', (line: string) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }

      const type = msg.type as string | undefined;

      if (type === 'ready') {
        instance.ready = true;
        resolveReady!();
      } else if (type === 'error') {
        const errorMsg = msg.message as string;
        instance.errorMessage = errorMsg;
        console.error(`[jupyter-kernel] ${bubbleId}: ${errorMsg}`);
        // If not ready yet, reject the ready promise
        if (!instance.ready) {
          rejectReady!(new Error(errorMsg));
        }
        // Notify listeners about the error
        const output: KernelOutput = {
          msg_id: '',
          msg_type: 'kernel_error',
          content: { message: errorMsg },
        };
        for (const listener of instance.outputListeners) {
          listener(output);
        }
      } else if (msg.msg_id !== undefined) {
        // Kernel output message
        const output: KernelOutput = {
          msg_id: msg.msg_id as string,
          msg_type: msg.msg_type as string,
          content: msg.content as Record<string, unknown>,
        };
        for (const listener of instance.outputListeners) {
          listener(output);
        }
      }
    });

    // Handle bridge stderr (log only)
    bridge.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text) {
        console.error(`[jupyter-kernel] ${bubbleId} stderr: ${text}`);
      }
    });

    // Handle bridge exit
    bridge.on('exit', (code) => {
      console.log(`[jupyter-kernel] ${bubbleId} bridge exited with code ${code}`);
      readline.close();
      this.instances.delete(bubbleId);
      if (!instance.ready) {
        rejectReady!(new Error(`Bridge exited with code ${code}`));
      }
      // Notify listeners
      const output: KernelOutput = {
        msg_id: '',
        msg_type: 'kernel_died',
        content: { exit_code: code },
      };
      for (const listener of instance.outputListeners) {
        listener(output);
      }
    });

    bridge.on('error', (err) => {
      console.error(`[jupyter-kernel] ${bubbleId} spawn error:`, err.message);
      instance.errorMessage = err.message.includes('ENOENT')
        ? 'Python not found. Ensure python3 is installed and in PATH.'
        : err.message;
      if (!instance.ready) {
        rejectReady!(new Error(instance.errorMessage));
      }
    });

    this.startIdleTimer();

    try {
      await readyPromise;
    } catch {
      // Error already stored in instance.errorMessage
    }

    return instance;
  }

  /**
   * Execute code in a kernel
   */
  async execute(bubbleId: string, code: string, msgId: string, cwd?: string): Promise<void> {
    let instance = this.instances.get(bubbleId);
    if (!instance) {
      if (!cwd) throw new Error('Kernel not found and no cwd provided');
      instance = await this.getOrCreate(bubbleId, cwd);
    }

    if (!instance.ready) {
      throw new Error(instance.errorMessage || 'Kernel not ready');
    }

    instance.lastUsedAt = Date.now();
    const cmd = JSON.stringify({ cmd: 'execute', msg_id: msgId, code });
    instance.bridge.stdin!.write(cmd + '\n');
  }

  /**
   * Interrupt the kernel
   */
  async interrupt(bubbleId: string): Promise<void> {
    const instance = this.instances.get(bubbleId);
    if (!instance || !instance.ready) return;

    const cmd = JSON.stringify({ cmd: 'interrupt' });
    instance.bridge.stdin!.write(cmd + '\n');
  }

  /**
   * Shutdown a kernel
   */
  async shutdown(bubbleId: string): Promise<void> {
    const instance = this.instances.get(bubbleId);
    if (!instance) return;

    try {
      if (instance.bridge.stdin?.writable) {
        instance.bridge.stdin.write(JSON.stringify({ cmd: 'shutdown' }) + '\n');
      }
    } catch { /* ignore */ }

    // Force kill after 3 seconds
    setTimeout(() => {
      try {
        instance.bridge.kill('SIGKILL');
      } catch { /* already exited */ }
    }, 3000);

    instance.readline.close();
    this.instances.delete(bubbleId);

    if (this.instances.size === 0) {
      this.stopIdleTimer();
    }
  }

  /**
   * Shutdown all kernels
   */
  shutdownAll(): void {
    for (const [id] of this.instances) {
      this.shutdown(id);
    }
    this.stopIdleTimer();
  }

  /**
   * Subscribe to kernel output messages
   */
  addOutputListener(bubbleId: string, listener: (msg: KernelOutput) => void): () => void {
    const instance = this.instances.get(bubbleId);
    if (!instance) return () => {};

    instance.outputListeners.add(listener);
    return () => {
      instance.outputListeners.delete(listener);
    };
  }

  /**
   * Check if a kernel exists for a bubble
   */
  has(bubbleId: string): boolean {
    return this.instances.has(bubbleId);
  }

  /**
   * Get kernel error message if any
   */
  getError(bubbleId: string): string | undefined {
    return this.instances.get(bubbleId)?.errorMessage;
  }

  // ============================================
  // Idle timeout
  // ============================================

  private startIdleTimer(): void {
    if (this.idleTimer) return;

    this.idleTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, instance] of this.instances) {
        if (now - instance.lastUsedAt > IDLE_TIMEOUT) {
          console.log(`[jupyter-kernel] idle timeout: ${id}`);
          this.shutdown(id);
        }
      }
      if (this.instances.size === 0) {
        this.stopIdleTimer();
      }
    }, IDLE_CHECK_INTERVAL);

    if (typeof this.idleTimer.unref === 'function') {
      this.idleTimer.unref();
    }
  }

  private stopIdleTimer(): void {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
  }
}

// ============================================
// globalThis singleton
// ============================================

const g = globalThis as GlobalWithKernel;
export const kernelManager: JupyterKernelManager = g[GLOBAL_KEY] ?? (g[GLOBAL_KEY] = new JupyterKernelManager());
