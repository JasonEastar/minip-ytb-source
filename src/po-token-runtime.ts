import { BotGuardClient } from 'bgutils-js/botguard';
import type { WebPoSignalOutput } from 'bgutils-js/shared-types';
import { WebPoMinter } from 'bgutils-js/webpo';

const TOKEN_EXPIRY_SAFETY_MS = 5 * 60 * 1000;

interface PoTokenRequest {
  requestId: string;
  interpreterUrl: string;
  program: string;
  globalName: string;
  contentBindings: string[];
}

interface NativeBridge {
  postMessage(message: string): void;
}

interface SourceRuntimeRequest {
  operation: 'initialize' | 'invoke' | 'dispose';
  requestId: string;
  runtimeId: string;
  code?: string;
  platform?: 'ios' | 'android';
  method?: string;
  args?: unknown[];
}

interface SourceRuntimeHostResponse {
  hostRequestId: string;
  result?: unknown;
  error?: string;
}

interface SourceRuntimeCacheFile {
  url: string;
  filename: string;
  content: string;
}

interface SourceRuntimeFetchResponse {
  responseId: string;
  status: number;
  statusText: string;
  url: string;
  headers: Record<string, string>;
}

interface RuntimeMediaSource {
  id: string;
  name: string;
  version: string;
  initialize(): Promise<void>;
  dispose(): Promise<void>;
  [key: string]: unknown;
}

interface PoTokenIntegrityResponse {
  requestId: string;
  integrityToken: string;
  estimatedTtlSecs: number;
  mintRefreshThreshold: number;
  websafeFallbackToken: string;
}

interface PendingMint {
  request: PoTokenRequest;
  botGuardClient: BotGuardClient;
  interpreterScript: HTMLScriptElement;
  webPoSignalOutput: WebPoSignalOutput;
}

declare global {
  interface Window {
    ReactNativeWebView?: NativeBridge;
    __MINIP_GENERATE_YOUTUBE_PO_TOKEN__: (request: PoTokenRequest) => Promise<void>;
    __MINIP_COMPLETE_YOUTUBE_PO_TOKEN__: (response: PoTokenIntegrityResponse) => Promise<void>;
    __MINIP_EVALUATE_YOUTUBE_PLAYER__: (request: {
      requestId: string;
      output: string;
    }) => Promise<void>;
    __MINIP_RUN_YOUTUBE_SOURCE_OPERATION__: (request: SourceRuntimeRequest) => Promise<void>;
    __MINIP_RESOLVE_YOUTUBE_SOURCE_HOST_CALL__: (response: SourceRuntimeHostResponse) => void;
  }
}

const pendingMints = new Map<string, PendingMint>();
const pendingSourceHostCalls = new Map<
  string,
  { resolve: (result: unknown) => void; reject: (error: Error) => void }
>();
const sourceCacheFiles = new Map<string, SourceRuntimeCacheFile>();
let sourceHostCallSequence = 0;
let sourceCacheFileSequence = 0;
const youtubeSources = new Map<string, RuntimeMediaSource>();
const browserFetch = globalThis.fetch.bind(globalThis);

function postMessage(message: Record<string, unknown>): void {
  window.ReactNativeWebView?.postMessage(JSON.stringify(message));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function callNativeSourceHost<T>(method: string, args: unknown[]): Promise<T> {
  const hostRequestId = `host-${Date.now()}-${++sourceHostCallSequence}`;
  return new Promise<T>((resolve, reject) => {
    pendingSourceHostCalls.set(hostRequestId, {
      resolve: resolve as (result: unknown) => void,
      reject,
    });
    postMessage({
      type: 'youtube-source-host-call',
      hostRequestId,
      method,
      args,
    });
  });
}

function headersRecord(headers?: HeadersInit): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) return result;
  new Headers(headers).forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

function decodeBase64(value: string): ArrayBuffer {
  const decoded = atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes.buffer;
}

