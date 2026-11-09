'use strict';

const fs = require('node:fs');

async function readRegularFileNoFollow(filePath) {
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | noFollow);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      const error = new Error('Expected a regular file.');
      error.code = 'ERR_NOT_REGULAR_FILE';
      throw error;
    }
    return { content: await handle.readFile(), mode: stat.mode & 0o777 };
  } finally {
    await handle.close();
  }
}

module.exports = { readRegularFileNoFollow };
