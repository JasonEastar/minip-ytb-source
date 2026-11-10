/**
 * Bundle contract test — loads dist/youtube.bundle.js exactly the way the
 * MiniP WebView runtime does (src/po-token-runtime.ts `initializeYouTubeSource`)
 * and checks what the app relies on, without any network access.
 *
 * Requires a prior `npm run build`.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const BUNDLE_PATH = new URL('../dist/youtube.bundle.js', import.meta.url);
const RUNTIME_ASSET_PATH = new URL('../dist/youtube-po-token.json', import.meta.url);
const RUNTIME_SOURCE_PATH = new URL('../src/po-token-runtime.ts', import.meta.url);
const MANIFEST_PATH = new URL('../manifest.json', import.meta.url);
const RUNTIME_CODE_LIMIT = 5_000_000; // po-token-runtime.ts rejects larger bundles
const EXTERNAL_REQUIRE = /require\(["'](react-native|expo-|react-native-mmkv)/;

// Copied from po-token-runtime.ts `initializeYouTubeSource`; a test below
// checks the runtime still uses exactly this wrapper.
const LOADER_PARAMS = ['module', 'exports', 'host', 'global', 'self', 'globalThis'];
const LOADER_RESOLVER = `
if (typeof module.exports === 'function') {
  return module.exports(host);
} else if (module.exports && typeof module.exports.default === 'function') {
  return module.exports.default(host);
} else {
  return module.exports;
}`;

/** Optional MediaSource methods the app expects when a capability is on. */
const CAPABILITY_METHODS = {
  search: ['search', 'searchGrouped', 'getSearchSuggestions'],
  feed: ['getHomeFeed'],
  suggestions: ['getSuggestions'],
  playlists: ['getCollection', 'getArtist'],
  subtitles: ['getSubtitles'],
};
const REQUIRED_METHODS = ['initialize', 'dispose', 'getStreamUrl', 'getDownloadUrl'];

function networkDisabled() {
  throw new Error('network disabled in bundle contract test');
}

class MemoryMMKV {
  constructor() {
    this.store = new Map();
  }
  getBuffer(key) {
    return this.store.get(key);
  }
  set(key, value) {
    this.store.set(key, value);
  }
  delete(key) {
    this.store.delete(key);
  }
}

function createHost(fetchImpl = networkDisabled) {
  return {
    platform: 'ios',
    fetch: fetchImpl,
    writeCacheFile: networkDisabled,
    youtube: { evaluatePlayerScript: networkDisabled, generatePoToken: networkDisabled },
    log() {},
  };
}

/** Run `fn` with the globals the WebView runtime sets before evaluating the bundle. */
async function withRuntimeGlobals(fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = networkDisabled;
  globalThis.mmkvStorage = MemoryMMKV;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.mmkvStorage;
  }
}

function loadSource(code, host) {
  const moduleObject = { exports: {} };
  const factory = new Function(...LOADER_PARAMS, `${code}\n;${LOADER_RESOLVER}`);
  const source = factory.call(
    globalThis,
    moduleObject,
    moduleObject.exports,
    host,
    globalThis,
    globalThis,
    globalThis
  );
  return { moduleObject, source };
}

let code;
let manifest;
let moduleObject;
let source;

before(async () => {
  assert.ok(existsSync(BUNDLE_PATH), 'dist/youtube.bundle.js missing: run `npm run build` first');
  code = readFileSync(BUNDLE_PATH, 'utf8');
  manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  ({ moduleObject, source } = await withRuntimeGlobals(() => loadSource(code, createHost())));
});

test('test loader matches the WebView runtime loader', () => {
  const runtime = readFileSync(RUNTIME_SOURCE_PATH, 'utf8');
  const paramList = LOADER_PARAMS.map((param) => `'${param}'`).join(',\n    ');
  assert.ok(runtime.includes(`new Function(\n    ${paramList},`), 'runtime loader params changed');
  assert.ok(runtime.includes(LOADER_RESOLVER), 'runtime loader resolver changed');
  assert.ok(runtime.includes(`request.code.length > ${RUNTIME_CODE_LIMIT.toLocaleString('en-US').replace(/,/g, '_')}`), 'runtime code limit changed');
});

test('bundle fits the runtime code limit and has no external requires', () => {
  assert.ok(code.length < RUNTIME_CODE_LIMIT, `bundle is ${code.length} chars`);
  assert.doesNotMatch(code, EXTERNAL_REQUIRE);
});

test('bundle exports a factory that returns a source object', () => {
  assert.equal(typeof moduleObject.exports, 'function');
  assert.equal(typeof source, 'object');
  assert.ok(source !== null);
});

test('source implements every required method', () => {
  for (const method of REQUIRED_METHODS) {
    assert.equal(typeof source[method], 'function', `missing ${method}`);
  }
});

test('source metadata equals manifest.json', () => {
  const { id, name, version, capabilities } = source;
  assert.deepEqual(
    { id, name, version, capabilities },
    {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      capabilities: manifest.capabilities,
    }
  );
});

test('source implements the methods its capabilities promise', () => {
  for (const [capability, methods] of Object.entries(CAPABILITY_METHODS)) {
    if (!manifest.capabilities[capability]) continue;
    for (const method of methods) {
      assert.equal(typeof source[method], 'function', `${capability} requires ${method}`);
    }
  }
});

test('browse requests go through host.fetch, never the global fetch', async () => {
  const requested = [];
  const recordingFetch = async (input) => {
    requested.push(input instanceof Request ? input.url : String(input)); // string or URL
    return new Response('', { status: 503, statusText: 'test' });
  };

  const results = await withRuntimeGlobals(async () => {
    const { source: instance } = loadSource(code, createHost(recordingFetch));
    await instance.initialize(); // youtubei.js setup fails on 503 and is logged, not thrown
    const items = await instance.search('contract test');
    await instance.dispose();
    return items;
  });

  assert.deepEqual(results, []);
  assert.ok(
    requested.some((url) => url.startsWith('https://www.youtube.com/sw.js_data')),
    `session request missing from host.fetch calls: ${requested.join(', ')}`
  );
});

test('WebView runtime asset is built next to the bundle', () => {
  assert.ok(existsSync(RUNTIME_ASSET_PATH), 'dist/youtube-po-token.json missing');
  const html = JSON.parse(readFileSync(RUNTIME_ASSET_PATH, 'utf8'));
  assert.equal(typeof html, 'string');
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('__MINIP_RUN_YOUTUBE_SOURCE_OPERATION__'));
  assert.ok(html.includes('__MINIP_GENERATE_YOUTUBE_PO_TOKEN__'));
});
