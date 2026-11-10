/**
 * HTTP Client for YouTube InnerTube API
 * Migrated from HTTPClient.kt
 */

import type { HttpAdapter } from './http.js';
import type { PlayerResult } from './types.js';
import { URLS, CLIENTS, CLIENT_NAME_IDS, SUPPORTED_CLIENTS } from './constants.js';
import { UrlQueryString } from './utils.js';
import { Session } from './session.js';
import type { InnertubeContext } from './context.js';

export interface RequestInit {
  baseURL?: string;
  headers?: Record<string, string>;
  body: RequestBody;
}

export interface RequestBody {
  videoId: string;
  client?: string;
  contentCheckOk: boolean;
  racyCheckOk: boolean;
  playbackContext: {
    // Mobile clients (IOS) return direct URLs and need no signatureTimestamp.
    contentPlaybackContext: Record<string, never>;
  };
  context?: InnertubeContext;
}

/**
 * Creates a request body for a player request.
 */
export function createRequestBody(videoId: string, client?: string): RequestBody {
  return {
    videoId,
    client,
    contentCheckOk: true,
    racyCheckOk: true,
    playbackContext: {
      contentPlaybackContext: {},
    },
  };
}

/**
 * InnerTube HTTP Client – makes authenticated requests to the YouTube API.
 */
export class HTTPClient {
  constructor(
    private readonly session: Session,
    private readonly http: HttpAdapter,
  ) { }

  async fetch(input: string, init: RequestInit): Promise<PlayerResult | null> {
    const innertubeUrl = URLS.API.PRODUCTION_1 + this.session.apiVersion;
    const baseURL = innertubeUrl;

    const separator =
      baseURL.endsWith('/') || input.startsWith('/') ? '' : '/';
    const url = `${baseURL}${separator}${input}`;

    const requestHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    };

    // Build URL with query params
    const requestUrl = new UrlQueryString(url);
    requestUrl.set('prettyPrint', 'false');
    requestUrl.set('alt', 'json');

    // Setup common headers
    this.setupCommonHeaders(requestHeaders, url);

    // Process JSON payload
    const contentType = requestHeaders['Content-Type'];
    let requestBody: string | undefined;

    if (contentType === 'application/json') {
      const result = this.processJsonPayload(init.body);
      requestBody = result.body;

      if (result.clientVersion) {
        requestHeaders['X-Youtube-Client-Version'] = result.clientVersion;
      }
      if (result.clientNameId) {
        requestHeaders['X-Youtube-Client-Name'] = result.clientNameId;
      }

      // Adjust User-Agent for specific clients
      const cn = result.adjustedClientName;
      if (cn === CLIENTS.ANDROID.NAME || cn === CLIENTS.YTMUSIC_ANDROID.NAME) {
        if (CLIENTS.ANDROID.USER_AGENT) {
          requestHeaders['User-Agent'] = CLIENTS.ANDROID.USER_AGENT;
        }
        requestHeaders['X-GOOG-API-FORMAT-VERSION'] = '2';
      } else if (cn === CLIENTS.IOS.NAME) {
        if (CLIENTS.IOS.USER_AGENT) {
          requestHeaders['User-Agent'] = CLIENTS.IOS.USER_AGENT;
        }
      }
    }

    if (!requestBody) return null;

