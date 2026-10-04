'use strict';

function escapeHtml(value, { escapeSingleQuote = true } = {}) {
  const escaped = String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return escapeSingleQuote ? escaped.replace(/'/g, '&#39;') : escaped;
}

module.exports = { escapeHtml };
