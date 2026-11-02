const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

test('Basic Needs recurrence persists and advances without duplicate notifications', () => {
  const electron = require('electron');
  const runner = path.join(__dirname, 'basic-needs.verify.cjs');
  const output = execFileSync(electron, ['-e', `require(${JSON.stringify(runner)})`], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 15000
  });
  assert.match(output, /Basic Needs SQLite verification passed/);
});