    try {
      const resp = await this.http.request(requestUrl.toString(), {
        method: 'POST',
        headers: requestHeaders,
        body: requestBody,
      });
      return (await resp.json()) as PlayerResult;
    } catch (e) {
      console.error('[ytbapi] HTTPClient.fetch error:', e);
      return null;
    }
  }

  private setupCommonHeaders(
    headers: Record<string, string>,
    requestUrl: string,
  ): void {
    headers['Accept'] = '*/*';
    headers['Accept-Language'] = '*';

    headers['X-Goog-Visitor-Id'] =
      this.session.context.client.visitorData ?? '';

    headers['X-Youtube-Client-Version'] =
      this.session.context.client.clientVersion ?? '';

    const clientNameId =
      CLIENT_NAME_IDS[this.session.context.client.clientName];
    if (clientNameId) {
      headers['X-Youtube-Client-Name'] = clientNameId;
    }

    headers['User-Agent'] = this.session.userAgent;

    // Add cookie for authenticated requests
    if (this.session.cookie) {
      headers['Cookie'] = this.session.cookie;
    }

    // Extract origin from URL
    try {
      const match = requestUrl.match(/^(https?:\/\/[^/]+)/);
      if (match) {
        headers['Origin'] = match[1];
      }
    } catch {
      headers['Origin'] = URLS.YT_BASE;
    }
  }

  private processJsonPayload(body: RequestBody): {
    body: string;
    isWebKids: boolean;
    clientVersion?: string;
    clientNameId?: string;
    adjustedClientName?: string;
  } {
    // Deep clone the context
    const adjustedContext: InnertubeContext = JSON.parse(
      JSON.stringify(this.session.context),
    );

    // Adjust context based on requested client
    this.adjustContext(adjustedContext, body.client);

    // Merge context into body
    const payload: any = { ...body, context: adjustedContext };
    delete payload.client; // Remove the client field from the payload

    const clientVersion = adjustedContext.client.clientVersion;
    const clientName = adjustedContext.client.clientName;
    const clientNameId = CLIENT_NAME_IDS[clientName] ?? undefined;
    const isWebKids = clientName === CLIENTS.WEB_KIDS.NAME;

    return {
      body: JSON.stringify(payload),
      isWebKids,
      clientVersion,
      clientNameId,
      adjustedClientName: clientName,
    };
  }

  private adjustContext(ctx: InnertubeContext, client?: string): void {
    if (!client) return;

    const clientName = client.toUpperCase();

    if (!SUPPORTED_CLIENTS.includes(clientName)) {
      throw new Error(`Invalid client: ${client}`);
    }

    if (clientName !== 'WEB') {
      ctx.client.configInfo = undefined;
    }

    // Android-family clients
    if (
      clientName === 'ANDROID' ||
      clientName === 'YTMUSIC_ANDROID' ||
      clientName === 'YTSTUDIO_ANDROID'
    ) {
      ctx.client.androidSdkVersion = CLIENTS.ANDROID.SDK_VERSION;
      ctx.client.userAgent = CLIENTS.ANDROID.USER_AGENT;
      ctx.client.osName = 'Android';
      ctx.client.osVersion = '13';
      ctx.client.platform = 'MOBILE';
    }

    switch (clientName) {
      case 'MWEB':
        ctx.client.clientVersion = CLIENTS.MWEB.VERSION;
        ctx.client.clientName = CLIENTS.MWEB.NAME;
        ctx.client.clientFormFactor = 'SMALL_FORM_FACTOR';
        ctx.client.platform = 'MOBILE';
        break;
      case 'IOS':
        ctx.client.deviceMake = 'Apple';
        ctx.client.deviceModel = CLIENTS.IOS.DEVICE_MODEL;
        ctx.client.clientVersion = CLIENTS.IOS.VERSION;
        ctx.client.clientName = CLIENTS.IOS.NAME;
        ctx.client.platform = 'MOBILE';
        ctx.client.osName = CLIENTS.IOS.OS_NAME;
        ctx.client.osVersion = CLIENTS.IOS.OS_VERSION;
        ctx.client.browserName = undefined;
        ctx.client.browserVersion = undefined;
        break;
      case 'YTMUSIC':
        ctx.client.clientVersion = CLIENTS.YTMUSIC.VERSION;
        ctx.client.clientName = CLIENTS.YTMUSIC.NAME;
        break;
      case 'ANDROID':
        ctx.client.clientVersion = CLIENTS.ANDROID.VERSION;
        ctx.client.clientFormFactor = 'SMALL_FORM_FACTOR';
        ctx.client.clientName = CLIENTS.ANDROID.NAME;
        break;
      case 'YTMUSIC_ANDROID':
        ctx.client.clientVersion = CLIENTS.YTMUSIC_ANDROID.VERSION;
        ctx.client.clientFormFactor = 'SMALL_FORM_FACTOR';
        ctx.client.clientName = CLIENTS.YTMUSIC_ANDROID.NAME;
        break;
      case 'YTSTUDIO_ANDROID':
        ctx.client.clientVersion = CLIENTS.YTSTUDIO_ANDROID.VERSION;
        ctx.client.clientFormFactor = 'SMALL_FORM_FACTOR';
        ctx.client.clientName = CLIENTS.YTSTUDIO_ANDROID.NAME;
        break;
      case 'TV':
        ctx.client.clientVersion = CLIENTS.TV.VERSION;
        ctx.client.clientName = CLIENTS.TV.NAME;
        ctx.client.userAgent = CLIENTS.TV.USER_AGENT;
        break;
      case 'TV_SIMPLY':
        ctx.client.clientVersion = CLIENTS.TV_SIMPLY.VERSION;
        break;
    }
  }
}
