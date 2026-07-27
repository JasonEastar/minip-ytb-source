import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const VIDEO_ID = 'dQw4w9WgXcQ';
const RANGE_START = 128 * 1024;
const RANGE_LENGTH = 1024;

class MemoryMMKV {
  static stores = new Map();

  constructor({ id }) {
    if (!MemoryMMKV.stores.has(id)) MemoryMMKV.stores.set(id, new Map());
    this.store = MemoryMMKV.stores.get(id);
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

globalThis.mmkvStorage = MemoryMMKV;

const factory = require('../dist/youtube.bundle.js');
if (typeof factory !== 'function') {
  throw new Error('Bundle did not export a source factory');
}

const sourceStorage = new Map();
const source = factory({
  platform: 'ios',
  fetch: globalThis.fetch.bind(globalThis),
  fileExists: () => false,
  readFile: () => '',
  writeFile: () => {},
  ensureDirectory: () => {},
  getFileUri: (path) => path,
  writeCacheFile: (filename) => filename,
  downloadFile: async () => {},
  cancelDownload: () => {},
  onDownloadProgress: () => () => {},
  storage: {
    get: (key) => sourceStorage.get(key),
    set: (key, value) => sourceStorage.set(key, value),
    delete: (key) => sourceStorage.delete(key),
  },
  log: (...args) => console.log('[youtube-smoke]', ...args),
});

try {
  await source.initialize();

  const download = await source.getDownloadUrl(VIDEO_ID);
  if (!download.url || download.contentLength <= 0) {
    throw new Error('Source returned invalid download metadata');
  }

  const rangeEnd = RANGE_START + RANGE_LENGTH - 1;
  const response = await fetch(download.url, {
    headers: {
      ...download.headers,
      Range: `bytes=${RANGE_START}-${rangeEnd}`,
    },
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (response.status !== 206 || bytes.length !== RANGE_LENGTH) {
    throw new Error(`Resume probe failed: HTTP ${response.status}, ${bytes.length} bytes`);
  }

  const searchResults = await source.search('Rick Astley Never Gonna Give You Up');
  if (!searchResults.some((item) => item.contentId === VIDEO_ID)) {
    throw new Error('Search did not return the expected known video');
  }

  const stream = await source.getStreamUrl(VIDEO_ID);
  if (!stream.url) throw new Error('Source returned an empty stream URL');
  const streamProbe = await fetch(stream.url, {
    headers: {
      ...stream.headers,
      Range: `bytes=0-${RANGE_LENGTH - 1}`,
    },
  });
  const streamBytes = new Uint8Array(await streamProbe.arrayBuffer());
  if (!streamProbe.ok || streamBytes.length === 0) {
    throw new Error(
      `Playback probe failed: HTTP ${streamProbe.status}, ${streamBytes.length} bytes`
    );
  }

  console.log(
    JSON.stringify(
      {
        bundleBytes: (await stat(new URL('../dist/youtube.bundle.js', import.meta.url))).size,
        contentLength: download.contentLength,
        rangeStatus: response.status,
        contentRange: response.headers.get('content-range'),
        searchResults: searchResults.length,
        streamType: stream.isHLS ? 'hls' : 'direct',
        streamStatus: streamProbe.status,
        streamBytes: streamBytes.length,
      },
      null,
      2
    )
  );
} finally {
  await source.dispose();
}
