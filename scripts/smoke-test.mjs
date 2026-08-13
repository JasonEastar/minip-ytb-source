import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { BotGuardClient } from 'bgutils-js/botguard';
import { buildURL, getHeaders, USER_AGENT } from 'bgutils-js/utils';
import { WebPoMinter } from 'bgutils-js/webpo';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const VIDEO_ID = 'dQw4w9WgXcQ';
const REPORTED_VIDEO_IDS = [
  // Pinkfong Baby Shark exercises the PO-token path: its mobile-client URL
  // allows early bytes but rejects later ranges without content attestation.
  'XqZsoesa55w',
];
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
let sawAndroidVrUserAgent = false;
let sawIosUserAgent = false;
let forcedIndexedHlsRetry = false;
let generatedPoTokenCount = 0;

async function generatePoToken(request) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'https://www.youtube.com/',
    referrer: 'https://www.youtube.com/',
    userAgent: USER_AGENT,
  });
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  const globalKeys = ['window', 'document', 'location', 'origin'];
  const previousDescriptors = new Map(
    globalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
  );

  let botGuardClient;
  try {
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      location: dom.window.location,
      origin: dom.window.origin,
    });
    const interpreter = await fetch(request.interpreterUrl);
    if (!interpreter.ok) throw new Error(`Interpreter HTTP ${interpreter.status}`);
    new Function(await interpreter.text())();

    botGuardClient = await BotGuardClient.create({
      program: request.program,
      globalName: request.globalName,
      globalObject: globalThis,
    });
    botGuardClient.defaultTimeout = 10_000;
    const webPoSignalOutput = [];
    const botguardResponse = await botGuardClient.snapshot(
      { webPoSignalOutput },
      botGuardClient.defaultTimeout
    );
    const integrityResponse = await fetch(buildURL('GenerateIT', true), {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(['O43z0dpjhgX20SCx4KAo', botguardResponse]),
    });
    const [integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken] =
      await integrityResponse.json();
    const minter = await WebPoMinter.create(
      { integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken },
      webPoSignalOutput
    );
    const tokens = {};
    for (const binding of request.contentBindings) {
      tokens[binding] = await minter.mintAsWebsafeString(binding);
      generatedPoTokenCount++;
    }
    return { tokens, expiresAt: Date.now() + estimatedTtlSecs * 1000 - 300_000 };
  } finally {
    if (botGuardClient) await botGuardClient.shutdown().catch(() => undefined);
    dom.window.close();
    for (const key of globalKeys) {
      const descriptor = previousDescriptors.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}
const sourceFetch = async (input, init) => {
  if (typeof init?.body === 'string') {
    try {
      const payload = JSON.parse(init.body);
      const clientName = payload?.context?.client?.clientName;
      const userAgent = new Headers(init.headers).get('User-Agent') || '';
      if (clientName === 'ANDROID_VR') {
        sawAndroidVrUserAgent = userAgent.includes('youtube.vr.oculus');
      } else if (clientName === 'iOS') {
        sawIosUserAgent = userAgent.includes('com.google.ios.youtube');
      }
    } catch {
      // Ignore non-JSON requests.
    }
  }

  // Deterministically exercise the fresh-URL retry used when Google issues a
  // sequential-only media URL. Start/index probes still succeed; the first
  // far one-byte qualification probe receives the 403 seen in production.
  const range = new Headers(init?.headers).get('Range');
  const oneByteRange = range?.match(/^bytes=(\d+)-\1$/);
  if (!forcedIndexedHlsRetry && oneByteRange && Number(oneByteRange[1]) > 1024 * 1024) {
    forcedIndexedHlsRetry = true;
    return new Response(null, { status: 403 });
  }

  return globalThis.fetch(input, init);
};
const source = factory({
  platform: 'ios',
  fetch: sourceFetch,
  fileExists: () => false,
  readFile: () => '',
  writeFile: () => {},
  ensureDirectory: () => {},
  getFileUri: (path) => path,
  writeCacheFile: (_filename, content) =>
    `data:application/vnd.apple.mpegurl;base64,${Buffer.from(content).toString('base64')}`,
  downloadFile: async () => {},
  cancelDownload: () => {},
  onDownloadProgress: () => () => {},
  storage: {
    get: (key) => sourceStorage.get(key),
    set: (key, value) => sourceStorage.set(key, value),
    delete: (key) => sourceStorage.delete(key),
  },
  youtube: { generatePoToken },
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
  if (!sawAndroidVrUserAgent || !sawIosUserAgent) {
    throw new Error(
      `Media client User-Agent mismatch: IOS=${sawIosUserAgent}, ANDROID_VR=${sawAndroidVrUserAgent}`
    );
  }
  // Regression coverage for both mobile 403 reports. Resolve both paths
  // independently so each receives a fresh, verified media URL.
  const reportedResults = [];
  for (const reportedVideoId of REPORTED_VIDEO_IDS) {
    const reportedDownload = await source.getDownloadUrl(reportedVideoId);
    if (reportedDownload.headers?.Range !== 'bytes=0-') {
      throw new Error(`Download ${reportedVideoId} did not request an initial byte range`);
    }

    // Use the source headers unchanged first: this is the request shape used
    // by a fresh native download.
    const openRangeProbe = await fetch(reportedDownload.url, {
      headers: reportedDownload.headers,
    });
    if (openRangeProbe.status !== 206) {
      throw new Error(
        `Reported open-range regression: HTTP ${openRangeProbe.status} for ${reportedVideoId}`
      );
    }
    await openRangeProbe.body?.cancel();

    const reportedDownloadProbe = await fetch(reportedDownload.url, {
      headers: {
        ...reportedDownload.headers,
        Range: `bytes=0-${RANGE_LENGTH - 1}`,
      },
    });
    const reportedDownloadBytes = new Uint8Array(await reportedDownloadProbe.arrayBuffer());
    if (reportedDownloadProbe.status !== 206 || reportedDownloadBytes.length !== RANGE_LENGTH) {
      throw new Error(
        `Reported download regression: HTTP ${reportedDownloadProbe.status}, ${reportedDownloadBytes.length} bytes`
      );
    }

    const reportedStream = await source.getStreamUrl(reportedVideoId);
    const reportedStreamProbe = await fetch(reportedStream.url, {
      headers: {
        ...reportedStream.headers,
        Range: `bytes=0-${RANGE_LENGTH - 1}`,
      },
    });
    const reportedStreamBytes = new Uint8Array(await reportedStreamProbe.arrayBuffer());
    if (!reportedStreamProbe.ok || reportedStreamBytes.length === 0) {
      throw new Error(
        `Reported playback regression: HTTP ${reportedStreamProbe.status}, ${reportedStreamBytes.length} bytes`
      );
    }

    let indexedHlsSegmentBytes;
    if (reportedStream.isHLS && reportedStream.url.startsWith('data:')) {
      const manifest = new TextDecoder().decode(reportedStreamBytes);
      const map = manifest.match(/#EXT-X-MAP:URI="([^"]+)",BYTERANGE="(\d+)@(\d+)"/);
      const segment = manifest.match(/#EXT-X-BYTERANGE:(\d+)@(\d+)\n([^\n]+)/);
      if (!map || !segment) {
        throw new Error(`Indexed HLS manifest is malformed for ${reportedVideoId}`);
      }

      const mapLength = Number(map[2]);
      const mapStart = Number(map[3]);
      const mapProbe = await fetch(map[1], {
        headers: {
          ...reportedStream.headers,
          Range: `bytes=${mapStart}-${mapStart + mapLength - 1}`,
        },
      });
      const mapBytes = new Uint8Array(await mapProbe.arrayBuffer());
      if (mapProbe.status !== 206 || mapBytes.length !== mapLength) {
        throw new Error(
          `Indexed HLS map regression: HTTP ${mapProbe.status}, ${mapBytes.length} bytes`
        );
      }

      const segmentLength = Number(segment[1]);
      const segmentStart = Number(segment[2]);
      const segmentProbe = await fetch(segment[3], {
        headers: {
          ...reportedStream.headers,
          Range: `bytes=${segmentStart}-${segmentStart + segmentLength - 1}`,
        },
      });
      const segmentBytes = new Uint8Array(await segmentProbe.arrayBuffer());
      if (segmentProbe.status !== 206 || segmentBytes.length !== segmentLength) {
        throw new Error(
          `Indexed HLS segment regression: HTTP ${segmentProbe.status}, ${segmentBytes.length} bytes`
        );
      }
      indexedHlsSegmentBytes = segmentBytes.length;
    }

    reportedResults.push({
      videoId: reportedVideoId,
      openRangeStatus: openRangeProbe.status,
      downloadStatus: reportedDownloadProbe.status,
      downloadBytes: reportedDownloadBytes.length,
      streamType: reportedStream.isHLS ? 'hls' : 'direct',
      streamStatus: reportedStreamProbe.status,
      streamBytes: reportedStreamBytes.length,
      indexedHlsSegmentBytes,
    });
  }

  if (!forcedIndexedHlsRetry) {
    throw new Error('Indexed HLS fresh-URL retry was not exercised');
  }
  if (generatedPoTokenCount === 0) {
    throw new Error('Protected-track PO-token fallback was not exercised');
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
        mediaClientHeaders: {
          ios: sawIosUserAgent,
          androidVr: sawAndroidVrUserAgent,
        },
        reportedResults,
        generatedPoTokenCount,
      },
      null,
      2
    )
  );
} finally {
  await source.dispose();
}
