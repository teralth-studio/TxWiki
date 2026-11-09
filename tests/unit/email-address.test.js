'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { senderEmailAddress, validEmailAddress } = require('../../scripts/auth/email-address');

test('email validation rejects oversized or structurally invalid input', () => {
  assert.equal(validEmailAddress('person@example.test'), true);
  assert.equal(validEmailAddress('person+tag@example.test'), true);
  assert.equal(validEmailAddress('person@@example.test'), false);
  assert.equal(validEmailAddress('person @example.test'), false);
  assert.equal(validEmailAddress(`a@${'b'.repeat(250)}.test`), false);
});

test('sender email extraction accepts display-name forms without a backtracking expression', () => {
  assert.equal(senderEmailAddress('Wiki Support <support@example.test>'), 'support@example.test');
  assert.equal(senderEmailAddress('support@example.test'), 'support@example.test');
  assert.equal(validEmailAddress(senderEmailAddress('Wiki Support <support@example.test>')), true);
});
