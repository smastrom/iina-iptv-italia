const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const path = require('node:path');
const sources = require('../source-config.js');
const entry = path.resolve(__dirname, '../global.js');
const tick = () => new Promise(resolve => setImmediate(resolve));

function runtime(saved = sources.defaults()) {
  const globalHandlers = {}, guideHandlers = {}, menus = {}, posts = [], windows = [], jobs = [], timers = [];
  const settings = { sources: JSON.stringify(saved) };
  let disk = '';
  let synced = 0;
  const iina = {
    global: { onMessage: (name, callback) => { globalHandlers[name] = callback; },
      postMessage: (target, name, message) => {
        assert.equal(typeof message, 'string', 'player messages must bypass the native object bridge');
        posts.push({ target, name, value: JSON.parse(message) });
      },
      createPlayerInstance: value => { windows.push(value); return windows.length; } },
    menu: { item: (name, callback) => ({ name, callback }), addItem: item => { menus[item.name] = item.callback; } },
    preferences: { get: key => settings[key], set: (key, value) => { settings[key] = value; }, sync: () => { synced++; } },
    file: { exists: () => true, read: () => disk },
    utils: { resolvePath: value => value, exec: (python, args) => new Promise(resolve => {
      jobs.push({ config: JSON.parse(args[3]), force: args[4], finish: (success = true) => {
        disk = JSON.stringify({ configKey: args[3], updated: Date.now(), channels: [{ url: 'stream', name: 'News' }], epgChannels: [{ id: 'news', name: 'News' }] });
        resolve({ status: success ? 0 : 1, stderr: 'Example download failure' });
      } });
    }) },
    standaloneWindow: { onMessage: (name, callback) => { guideHandlers[name] = callback; },
      postMessage: (name, message) => posts.push({ name, value: JSON.parse(decodeURIComponent(message.payload)) }),
      loadFile() {}, setProperty() {}, setFrame() {}, open() {} }
  };
  vm.runInNewContext(fs.readFileSync(entry, 'utf8'), {
    iina, require: createRequire(entry), Set, Date, JSON, Promise,
    setTimeout: callback => timers.push(callback)
  });
  return { globalHandlers, guideHandlers, menus, posts, windows, jobs, settings,
    flushMessages: () => { for (const callback of timers.splice(0)) callback(); },
    get synced() { return synced; } };
}

test('opens the saved custom playlist and persists source changes', async () => {
  const app = runtime({ playlistUrl: 'http://provider.test/custom.m3u', epgUrls: [], overrides: {} });
  app.menus['Apri IPTV Italia']();
  assert.equal(app.windows[0].url, 'http://provider.test/custom.m3u');
  app.guideHandlers['save-sources']({ playlistUrl: '/tmp/new.m3u', epgUrls: '' });
  assert.equal(JSON.parse(app.settings.sources).playlistUrl, '/tmp/new.m3u');
  assert.equal(app.synced, 1);
  app.flushMessages();
  assert.ok(app.posts.some(post => post.name === 'iptv-sources-changed'));
});

test('shares one loader and delivers data to managed and regular windows', async () => {
  const app = runtime();
  const first = app.globalHandlers['iptv-epg-request']({}, '1-local.iptv-italia');
  const second = app.globalHandlers['iptv-epg-request']({}, 'regular-player');
  assert.equal(app.jobs.length, 1);
  app.jobs[0].finish();
  await Promise.all([first, second]);
  assert.equal(app.posts.length, 0, 'replies must wait until the player callback has returned');
  app.flushMessages();
  assert.ok(app.posts.some(post => post.name === 'iptv-epg-data' && post.target === null));
  assert.ok(app.posts.some(post => post.name === 'iptv-epg-data' && post.target === 'regular-player'));
  await app.globalHandlers['iptv-epg-request']({}, 'regular-player');
  assert.equal(app.jobs.length, 1);
});

test('source changes during a download never publish the old sources', async () => {
  const app = runtime();
  const first = app.globalHandlers['iptv-epg-request']({}, 'regular-player');
  app.guideHandlers['save-sources']({ playlistUrl: 'https://new.test/list.m3u', epgUrls: [] });
  const second = app.globalHandlers['iptv-epg-request']({}, 'second-player');
  app.jobs[0].finish();
  await tick();
  assert.equal(app.jobs.length, 2);
  assert.equal(app.jobs[1].config.playlistUrl, 'https://new.test/list.m3u');
  app.jobs[1].finish();
  await Promise.all([first, second]);
  app.flushMessages();
  const data = app.posts.filter(post => post.name === 'iptv-epg-data');
  assert.ok(data.length > 0);
  assert.ok(data.every(post => JSON.parse(post.value.configKey).playlistUrl === 'https://new.test/list.m3u'));
});

test('manual corrections validate IDs and preserve existing source settings', async () => {
  const app = runtime();
  const request = app.globalHandlers['iptv-epg-request']({}, 'regular-player');
  app.jobs[0].finish();
  await request;
  app.guideHandlers['match-channel']({ url: 'stream', id: 'unknown' });
  assert.equal(app.synced, 0);
  app.guideHandlers['match-channel']({ url: 'stream', id: 'news' });
  assert.equal(JSON.parse(app.settings.sources).overrides.stream, 'news');
  assert.equal(app.synced, 1);
});

test('cached replies and loader errors are deferred and serialized', async () => {
  const app = runtime();
  const first = app.globalHandlers['iptv-epg-request']({}, 'regular-player');
  app.jobs[0].finish();
  await first;
  app.flushMessages();
  app.posts.length = 0;
  await app.globalHandlers['iptv-epg-request']({}, 'regular-player');
  assert.equal(app.posts.length, 0);
  app.flushMessages();
  assert.ok(app.posts.some(post => post.name === 'iptv-epg-data' && post.value.channels.length));

  app.posts.length = 0;
  const failed = app.globalHandlers['iptv-epg-request']({ force: true }, 'regular-player');
  app.jobs[1].finish(false);
  await failed;
  assert.equal(app.posts.length, 0);
  app.flushMessages();
  assert.ok(app.posts.some(post => post.name === 'iptv-epg-error' && /Example download failure/.test(post.value)));
});

test('source changes discard replies still waiting for delivery', async () => {
  const app = runtime();
  const request = app.globalHandlers['iptv-epg-request']({}, 'regular-player');
  app.jobs[0].finish();
  await request;
  app.guideHandlers['save-sources']({ playlistUrl: 'https://new.test/list.m3u', epgUrls: [] });
  app.flushMessages();
  assert.ok(app.posts.some(post => post.name === 'iptv-sources-changed'));
  assert.ok(!app.posts.some(post => post.name === 'iptv-epg-data'));
});