async function sourceFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const inputRequest = input instanceof Request ? input : null;
  const url = inputRequest?.url ?? input.toString();
  const method = init.method ?? inputRequest?.method ?? 'GET';

  // Player scripts are large and public. Fetch them inside the browser so the
  // multi-megabyte source never crosses React Native's JS bridge. API/player
  // and media requests continue through native fetch to preserve client UAs,
  // range behavior, and PO-token network binding.
  try {
    const parsedUrl = new URL(url);
    const browserSafePlayerAsset =
      method === 'GET' &&
      parsedUrl.hostname === 'www.youtube.com' &&
      (parsedUrl.pathname === '/iframe_api' || parsedUrl.pathname.startsWith('/s/player/'));
    if (browserSafePlayerAsset) {
      return await browserFetch(url, { method: 'GET', credentials: 'include' });
    }
  } catch {
    // Invalid/unsupported browser requests fall through to native validation.
  }

  const headers = new Headers(inputRequest?.headers);
  if (init.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  }

  let body: string | undefined;
  if (typeof init.body === 'string') {
    body = init.body;
  } else if (init.body instanceof URLSearchParams) {
    body = init.body.toString();
  } else if (init.body != null) {
    throw new Error('YouTube background runtime received an unsupported request body');
  }

  const response = await callNativeSourceHost<SourceRuntimeFetchResponse>('fetch', [
    {
      url,
      init: {
        method,
        headers: headersRecord(headers),
        body,
        cache: init.cache,
        credentials: init.credentials,
        redirect: init.redirect,
      },
    },
  ]);

  const responseHeaders = new Headers(response.headers);
  const readText = () =>
    callNativeSourceHost<string>('fetchText', [{ responseId: response.responseId }]);
  const responseLike = {
    ok: response.status >= 200 && response.status < 300,
    redirected: false,
    status: response.status,
    statusText: response.statusText,
    type: 'default',
    url: response.url || url,
    headers: responseHeaders,
    body: {
      cancel: () =>
        callNativeSourceHost<void>('fetchCancel', [{ responseId: response.responseId }]),
    },
    bodyUsed: false,
    text: readText,
    json: async () => JSON.parse(await readText()),
    arrayBuffer: async () =>
      decodeBase64(
        await callNativeSourceHost<string>('fetchArrayBuffer', [
          { responseId: response.responseId },
        ])
      ),
  };
  return responseLike as unknown as Response;
}

class SourceMemoryStorage {
  private static stores = new Map<string, Map<string, Uint8Array>>();
  private readonly store: Map<string, Uint8Array>;

  constructor({ id }: { id: string }) {
    let store = SourceMemoryStorage.stores.get(id);
    if (!store) {
      store = new Map<string, Uint8Array>();
      SourceMemoryStorage.stores.set(id, store);
    }
    this.store = store;
  }

  getBuffer(key: string): Uint8Array | undefined {
    return this.store.get(key);
  }

  set(key: string, value: Uint8Array): void {
    this.store.set(key, value);
  }

  delete(key: string): void {
    this.store.delete(key);
  }
}

function createSourceHost(platform: 'ios' | 'android') {
  return {
    platform,
    fetch: sourceFetch,
    writeCacheFile(filename: string, content: string): string {
      const url = `minip-youtube-cache://${Date.now()}-${++sourceCacheFileSequence}`;
      sourceCacheFiles.set(url, { url, filename, content });
      return url;
    },
    youtube: {
      evaluatePlayerScript: async ({ output }: { output: string }) =>
        Promise.resolve(new Function(output)()),
      generatePoToken: (request: PoTokenRequest) =>
        callNativeSourceHost('generatePoToken', [request]),
    },
    log(...args: unknown[]): void {
      postMessage({
        type: 'youtube-source-log',
        args: args.map((value) => (value instanceof Error ? value.message : value)),
      });
    },
  };
}

function collectResultCacheFiles(value: unknown, found: Set<string>): void {
  if (typeof value === 'string') {
    if (sourceCacheFiles.has(value)) found.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectResultCacheFiles(item, found);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const item of Object.values(value)) collectResultCacheFiles(item, found);
}

function takeResultCacheFiles(result: unknown): SourceRuntimeCacheFile[] {
  const found = new Set<string>();
  collectResultCacheFiles(result, found);
  const files: SourceRuntimeCacheFile[] = [];
  for (const url of found) {
    const file = sourceCacheFiles.get(url);
    if (file) files.push(file);
    sourceCacheFiles.delete(url);
  }
  return files;
}

