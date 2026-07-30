import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const videoId = process.argv[2] || 'mwHnDQQ-nMg';
const outputPath = resolve(process.argv[3] || `/tmp/minip-youtube-${videoId}.m3u8`);

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
mkdirSync(dirname(outputPath), { recursive: true });

const factory = require('../dist/youtube.bundle.js');
const sourceStorage = new Map();
let writtenManifest;
const source = factory({
  platform: 'ios',
  fetch: globalThis.fetch.bind(globalThis),
  fileExists: () => false,
  readFile: () => '',
  writeFile: () => {},
  ensureDirectory: () => {},
  getFileUri: (path) => pathToFileURL(path).href,
  writeCacheFile: (_filename, content) => {
    writeFileSync(outputPath, content);
    writtenManifest = content;
    return pathToFileURL(outputPath).href;
  },
  downloadFile: async () => {},
  cancelDownload: () => {},
  onDownloadProgress: () => () => {},
  storage: {
    get: (key) => sourceStorage.get(key),
    set: (key, value) => sourceStorage.set(key, value),
    delete: (key) => sourceStorage.delete(key),
  },
  log: (...args) => console.error('[youtube-hls-local]', ...args),
});

try {
  await source.initialize();
  const stream = await source.getStreamUrl(videoId);
  let manifestPath;
  let manifestBytes;

  if (stream.isHLS && stream.url.startsWith('file:')) {
    manifestPath = outputPath;
    manifestBytes = Buffer.byteLength(writtenManifest || '');
  } else if (stream.isHLS) {
    const response = await fetch(stream.url, { headers: stream.headers });
    if (!response.ok) {
      throw new Error(`Native HLS fetch failed with HTTP ${response.status}`);
    }
    const manifest = await response.text();
    writeFileSync(outputPath, manifest);
    manifestPath = outputPath;
    manifestBytes = Buffer.byteLength(manifest);
  }

  console.log(
    JSON.stringify({
      videoId,
      url: stream.url,
      headers: stream.headers || {},
      isHLS: Boolean(stream.isHLS),
      manifestPath,
      manifestBytes,
    })
  );
} finally {
  await source.dispose();
}
