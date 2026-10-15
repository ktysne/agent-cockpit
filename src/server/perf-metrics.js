'use strict';

const { monitorEventLoopDelay, performance } = require('node:perf_hooks');

const LOOP_RESOLUTION_MS = 10;
const NANOSECONDS_PER_MILLISECOND = 1e6;

function roundMilliseconds(value) {
  return Math.round(value * 10) / 10;
}

// 計測は対象の戻り値と例外をそのまま通す。計測のために呼び出し側の挙動を変えないためである。
class PerfMetrics {
  constructor() {
    this.timings = new Map();
    this.counts = new Map();
    this.loop = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
    this.loop.enable();
  }

  measure(name, fn) {
    const start = performance.now();
    try {
      return fn();
    } finally {
      this.record(name, performance.now() - start);
    }
  }

  async measureAsync(name, fn) {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      this.record(name, performance.now() - start);
    }
  }

  record(name, elapsedMs) {
    const timing = this.timings.get(name) || { count: 0, totalMs: 0, maxMs: 0 };
    timing.count += 1;
    timing.totalMs += elapsedMs;
    timing.maxMs = Math.max(timing.maxMs, elapsedMs);
    this.timings.set(name, timing);
  }

  count(name) {
    this.counts.set(name, (this.counts.get(name) || 0) + 1);
  }

  // 1 回も呼ばれなかった処理は項目を出さない。取り出した後は集計をリセットする。
  // イベントループの値は、サンプルが無いと histogram の既定値が出るため 0 にする。
  summary() {
    const data = {};
    for (const [name, count] of this.counts) data[`${name}Count`] = count;
    for (const [name, timing] of this.timings) {
      data[`${name}Count`] = timing.count;
      data[`${name}TotalMs`] = roundMilliseconds(timing.totalMs);
      data[`${name}MaxMs`] = roundMilliseconds(timing.maxMs);
    }
    const sampled = this.loop.count > 0;
    data.loopP99Ms = sampled ? roundMilliseconds(this.loop.percentile(99) / NANOSECONDS_PER_MILLISECOND) : 0;
    data.loopMaxMs = sampled ? roundMilliseconds(this.loop.max / NANOSECONDS_PER_MILLISECOND) : 0;
    this.timings.clear();
    this.counts.clear();
    this.loop.reset();
    return data;
  }

  close() {
    this.loop.disable();
  }
}

module.exports = { PerfMetrics };