async function initializeYouTubeSource(request: SourceRuntimeRequest): Promise<unknown> {
  if (!request.runtimeId || !request.code || request.code.length > 5_000_000 || !request.platform) {
    throw new Error('Invalid YouTube source initialization request');
  }

  const existingSource = youtubeSources.get(request.runtimeId);
  if (existingSource) {
    await existingSource.dispose().catch(() => undefined);
    youtubeSources.delete(request.runtimeId);
  }

  // youtubei.js/react-native captures these globals while the bundle is being
  // evaluated. Point it at the native bridge before parsing the large bundle.
  globalThis.fetch = sourceFetch;
  (globalThis as unknown as { mmkvStorage: typeof SourceMemoryStorage }).mmkvStorage =
    SourceMemoryStorage;

  const moduleObject: { exports: unknown } = { exports: {} };
  const factory = new Function(
    'module',
    'exports',
    'host',
    'global',
    'self',
    'globalThis',
    `${request.code}\n;
if (typeof module.exports === 'function') {
  return module.exports(host);
} else if (module.exports && typeof module.exports.default === 'function') {
  return module.exports.default(host);
} else {
  return module.exports;
}`
  );
  const host = createSourceHost(request.platform);
  const candidate = factory.call(
    globalThis,
    moduleObject,
    moduleObject.exports,
    host,
    globalThis,
    globalThis,
    globalThis
  ) as RuntimeMediaSource;
  if (!candidate || typeof candidate !== 'object') {
    throw new Error('YouTube bundle did not export a source object');
  }

  try {
    await candidate.initialize();
    youtubeSources.set(request.runtimeId, candidate);
  } catch (error) {
    await candidate.dispose().catch(() => undefined);
    throw error;
  }
  return {
    id: candidate.id,
    name: candidate.name,
    version: candidate.version,
    methods: Object.keys(candidate).filter(
      (key) => typeof (candidate as Record<string, unknown>)[key] === 'function'
    ),
  };
}

async function runYouTubeSourceOperation(request: SourceRuntimeRequest): Promise<unknown> {
  if (!request.requestId || !request.runtimeId) {
    throw new Error('Invalid YouTube source request');
  }
  if (request.operation === 'initialize') return initializeYouTubeSource(request);

  const youtubeSource = youtubeSources.get(request.runtimeId);
  if (!youtubeSource) throw new Error('YouTube source is not initialized');
  if (request.operation === 'dispose') {
    try {
      await youtubeSource.dispose();
    } finally {
      youtubeSources.delete(request.runtimeId);
    }
    return null;
  }

  if (!request.method || !/^[A-Za-z_$][\w$]*$/.test(request.method)) {
    throw new Error('Invalid YouTube source method');
  }
  const method = youtubeSource[request.method];
  if (typeof method !== 'function') {
    throw new Error(`YouTube source does not implement "${request.method}"`);
  }
  return method.apply(youtubeSource, request.args ?? []);
}

window.__MINIP_RESOLVE_YOUTUBE_SOURCE_HOST_CALL__ = (response) => {
  const pending = pendingSourceHostCalls.get(response.hostRequestId);
  if (!pending) return;
  pendingSourceHostCalls.delete(response.hostRequestId);
  if (response.error) pending.reject(new Error(response.error));
  else pending.resolve(response.result);
};

window.__MINIP_RUN_YOUTUBE_SOURCE_OPERATION__ = async (request) => {
  try {
    const result = await runYouTubeSourceOperation(request);
    postMessage({
      type: 'youtube-source-result',
      requestId: request.requestId,
      result,
      cacheFiles: takeResultCacheFiles(result),
    });
  } catch (error) {
    postMessage({
      type: 'youtube-source-error',
      requestId: request.requestId,
      error: errorMessage(error),
    });
  }
};

