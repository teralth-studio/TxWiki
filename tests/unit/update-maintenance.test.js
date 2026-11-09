'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createUpdateMaintenance } = require('../../scripts/update-maintenance');

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    set(headers) {
      Object.assign(this.headers, headers);
      return this;
    },
    type(contentType) {
      this.contentType = contentType;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    sendStatus(code) {
      this.statusCode = code;
      return this;
    },
  };
}

test('maintenance mode blocks site and API access while allowing only progress and its assets', () => {
  const maintenance = createUpdateMaintenance({ page: '<html>Updating...</html>' });
  let continued = 0;
  const next = () => continued++;
  maintenance.set('backup', 38);

  const blocked = responseRecorder();
  maintenance.middleware({ method: 'GET', path: '/api/config' }, blocked, next);
  assert.equal(blocked.statusCode, 503);
  assert.equal(blocked.contentType, 'html');
  assert.equal(blocked.body, '<html>Updating...</html>');
  assert.equal(blocked.headers['Cache-Control'], 'no-store, no-cache, must-revalidate');
  assert.equal(blocked.headers['X-Robots-Tag'], 'noindex, nofollow');

  for (const [method, path] of [
    ['GET', '/api/updates/progress'],
    ['GET', '/maintenance.js'],
    ['HEAD', '/maintenance.css'],
  ])
    maintenance.middleware({ method, path }, responseRecorder(), next);
  assert.equal(continued, 3);

  for (const [method, path] of [
    ['POST', '/api/updates/progress'],
    ['GET', '/api/admin/updates'],
    ['GET', '/languages/language_en.json'],
  ]) {
    const response = responseRecorder();
    maintenance.middleware({ method, path }, response, next);
    assert.equal(response.statusCode, 503);
  }
  assert.equal(continued, 3);
  maintenance.clear();
});

test('progress endpoint exposes only update state without requiring authentication', () => {
  const maintenance = createUpdateMaintenance({ page: '' });
  const inactive = responseRecorder();
  maintenance.progress({}, inactive);
  assert.deepEqual(inactive.body, {
    active: false,
    progress: 0,
    stage: 'idle',
    phase: 'preparation',
    phaseProgress: 0,
  });

  maintenance.set('verifying', 16, 45);
  const active = responseRecorder();
  maintenance.progress({}, active);
  assert.deepEqual(active.body, {
    active: true,
    progress: 16,
    stage: 'verifying',
    phase: 'verification',
    phaseProgress: 45,
  });
  assert.equal(active.headers['Cache-Control'], 'no-store, no-cache, must-revalidate');
  assert.equal(active.headers['X-Content-Type-Options'], 'nosniff');
  maintenance.clear();
});

test('failed updates display a short maintenance notice and then reopen the site', async () => {
  const maintenance = createUpdateMaintenance({ page: '', reopenDelay: 10 });
  maintenance.set('verifying', 12, 38);
  maintenance.fail();
  assert.deepEqual(maintenance.state, {
    active: true,
    progress: 12,
    stage: 'failed',
    phase: 'verification',
    phaseProgress: 38,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(maintenance.state, {
    active: false,
    progress: 0,
    stage: 'idle',
    phase: 'preparation',
    phaseProgress: 0,
  });
  maintenance.clear();
});
