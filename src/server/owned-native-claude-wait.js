'use strict';

const { types } = require('node:util');
const { getOwnedSource } = require('./owned-native-source');
const { TOOL_NAME } = require('./owned-native-mcp-wait');

const WAIT_SOURCES = new WeakMap();
const MAX_CALLS = 128;
function identifier(value) { return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u0020]/.test(value); }
function exact(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(descriptors).length === fields.length && fields.every(field => descriptors[field]?.enumerable && Object.hasOwn(descriptors[field], 'value'));
}
function input(value) { return exact(value, ['nonce']) && typeof value.nonce === 'string' && /^[0-9a-f]{48}$/.test(value.nonce); }
function pureTrue(callback, value) { try { return callback(value) === true; } catch { return false; } }

function createOwnedNativeClaudeWait(sourceCapability, options) {
  if (getOwnedSource(sourceCapability)?.provider !== 'claude' || WAIT_SOURCES.has(sourceCapability) ||
      !options || !options.mcp || !['scope', 'checkScope', 'current', 'advance', 'onContinuation', 'onUnknown'].every(key => typeof options[key] === 'function')) {
    throw new TypeError('owned Claude wait configuration invalid');
  }
  const permits = new WeakMap();
  const seenContexts = new Set();
  const seenTools = new Map();
  const seenNonces = new Set();
  let consumingPermit = null;
  let invalidated = false, transitioning = false, streamMessageId = null, partial = null, active = null, resultMatched = false;
  function unknown() {
    if (invalidated) return false;
    options.mcp.controller.clearPartial();
    invalidated = true; resultMatched = false; partial = null;
    options.mcp.controller.invalidate();
    try { options.onUnknown(); } catch {}
    return false;
  }
  options.mcp.facade.subscribe((handle, native) => {
    if (invalidated || active || !seenTools.has(native.nativeToolUseId)) { unknown(); return; }
    const scope = options.scope();
    if (!scope || !pureTrue(options.checkScope, scope)) { unknown(); return; }
    active = { handle, native, scope, resultMatched: false };
  });
  function continuationCurrent(record) {
    return Boolean(record && !record.used && !invalidated && active === record.active && resultMatched &&
      pureTrue(options.checkScope, record.active.scope) && options.mcp.controller.inspectSent(record.active.handle));
  }
  const facade = Object.freeze({
    inspectContinuation(permit) {
      const record = permits.get(permit);
      if (!continuationCurrent(record)) return null;
      return Object.freeze({ fromContextId: record.from, toContextId: record.to,
        nativeToolUseId: record.active.native.nativeToolUseId, inputEpoch: record.active.native.inputEpoch,
        waitHandle: record.active.handle });
    },
    isTransitioning(permit) { return transitioning && consumingPermit === permit && permits.get(permit)?.used === true; },
    checkContinuation(permit) { return continuationCurrent(permits.get(permit)); },
    consumeContinuation(permit) {
      const record = permits.get(permit);
      if (!continuationCurrent(record) || transitioning) return false;
      record.used = true; transitioning = true; consumingPermit = permit;
      if (!options.mcp.controller.consumeSent(record.active.handle)) { transitioning = false; unknown(); return false; }
      active = null; resultMatched = false;
      try {
        if (options.advance(record.from, record.to, record.active.scope) !== true) { unknown(); return false; }
        seenContexts.add(record.from); return !invalidated;
      } catch { unknown(); return false; }
      finally { transitioning = false; consumingPermit = null; }
    },
  });
  WAIT_SOURCES.set(sourceCapability, facade);
  function scoped(message) {
    const current = options.current();
    return current && message.session_id === current.sessionId && message.parent_tool_use_id === null ? current : null;
  }
  function observeResult(message) {
    const current = scoped(message);
    if (!current || !active || !Array.isArray(message.message?.content) || message.message.role !== 'user') return unknown();
    const blocks = message.message.content;
    if (blocks.length !== 1) return unknown();
    const item = blocks[0];
    const fields = Object.hasOwn(item || {}, 'is_error') ? ['type', 'tool_use_id', 'content', 'is_error'] : ['type', 'tool_use_id', 'content'];
    const sent = options.mcp.controller.inspectSent(active.handle);
    if (!exact(item, fields) || item.type !== 'tool_result' || !sent || resultMatched ||
        item.tool_use_id !== active.native.nativeToolUseId || current.nativeContextId !== active.native.nativeContextId ||
        current.inputEpoch !== active.native.inputEpoch || !pureTrue(options.checkScope, active.scope) ||
        !Array.isArray(item.content) || item.content.length !== 1 || !exact(item.content[0], ['type', 'text']) ||
        item.content[0].type !== 'text' || item.content[0].text !== sent.status ||
        (item.is_error === undefined ? sent.status !== 'released' : item.is_error !== (sent.status !== 'released'))) return unknown();
    resultMatched = true; return true;
  }
  function observeFull(message) {
    const current = scoped(message);
    const native = message.message;
    if (!current || native?.role !== 'assistant' || !identifier(native.id) || !Array.isArray(native.content)) return unknown();
    if (native.id !== current.nativeContextId) return unknown();
    let tool = null;
    for (const item of native.content) {
      if (item?.type !== 'tool_use') continue;
      if (tool || !exact(item, ['type', 'id', 'name', 'input']) || item.name !== TOOL_NAME || !identifier(item.id) || !input(item.input)) return unknown();
      tool = item;
    }
    if (!tool) return true;
    if ([...seenTools.values()].some(record => record.messageId === native.id) || seenTools.has(tool.id) || seenNonces.has(tool.input.nonce) || seenTools.size >= MAX_CALLS) return unknown();
    if (partial && partial.messageId === native.id && (partial.id !== tool.id || partial.stopped && partial.input?.nonce !== tool.input.nonce)) return unknown();
    seenTools.set(tool.id, Object.freeze({ messageId: native.id, nonce: tool.input.nonce })); seenNonces.add(tool.input.nonce);
    return options.mcp.controller.observeNative(Object.freeze({ sessionId: current.sessionId, nativeContextId: native.id,
      nativeToolUseId: tool.id, inputEpoch: current.inputEpoch, input: Object.freeze({ nonce: tool.input.nonce }) }));
  }
  function observeStream(message) {
    const current = scoped(message), event = message.event;
    if (!current || !event || typeof event.type !== 'string') return unknown();
    if (event.type === 'message_start') {
      const native = event.message;
      if (native?.role !== 'assistant' || !identifier(native.id)) return unknown();
      streamMessageId = native.id;
      if (!current.nativeContextId || native.id === current.nativeContextId) return false;
      if (!active || !resultMatched || seenContexts.has(native.id) || seenContexts.size >= MAX_CALLS || native.id === active.native.nativeContextId) return unknown();
      const permit = Object.freeze(Object.create(null));
      const record = { from: active.native.nativeContextId, to: native.id, active, used: false };
      permits.set(permit, record);
      if (!continuationCurrent(record)) return unknown();
      try {
        const result = options.onContinuation(permit);
        if (result !== true || !record.used || invalidated) return unknown();
      } catch { return unknown(); }
      options.mcp.controller.clearPartial(); partial = null; return true;
    }
    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      const tool = event.content_block;
      if (!identifier(streamMessageId) || streamMessageId !== current.nativeContextId || tool.name !== TOOL_NAME || !identifier(tool.id) ||
          (!exact(tool.input, []) && !input(tool.input)) || !Number.isSafeInteger(event.index) || event.index < 0 || partial && partial.messageId === streamMessageId) return unknown();
      partial = { messageId: streamMessageId, index: event.index, id: tool.id, initial: tool.input, text: '', input: null, stopped: false };
    }
    if (partial && partial.messageId === streamMessageId && partial.index === event.index) {
      if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
        if (partial.stopped || typeof event.delta.partial_json !== 'string') return unknown();
        if (!options.mcp.controller.reservePartial(Buffer.byteLength(event.delta.partial_json))) return unknown();
        partial.text += event.delta.partial_json;
      }
      if (event.type === 'content_block_stop') {
        if (partial.stopped) return unknown();
        partial.stopped = true;
        try { partial.input = partial.text ? JSON.parse(partial.text) : partial.initial; } catch { return unknown(); }
        if (!input(partial.input)) return unknown();
        const full = seenTools.get(partial.id);
        if (full && (full.messageId !== partial.messageId || full.nonce !== partial.input.nonce)) return unknown();
        partial.text = ''; options.mcp.controller.clearPartial();
      }
    }
    return true;
  }
  const controller = Object.freeze({
    observe(message) {
      if (invalidated) return true;
      if (message?.type === 'assistant') { observeFull(message); return true; }
      if (message?.type === 'user' && Array.isArray(message.message?.content) && message.message.content.some(item => item?.type === 'tool_result')) { observeResult(message); return true; }
      if (message?.type === 'stream_event') { const handled = observeStream(message); return invalidated || handled; }
      return false;
    },
    inputInFlight() { return !invalidated && options.current()?.inputEpoch > 0; },
    transitioning() { return transitioning; },
    endInput() {
      options.mcp.controller.clearPartial(); options.mcp.controller.endInput(); active = null; resultMatched = false; partial = null; streamMessageId = null;
    },
    invalidate() { return unknown(); },
    async stop() { invalidated = true; partial = null; active = null; resultMatched = false; await options.mcp.controller.stop(); },
  });
  return Object.freeze({ facade, controller });
}
function getOwnedWaitSource(sourceCapability) { return WAIT_SOURCES.get(sourceCapability) || null; }
module.exports = { createOwnedNativeClaudeWait, getOwnedWaitSource };