function validateRequest(request: PoTokenRequest): URL {
  if (!request.requestId || !request.program || !request.globalName) {
    throw new Error('Incomplete YouTube attestation challenge');
  }
  if (!/^[A-Za-z_$][\w$]*$/.test(request.globalName)) {
    throw new Error('Invalid BotGuard global name');
  }
  if (
    !Array.isArray(request.contentBindings) ||
    request.contentBindings.length === 0 ||
    request.contentBindings.some((binding) => !/^[A-Za-z0-9_-]{1,128}$/.test(binding))
  ) {
    throw new Error('Invalid YouTube token content binding');
  }

  const interpreterUrl = new URL(request.interpreterUrl, 'https://www.google.com');
  const trustedGoogleHost =
    interpreterUrl.hostname === 'google.com' || interpreterUrl.hostname.endsWith('.google.com');
  if (
    interpreterUrl.protocol !== 'https:' ||
    !trustedGoogleHost ||
    !interpreterUrl.pathname.startsWith('/js/th/')
  ) {
    throw new Error('Untrusted BotGuard interpreter URL');
  }
  return interpreterUrl;
}

async function loadInterpreter(url: URL, requestId: string): Promise<HTMLScriptElement> {
  const script = document.createElement('script');
  script.async = true;
  script.id = `minip-botguard-${requestId}`;
  script.src = url.toString();

  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(
      () => reject(new Error('BotGuard interpreter timed out')),
      10_000
    );
    script.onload = () => {
      window.clearTimeout(timeout);
      resolve();
    };
    script.onerror = () => {
      window.clearTimeout(timeout);
      reject(new Error('Could not load the BotGuard interpreter'));
    };
    document.head.appendChild(script);
  });
  return script;
}

window.__MINIP_EVALUATE_YOUTUBE_PLAYER__ = async (request) => {
  try {
    if (!request.requestId || !request.output || request.output.length > 1_000_000) {
      throw new Error('Invalid YouTube player evaluation request');
    }
    const result = await Promise.resolve(new Function(request.output)());
    postMessage({
      type: 'youtube-player-result',
      requestId: request.requestId,
      result,
    });
  } catch (error) {
    postMessage({
      type: 'youtube-browser-error',
      requestId: request.requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

window.__MINIP_GENERATE_YOUTUBE_PO_TOKEN__ = async (request) => {
  let botGuardClient: BotGuardClient | null = null;
  let interpreterScript: HTMLScriptElement | null = null;

  try {
    const interpreterUrl = validateRequest(request);
    interpreterScript = await loadInterpreter(interpreterUrl, request.requestId);

    botGuardClient = await BotGuardClient.create({
      program: request.program,
      globalName: request.globalName,
      globalObject: window,
    });
    botGuardClient.defaultTimeout = 10_000;

    const webPoSignalOutput: WebPoSignalOutput = [];
    const botguardResponse = await botGuardClient.snapshot(
      { webPoSignalOutput },
      botGuardClient.defaultTimeout
    );
    pendingMints.set(request.requestId, {
      request,
      botGuardClient,
      interpreterScript,
      webPoSignalOutput,
    });
    botGuardClient = null;
    interpreterScript = null;
    postMessage({
      type: 'youtube-po-snapshot',
      requestId: request.requestId,
      botguardResponse,
    });
  } catch (error) {
    postMessage({
      type: 'youtube-po-error',
      requestId: request.requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (botGuardClient) {
      void botGuardClient.shutdown().catch(() => undefined);
    }
    interpreterScript?.remove();
  }
};

window.__MINIP_COMPLETE_YOUTUBE_PO_TOKEN__ = async (response) => {
  const pending = pendingMints.get(response.requestId);
  if (!pending) return;
  pendingMints.delete(response.requestId);

  try {
    const minter = await WebPoMinter.create(
      {
        integrityToken: response.integrityToken,
        estimatedTtlSecs: response.estimatedTtlSecs,
        mintRefreshThreshold: response.mintRefreshThreshold,
        websafeFallbackToken: response.websafeFallbackToken,
      },
      pending.webPoSignalOutput
    );

    const tokens: Record<string, string> = {};
    for (const binding of pending.request.contentBindings) {
      tokens[binding] = await minter.mintAsWebsafeString(binding);
    }

    postMessage({
      type: 'youtube-po-result',
      requestId: response.requestId,
      tokens,
      expiresAt:
        Date.now() + Math.max(60_000, response.estimatedTtlSecs * 1000 - TOKEN_EXPIRY_SAFETY_MS),
    });
  } catch (error) {
    postMessage({
      type: 'youtube-po-error',
      requestId: response.requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    void pending.botGuardClient.shutdown().catch(() => undefined);
    pending.interpreterScript.remove();
  }
};

postMessage({ type: 'youtube-po-ready' });
