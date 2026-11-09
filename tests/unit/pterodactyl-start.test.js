'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { missingDependencies, shouldInstallDependencies } = require('../../pterodactyl-start');

test('Pterodactyl startup detects a missing runtime package even when the lockfile hash matches', () => {
  const missing = missingDependencies(
    { express: '*', 'js-confuser': '*' },
    name => {
      if (name === 'js-confuser') {
        const error = new Error(`Cannot find module '${name}'`);
        error.code = 'MODULE_NOT_FOUND';
        throw error;
      }
      return name;
    },
  );

  assert.deepEqual(missing, ['js-confuser']);
  assert.equal(shouldInstallDependencies('same-hash', 'same-hash', missing), true);
  assert.equal(shouldInstallDependencies('old-hash', 'same-hash', []), true);
  assert.equal(shouldInstallDependencies('same-hash', 'same-hash', []), false);
});
