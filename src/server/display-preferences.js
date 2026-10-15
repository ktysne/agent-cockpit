'use strict';

const { isRecord } = require('./value-utils');

const SECTION_ORDER = Object.freeze(['sinceSeen', 'judgment', 'tasks', 'now', 'prs']);
const DEFAULT_SECTION_ORDER = Object.freeze(['sinceSeen', 'judgment', 'prs', 'tasks', 'now']);
const DISPLAY_FILTERS = Object.freeze(['permission', 'blocking', 'provisional', 'agents', 'prs']);
// 有効な表示フィルターではない held は保存値から除き、更新要求でも拒否する。
const LEGACY_DISPLAY_FILTERS = Object.freeze(['held']);

const DISPLAY_SCHEMA = Object.freeze({
  diagnosticsLevel: Object.freeze({ type: 'enum', default: 'info', values: Object.freeze(['silent', 'error', 'warn', 'info', 'debug']) }),
  mode: Object.freeze({ type: 'enum', default: 'kind', values: Object.freeze(['product', 'kind']) }),
  order: Object.freeze({ type: 'string-array', default: Object.freeze([]), maxItems: 200, maxItemLength: 500 }),
  pinned: Object.freeze({ type: 'string-array', default: Object.freeze([]), maxItems: 200, maxItemLength: 500 }),
  collapsed: Object.freeze({ type: 'string-array', default: Object.freeze([]), maxItems: 200, maxItemLength: 500 }),
  hidden: Object.freeze({ type: 'filter-array', default: Object.freeze([]), maxItems: 200, maxPatchItems: DISPLAY_FILTERS.length, maxItemLength: 500 }),
  sectionOrder: Object.freeze({ type: 'section-array', default: DEFAULT_SECTION_ORDER, maxPatchItems: SECTION_ORDER.length }),
  longWaitMinutes: Object.freeze({ type: 'integer', default: 15, minimum: 1, maximum: 120 }),
  awayAnswerWaitMinutes: Object.freeze({ type: 'integer', default: 3, minimum: 1, maximum: 30 }),
  idleHideMinutes: Object.freeze({ type: 'integer', default: 10, minimum: 5, maximum: 1440 }),
  hideFinished: Object.freeze({ type: 'boolean', default: true }),
  importAppTasks: Object.freeze({ type: 'boolean', default: false }),
  importAppTasksAsked: Object.freeze({ type: 'boolean', default: false }),
  mergeableCondition: Object.freeze({ type: 'enum', default: 'cross-review', values: Object.freeze(['operation', 'ci', 'cross-review']) }),
});

const DISPLAY_KEYS = new Set(Object.keys(DISPLAY_SCHEMA));
const SECTION_ORDER_KEYS = new Set(SECTION_ORDER);
const DISPLAY_FILTER_KEYS = new Set(DISPLAY_FILTERS);
const LEGACY_DISPLAY_FILTER_KEYS = new Set(LEGACY_DISPLAY_FILTERS);

const DEFAULT_DISPLAY = Object.freeze(Object.fromEntries(Object.entries(DISPLAY_SCHEMA).map(([key, definition]) => (
  [key, Array.isArray(definition.default) ? Object.freeze([...definition.default]) : definition.default]
))));

function cloneDisplay(display) {
  if (display === null) return null;
  return Object.fromEntries(Object.keys(DISPLAY_SCHEMA).map((key) => (
    [key, Array.isArray(display[key]) ? [...display[key]] : display[key]]
  )));
}

function defaultDisplay() {
  return cloneDisplay(DEFAULT_DISPLAY);
}

function normalizeSectionOrder(order) {
  const known = [];
  for (const key of Array.isArray(order) ? order : []) {
    if (SECTION_ORDER_KEYS.has(key) && !known.includes(key)) known.push(key);
  }
  return [...known, ...DEFAULT_SECTION_ORDER.filter((key) => !known.includes(key))];
}

