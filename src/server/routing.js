const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { AtomicJsonWriter } = require('./json-storage');

const ROUTE_VALUES = new Set(['default', 'codex', 'claude']);
const ROUTE_KEYS = new Set(['agents', 'review']);
const DEFAULT_ROUTING = Object.freeze({ agents: 'default', review: 'default' });

function isValidRouting(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === ROUTE_KEYS.size &&
    [...ROUTE_KEYS].every((key) => ROUTE_VALUES.has(value[key])));
}

function isValidRouteUpdate(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === 'key,value' &&
    ROUTE_KEYS.has(value.key) && ROUTE_VALUES.has(value.value));
}

async function readRouting(homeDir, fileSystem = fs) {
  try {
    const value = JSON.parse(await fileSystem.readFile(path.join(homeDir, 'routing.json'), 'utf8'));
    return normalizeRouting(value);
  } catch {
    return { ...DEFAULT_ROUTING };
  }
}

function readRoutingSync(homeDir, fileSystem = fsSync) {
  try {
    const value = JSON.parse(fileSystem.readFileSync(path.join(homeDir, 'routing.json'), 'utf8'));
    return normalizeRouting(value);
  } catch {
    return { ...DEFAULT_ROUTING };
  }
}

function normalizeRouting(value) {
  return isValidRouting(value) ? { agents: value.agents, review: value.review } : { ...DEFAULT_ROUTING };
}

class RoutingState {
  constructor(homeDir, initial = DEFAULT_ROUTING, options = {}) {
    this.homeDir = homeDir;
    this.value = { agents: initial.agents, review: initial.review };
    this.writer = options.writer || new AtomicJsonWriter(homeDir, { fileSystem: options.fileSystem || fs });
    this.pending = Promise.resolve();
  }

  static async load(homeDir, options = {}) {
    return new RoutingState(homeDir, await readRouting(homeDir, options.fileSystem || fs), options);
  }

  snapshot() {
    return { ...this.value };
  }

  set(key, value) {
    if (!ROUTE_KEYS.has(key) || !ROUTE_VALUES.has(value)) throw new TypeError('Invalid route');
    const run = this.pending.then(async () => {
      const next = { ...this.value, [key]: value };
      await this.writer.write('routing.json', next);
      this.value = next;
      return this.snapshot();
    });
    this.pending = run.catch(() => {});
    return run;
  }

  async flush() {
    await this.pending;
    await this.writer.flush();
  }
}

module.exports = { DEFAULT_ROUTING, ROUTE_KEYS, ROUTE_VALUES, RoutingState, isValidRouting, isValidRouteUpdate, readRouting, readRoutingSync };
