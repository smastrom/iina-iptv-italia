const test = require('node:test');
const assert = require('node:assert/strict');
const sources = require('../source-config.js');
const { matchChannel } = require('../epg-match.js');
const { snapshot } = require('../channel-list.js');

test('keeps the Italian preset for new installs and invalid saved settings', () => {
  assert.deepEqual(sources.read({ get: () => '' }), sources.defaults());
  assert.deepEqual(sources.read({ get: () => '{bad' }), sources.defaults());
});

test('normalizes custom feeds, local paths, and automatic discovery', () => {
  assert.deepEqual(sources.validate({ playlistUrl: ' http://provider.test/get.php?username=a&password=b ',
    epgUrls: 'https://epg.test/a.gz\n\nhttps://epg.test/a.gz\n/Users/example/TV guide.xml' }), {
    playlistUrl: 'http://provider.test/get.php?username=a&password=b',
    epgUrls: ['https://epg.test/a.gz', '/Users/example/TV guide.xml'], overrides: {}
  });
  assert.deepEqual(sources.validate({ playlistUrl: '~/TV/list.m3u', epgUrls: '' }).epgUrls, []);
  assert.equal(sources.validate({ playlistUrl: 'file:///Users/example/list.m3u', epgUrls: [] }).playlistUrl,
    'file:///Users/example/list.m3u');
});

test('rejects invalid source inputs and excessive feed lists', () => {
  for (const playlistUrl of ['', '-o /tmp/file', 'ftp://test/a', 'https://', 'https://test/a\nb', 'relative/list.m3u']) {
    assert.throws(() => sources.validate({ playlistUrl, epgUrls: [] }));
  }
  assert.throws(() => sources.validate({ playlistUrl: '/tmp/list.m3u', epgUrls: Array.from({ length: 17 }, (_, i) => `http://test/${i}`) }));
});

test('persists manual selection, explicit disable, and unusual stream URLs', () => {
  const overrides = JSON.parse('{"https://stream.test/1":"news.id","__proto__":"","https://stream.test/2":null}');
  const config = sources.validate({ playlistUrl: '/tmp/list.m3u', epgUrls: [], overrides });
  assert.equal(config.overrides['https://stream.test/1'], 'news.id');
  assert.equal(config.overrides.__proto__, '');
  assert.equal(Object.getPrototypeOf(config.overrides), Object.prototype);
  assert.deepEqual(sources.read({ get: () => JSON.stringify(config) }), config);
});

test('current channel resolves by URL, then by an unambiguous normalized name', () => {
  const channels = [{ url: 'stream:1', name: 'Télé 1 HD', tvgName: '', epgId: 'one', programmes: [] },
    { url: 'stream:2', name: 'Rai 1 +1', tvgName: '', epgId: 'plus', programmes: [] },
    { url: 'stream:3', name: 'Rai 11', tvgName: '', epgId: 'eleven', programmes: [] }];
  assert.equal(matchChannel(channels, { urls: ['redirect', 'stream:1'] }), channels[0]);
  assert.equal(matchChannel(channels, { title: 'Tele 1 SD' }), channels[0]);
  assert.equal(matchChannel(channels, { title: 'Rai 1 +1' }), channels[1]);
  const rows = snapshot([{ filename: 'redirect', title: 'Tele 1 SD', id: 12 }], channels);
  assert.equal(rows[0].name, 'Télé 1 HD');
  assert.equal(rows[0].id, 12);
  assert.equal(matchChannel([...channels, { url: 'other', name: 'Tele 1', epgId: 'other' }], { title: 'Tele 1' }), null);
  const international = [{ url: 'stream:intl', name: 'Новости HD', tvgName: '', epgId: 'news', programmes: [] }];
  assert.equal(matchChannel(international, { title: ' Новости SD ' }), international[0]);
});