function normalizeDisplay(value) {
  if (value === null) return null;
  if (!isRecord(value) || !DISPLAY_SCHEMA.mode.values.includes(value.mode)) throw new Error('Invalid display preferences');
  if (Object.hasOwn(value, 'sectionOrder') && !Array.isArray(value.sectionOrder)) throw new Error('Invalid display preferences');

  for (const key of ['order', 'pinned', 'collapsed']) {
    const definition = DISPLAY_SCHEMA[key];
    if (!validStringArray(value[key], definition.maxItems, definition.maxItemLength)) throw new Error('Invalid display preferences');
  }
  const hiddenDefinition = DISPLAY_SCHEMA.hidden;
  if (!validStringArray(value.hidden, hiddenDefinition.maxItems, hiddenDefinition.maxItemLength, false)) {
    throw new Error('Invalid display preferences');
  }
  const hidden = value.hidden.filter((key) => DISPLAY_FILTER_KEYS.has(key));
  if (value.hidden.some((key) => !DISPLAY_FILTER_KEYS.has(key) && !LEGACY_DISPLAY_FILTER_KEYS.has(key)) ||
    new Set(hidden).size !== hidden.length) {
    throw new Error('Invalid display preferences');
  }

  const result = {};
  for (const [key, definition] of Object.entries(DISPLAY_SCHEMA)) {
    const field = value[key];
    if (definition.type === 'integer') {
      result[key] = Number.isInteger(field) && field >= definition.minimum && field <= definition.maximum
        ? field
        : definition.default;
    } else if (definition.type === 'boolean') {
      result[key] = typeof field === 'boolean' ? field : definition.default;
    } else if (key === 'hidden') {
      result[key] = hidden;
    } else if (key === 'sectionOrder') {
      result[key] = normalizeSectionOrder(field);
    } else if (key === 'mergeableCondition' || key === 'diagnosticsLevel') {
      result[key] = definition.values.includes(field) ? field : definition.default;
    } else if (Array.isArray(definition.default)) {
      result[key] = [...field];
    } else {
      result[key] = field;
    }
  }
  if (result.importAppTasksAsked !== true) result.importAppTasks = false;
  return result;
}

// 保存値は互換補正し、更新要求は範囲外の値を拒否する。
function validDisplayPatch(value) {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (!keys.length || keys.some((key) => !DISPLAY_KEYS.has(key))) return false;
  for (const key of keys) {
    const definition = DISPLAY_SCHEMA[key];
    const field = value[key];
    if (definition.type === 'enum' && !definition.values.includes(field)) return false;
    if (definition.type === 'integer' && (!Number.isInteger(field) || field < definition.minimum || field > definition.maximum)) return false;
    if (definition.type === 'boolean' && typeof field !== 'boolean') return false;
    if (definition.type === 'string-array' && !validStringArray(field, definition.maxItems, definition.maxItemLength)) return false;
    if (definition.type === 'section-array' && (!Array.isArray(field) || field.length > definition.maxPatchItems ||
      field.some((item) => typeof item !== 'string' || !SECTION_ORDER_KEYS.has(item)) || new Set(field).size !== field.length)) return false;
    if (definition.type === 'filter-array' && (!Array.isArray(field) || field.length > definition.maxPatchItems ||
      field.some((item) => typeof item !== 'string' || !DISPLAY_FILTER_KEYS.has(item)) || new Set(field).size !== field.length)) return false;
  }
  return true;
}

function validStringArray(value, maximumItems, maximumItemLength, requireUnique = true) {
  return Array.isArray(value) && value.length <= maximumItems &&
    value.every((item) => typeof item === 'string' && item.length <= maximumItemLength) &&
    (!requireUnique || new Set(value).size === value.length);
}

module.exports = {
  DEFAULT_DISPLAY,
  DEFAULT_SECTION_ORDER,
  DISPLAY_FILTERS,
  DISPLAY_SCHEMA,
  SECTION_ORDER,
  cloneDisplay,
  defaultDisplay,
  normalizeDisplay,
  validDisplayPatch,
};
