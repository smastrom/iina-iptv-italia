const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('Python parser, matching, HTTP/local sources, discovery, and cache integration', () => {
  const result = spawnSync('python3', [path.join(__dirname, 'test_epg_helper.py')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
