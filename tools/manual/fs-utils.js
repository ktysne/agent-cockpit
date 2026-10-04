'use strict';

const fs = require('node:fs/promises');

async function removeDirectory(directory, options = {}) {
  await fs.rm(directory, {
    recursive: true,
    force: true,
    maxRetries: options.maxRetries ?? 10,
    retryDelay: options.retryDelay ?? 100,
  });
}

module.exports = { removeDirectory };
