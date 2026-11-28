const assert = require('node:assert/strict');
const { test } = require('node:test');
const { sendErrorPage } = require('../../scripts/error-pages');
const { safeFilePath } = require('../../scripts/site-updater');

test('error pages retain HTTP status and serve dark local assets without server details', () => {
  for (const status of [400, 401, 403, 404, 429, 500, 502, 503, 504, 599]) {
    const response = { status(code) { this.code = code; return this; }, set() { return this; }, type() { return this; }, send(body) { this.body = body; return this; } };
    sendErrorPage(response, status);
    assert.equal(response.code, status);
    assert.match(response.body, /href="\/errors.css"/);
    assert.doesNotMatch(response.body, /javascript:|<!--#|maximum-scale/);
    assert.match(response.body, /href="\/"/);
  }
  assert.ok(safeFilePath('public/errors/404.html'));
  assert.ok(safeFilePath('public/errors.css'));
  assert.ok(!safeFilePath('public/errors/../../.env'));
});
