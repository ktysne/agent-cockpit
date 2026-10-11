'use strict';

class ProjectionDisplayIndex {
  #records = new Map();
  #keysBySession = new Map();

  constructor(entries = []) {
    for (const [key, record] of entries) this.set(key, record);
  }

  #removeSessionKey(sessionId, key) {
    const keys = this.#keysBySession.get(sessionId);
    if (!keys) return;
    keys.delete(key);
    if (keys.size === 0) this.#keysBySession.delete(sessionId);
  }

  set(key, record) {
    const current = this.#records.get(key);
    if (current && current.session_id !== record.session_id) throw new Error('Projection display key cannot change session');
    this.#records.set(key, { ...record });
    let keys = this.#keysBySession.get(record.session_id);
    if (!keys) {
      keys = new Set();
      this.#keysBySession.set(record.session_id, keys);
    }
    keys.add(key);
  }

  delete(key) {
    const current = this.#records.get(key);
    if (!current) return false;
    this.#records.delete(key);
    this.#removeSessionKey(current.session_id, key);
    return true;
  }

  get(key) {
    const record = this.#records.get(key);
    return record ? { ...record } : undefined;
  }

  *values() {
    for (const record of this.#records.values()) yield { ...record };
  }

  *entries() {
    for (const [key, record] of this.#records.entries()) yield [key, { ...record }];
  }

  recordsForSession(sessionId) {
    const keys = this.#keysBySession.get(sessionId);
    if (!keys) return [];
    const records = [];
    for (const key of keys) {
      const record = this.#records.get(key);
      if (record) records.push({ ...record });
    }
    return records;
  }

  snapshot() {
    return new Map(this.entries());
  }
}

module.exports = ProjectionDisplayIndex;
