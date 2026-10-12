import { spawn as nodeSpawn } from 'node:child_process';

/**
 * Own one long-lived bridge adapter process at a time. Each child is a
 * generation: callbacks from an old child cannot clear or impersonate a newer
 * one, and stop() only signals the exact child currently owned.
 */
export class BridgeProcessOwner {
  #spawn;
  #generation = 0;
  #active = null;

  constructor({ spawnImpl = nodeSpawn } = {}) {
    if (typeof spawnImpl !== 'function') throw new TypeError('spawnImpl must be a function');
    this.#spawn = spawnImpl;
  }

  get current() {
    return this.#active?.child ?? null;
  }

  start(argv, options = {}, handlers = {}) {
    if (this.#active) throw new Error('bridge process is already running');
    if (!Array.isArray(argv) || argv.length === 0 || argv.some((part) => typeof part !== 'string')) {
      throw new TypeError('argv must be a non-empty array of strings');
    }

    const child = this.#spawn(argv[0], argv.slice(1), options);
    const generation = ++this.#generation;
    const record = { child, generation };
    this.#active = record;
    const isCurrent = () => this.#active === record;

    child.once('error', (error) => {
      const current = isCurrent();
      if (current) this.#active = null;
      handlers.onError?.(error, { child, generation, current });
    });
    child.once('exit', (code, signal) => {
      const current = isCurrent();
      if (current) this.#active = null;
      handlers.onExit?.(code, signal, { child, generation, current });
    });
    return child;
  }

  stop(child = this.current, signal = 'SIGTERM') {
    if (!child || this.#active?.child !== child) return false;
    try {
      if (!child.kill(signal)) return false;
      this.#active = null;
      return true;
    } catch {
      return false;
    }
  }
}
