import { BotGuardClient } from 'bgutils-js/botguard';
import type { WebPoSignalOutput } from 'bgutils-js/shared-types';
import { buildURL, getHeaders } from 'bgutils-js/utils';
import { WebPoMinter } from 'bgutils-js/webpo';

const REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo';
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

declare global {
  interface Window {
    ReactNativeWebView?: NativeBridge;
    __MINIP_GENERATE_YOUTUBE_PO_TOKEN__: (request: PoTokenRequest) => Promise<void>;
  }
}

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
    const response = await fetch(buildURL('GenerateIT', true), {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify([REQUEST_KEY, botguardResponse]),
    });
    if (!response.ok) {
      throw new Error(`YouTube integrity service returned HTTP ${response.status}`);
    }

    const [integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken] =
      (await response.json()) as [string, number, number, string];
    const minter = await WebPoMinter.create(
      {
        integrityToken,
        estimatedTtlSecs,
        mintRefreshThreshold,
        websafeFallbackToken,
      },
      webPoSignalOutput
    );

    const tokens: Record<string, string> = {};
    for (const binding of request.contentBindings) {
      tokens[binding] = await minter.mintAsWebsafeString(binding);
    }

    postMessage({
      type: 'youtube-po-result',
      requestId: request.requestId,
      tokens,
      expiresAt: Date.now() + Math.max(60_000, estimatedTtlSecs * 1000 - TOKEN_EXPIRY_SAFETY_MS),
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

postMessage({ type: 'youtube-po-ready' });
