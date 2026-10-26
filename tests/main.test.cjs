const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const path = require('node:path');
const sources = require('../source-config.js');
const entry = path.resolve(__dirname, '../main.js');
const stream = 'https://stream.test/news.m3u8';

function guide() {
  return { cacheVersion: 2, configKey: JSON.stringify(sources.defaults()), updated: Date.now(),
    channels: [{ url: stream, name: 'News', programmes: [] }] };
}

function runtime({ label = null, cached = null } = {}) {
  const events = {}, globalHandlers = {}, sidebarHandlers = {}, menus = new Map();
  const posts = [], sidebarPosts = [], timers = new Map(), intervals = [];
  const props = { playlist: [], 'playlist-pos': -1, path: '', 'idle-active': true };
  const window = { loaded: false };
  let timerId = 0, shows = 0, receiving = false;
  const iina = {
    core: { window },
    event: { on: (name, callback) => { events[name] = callback; } },
    global: { getLabel: () => label,
      onMessage: (name, callback) => { globalHandlers[name] = callback; },
      postMessage: (name, value) => {
        assert.equal(receiving, false, 'a reply must not reenter the global JS context');
        posts.push({ name, value });
      } },
    mpv: { getNative: name => props[name], getNumber: name => props[name],
      getString: name => props[name], getFlag: name => props[name] },
    sidebar: { loadFile() {}, show: () => { shows++; },
      onMessage: (name, callback) => { sidebarHandlers[name] = callback; },
      postMessage: (name, value) => sidebarPosts.push({ name, value: JSON.parse(decodeURIComponent(value.payload)) }) },
    menu: { item: (name, callback) => ({ name, callback }),
      addItem: item => menus.set(item.name, item.callback), removeAllItems: () => menus.clear() },
    file: { exists: () => Boolean(cached), read: () => JSON.stringify(cached) },
    playlist: { play() {} }, preferences: { get: () => '' }
  };
  vm.runInNewContext(fs.readFileSync(entry, 'utf8'), {
    iina, require: createRequire(entry), Date, JSON,
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id), setInterval: callback => intervals.push(callback)
  });
  function load(url = stream, title = 'News') {
    props.playlist = [{ id: 1, filename: url, title, current: true }];
    props['playlist-pos'] = 0; props.path = url; props['media-title'] = title;
    props['idle-active'] = false;
    if (!window.loaded) { window.loaded = true; events['iina.window-loaded'](); }
    events['mpv.file-loaded']();
  }
  function receive(value, name = 'iptv-epg-data') {
    receiving = true;
    try { globalHandlers[name](JSON.stringify(value)); }
    finally { receiving = false; }
    const pending = [...timers.values()];
    timers.clear();
    pending.forEach(callback => callback());
  }
  return { events, globalHandlers, sidebarHandlers, menus, posts, sidebarPosts, props, window, load,
    get shows() { return shows; },
    receive,
    refresh: () => intervals.forEach(callback => callback()) };
}

test('startup and an empty managed window have no playback menus or EPG requests', () => {
  const app = runtime({ label: 'iptv-italia' });
  app.events['iina.menu-update']();
  assert.equal(app.menus.size, 0);
  app.window.loaded = true;
  app.events['iina.window-loaded']();
  app.sidebarHandlers.ready();
  app.refresh();
  assert.equal(app.menus.size, 0);
  assert.equal(app.posts.length, 0);
  assert.equal(app.shows, 0);
});

test('unrelated media with the same channel title never enables the EPG commands', () => {
  for (const label of [null, 'iptv-italia']) {
    const app = runtime({ label, cached: guide() });
    app.load('/tmp/News.mp4');
    app.sidebarHandlers.ready();
    app.events['iina.menu-update']();
    assert.equal(app.menus.size, 0);
    assert.equal(app.posts.length, 0);
    assert.equal(app.shows, 0);
  }
});

test('IPTV playback exposes both commands and opens the requested sidebar view', () => {
  const app = runtime({ label: 'iptv-italia' });
  app.load();
  app.sidebarHandlers.ready();
  assert.deepEqual([...app.menus.keys()], ['Canali con EPG', 'EPG del canale corrente']);
  assert.equal(app.posts.filter(post => post.name === 'iptv-epg-request').length, 1);
  app.receive(guide());
  app.menus.get('Canali con EPG')();
  assert.ok(app.sidebarPosts.some(post => post.name === 'show-channels'));
  app.sidebarHandlers['channels-open']();
  assert.ok(app.sidebarPosts.some(post => post.name === 'channel-list' && post.value.length === 1));
  app.receive(guide());
  app.menus.get('EPG del canale corrente')();
  assert.ok(app.sidebarPosts.some(post => post.name === 'show-programme'));
  app.globalHandlers['iptv-epg-error'](JSON.stringify('Feed unavailable'));
  assert.ok(app.sidebarPosts.some(post => post.name === 'state' && post.value.error === 'Feed unavailable'));
});

test('stop and close remove commands and ignore late replies and stale menu callbacks', () => {
  for (const event of ['mpv.end-file', 'iina.window-will-close']) {
    const app = runtime({ label: 'iptv-italia' });
    app.load(); app.sidebarHandlers.ready();
    const callbacks = [...app.menus.values()];
    app.events[event]();
    assert.equal(app.menus.size, 0);
    const shows = app.shows, requests = app.posts.length;
    callbacks.forEach(callback => callback());
    app.receive(guide()); app.refresh();
    assert.equal(app.shows, shows);
    assert.equal(app.posts.length, requests);
    assert.equal(app.menus.size, 0);
    app.load();
    assert.equal(app.menus.size, 2);
  }
});

test('regular windows recognize playlist streams and remove commands for other media', () => {
  const app = runtime({ cached: guide() });
  app.load();
  assert.equal(app.menus.size, 2);
  const staleAction = app.menus.get('Canali con EPG');
  app.load('/tmp/movie.mp4');
  assert.equal(app.menus.size, 0);
  const shows = app.shows, requests = app.posts.length;
  staleAction();
  assert.equal(app.shows, shows);
  assert.equal(app.posts.length, requests);
});

test('source changes can replace a pending request without reentering the controller', () => {
  const app = runtime({ label: 'iptv-italia' });
  app.load();
  assert.equal(app.posts.filter(post => post.name === 'iptv-epg-request').length, 1);
  app.receive(true, 'iptv-sources-changed');
  assert.equal(app.posts.filter(post => post.name === 'iptv-epg-request').length, 2);
});
