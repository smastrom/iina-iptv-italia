const test = require('node:test');
const assert = require('node:assert/strict');
const { findPython } = require('../python-runtime.js');

const files = (...paths) => ({ exists: path => paths.includes(path) });

test('preferisce Python installato dal normale installer ufficiale', () => {
  assert.equal(findPython(files('/usr/local/bin/python3', '/Library/Developer/CommandLineTools/usr/bin/python3')),
    '/usr/local/bin/python3');
});

test('riutilizza un interprete Homebrew già presente', () => {
  assert.equal(findPython(files('/opt/homebrew/bin/python3')), '/opt/homebrew/bin/python3');
});

test('mantiene la compatibilità con gli strumenti Apple già installati', () => {
  for (const path of ['/Library/Developer/CommandLineTools/usr/bin/python3',
                      '/Applications/Xcode.app/Contents/Developer/usr/bin/python3']) {
    assert.equal(findPython(files(path)), path);
  }
});

test('non scambia lo stub di macOS per un interprete utilizzabile', () => {
  assert.throws(() => findPython(files('/usr/bin/python3')), error => {
    assert.match(error.message, /python\.org\/downloads\/macos/);
    assert.match(error.message, /\.pkg/);
    assert.match(error.message, /Non servono Xcode/);
    return true;
  });
});

test('se manca Python, spiega come installarlo senza comandi', () => {
  assert.throws(() => findPython(files()), /apri il file \.pkg/);
});
