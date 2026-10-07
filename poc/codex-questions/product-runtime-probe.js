'use strict';

const { startMcpServer } = require('../../src/mcp/server');

startMcpServer().catch(() => {
  process.exitCode = 1;
});
