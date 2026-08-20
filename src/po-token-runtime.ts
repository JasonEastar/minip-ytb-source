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
    __MINIP_COMPLETE_YOUTUBE_PO_TOKEN__: (
      response: PoTokenIntegrityResponse
    ) => Promise<void>;
    __MINIP_EVALUATE_YOUTUBE_PLAYER__: (request: {
      requestId: string;
      output: string;
    }) => Promise<void>;
  }
}

const pendingMints = new Map<string, PendingMint>();

function postMessage(message: Record<string, unknown>): void {
  window.ReactNativeWebView?.postMessage(JSON.stringify(message));
}

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
        Date.now() +
        Math.max(60_000, response.estimatedTtlSecs * 1000 - TOKEN_EXPIRY_SAFETY_MS),
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
