/**
 * Session management for YouTube InnerTube API
 * Migrated from Session.kt
 */

import type { HttpAdapter } from './http.js';
import type {
  SessionOptions,
  SessionArgs,
  DeviceInfo,
  InnertubeConfigResult,
} from './types.js';
import { URLS, CLIENTS } from './constants.js';
import { generateRandomString } from './utils.js';
import { buildInnertubeContext, type InnertubeContext } from './context.js';
import { getStringBetweenStrings } from './utils.js';
import { DeviceCategory, getRandomUserAgent } from './user-agents.js';

// ==================== Types ====================

export interface SessionData {
  apiKey: string;
  apiVersion: string;
  configData: string;
  context: InnertubeContext;
  userAgent: string;
  accountIndex: number;
}

/**
 * Serializable session snapshot that can be persisted externally
 * (e.g., AsyncStorage, localStorage, SQLite, file system).
 *
 * Allows the application to skip the cold-start overhead (~1s) on subsequent launches.
 */
export interface SessionSnapshot {
  /** API key from sw.js_data */
  apiKey: string;
  /** API version (e.g., "v1") */
  apiVersion: string;
  /** InnerTube context object */
  context: InnertubeContext;
  /** User-Agent used for this session */
  userAgent: string;
  /** Player version ID (e.g., "2f1b3c4d") */
  playerId?: string;
  /** Signature timestamp from player JS (e.g., "20073") — changes every few days */
  signatureTimestamp?: string;
  /** InnerTube config data */
  configData?: string;
  /** When this snapshot was created (ISO string) */
  createdAt: string;
}

/**
 * External cache adapter.
 * Implement this to persist session data across app launches.
 *
 * @example
 * ```typescript
 * // React Native example
 * const cache: SessionCacheAdapter = {
 *   async get() {
 *     const json = await AsyncStorage.getItem('ytbapi_session');
 *     return json ? JSON.parse(json) : null;
 *   },
 *   async set(snapshot) {
 *     await AsyncStorage.setItem('ytbapi_session', JSON.stringify(snapshot));
 *   },
 *   async clear() {
 *     await AsyncStorage.removeItem('ytbapi_session');
 *   },
 * };
 *
 * const yt = new InnertubeService({ sessionCache: cache });
 * ```
 */
export interface SessionCacheAdapter {
  /** Retrieve a previously stored session snapshot, or null if none exists. */
  get(): Promise<SessionSnapshot | null> | SessionSnapshot | null;
  /** Store a session snapshot for future reuse. */
  set(snapshot: SessionSnapshot): Promise<void> | void;
  /** Clear the stored session snapshot. */
  clear(): Promise<void> | void;
}

// ==================== Session ====================

export class Session {
  readonly context: InnertubeContext;
  readonly apiKey: string;
  readonly apiVersion: string;
  readonly accountIndex: number;
  readonly configData: string | undefined;
  readonly userAgent: string;
  readonly cookie: string | undefined;
  readonly poToken: string | undefined;
  readonly signatureTimestamp: string | undefined;
  readonly playerId: string | undefined;
  readonly playerUrl: string | undefined;

  private static cached: { playerId?: string; session: Session } | null = null;

  private constructor(params: {
    context: InnertubeContext;
    apiKey: string;
    apiVersion: string;
    accountIndex: number;
    configData?: string;
    userAgent: string;
    cookie?: string;
    poToken?: string;
    signatureTimestamp?: string;
    playerId?: string;
    playerUrl?: string;
  }) {
    this.context = params.context;
    this.apiKey = params.apiKey;
    this.apiVersion = params.apiVersion;
    this.accountIndex = params.accountIndex;
    this.configData = params.configData;
    this.userAgent = params.userAgent;
    this.cookie = params.cookie;
    this.poToken = params.poToken;
    this.signatureTimestamp = params.signatureTimestamp;
    this.playerId = params.playerId;
    this.playerUrl = params.playerUrl;
  }

  // ==================== Factory ====================

  /**
   * Create or return a cached session.
   *
   * Resolution order:
   * 1. In-memory cache (fastest — same process)
   * 2. External cache adapter (fast — skips network)
   * 3. Fresh session (slow — 3–4 network requests)
   */
  static async create(
    http: HttpAdapter,
    options?: SessionOptions,
  ): Promise<Session | null> {
    // 1. In-memory cache
    if (
      Session.cached &&
      Session.cached.playerId === options?.playerId
    ) {
      return Session.cached.session;
    }

    // 2. External cache adapter
    const cacheAdapter = options?.sessionCache;
    if (cacheAdapter) {
      const snapshot = await cacheAdapter.get();
      if (snapshot && Session.isSnapshotValid(snapshot, options?.maxSessionAge)) {
        const session = Session.fromSnapshot(snapshot, options);
        Session.cached = { playerId: options?.playerId, session };
        return session;
      }
    }

    // 3. Build fresh session
    const session = await Session.buildFreshSession(http, options);
    if (!session) return null;

    Session.cached = { playerId: options?.playerId, session };

    // Persist to external cache
    if (cacheAdapter) {
      try {
        await cacheAdapter.set(session.toSnapshot());
      } catch {
        // Ignore cache write errors
      }
    }

    return session;
  }

  /**
   * Export the current session as a serializable snapshot.
   * Use this to manually persist session data.
   */
  toSnapshot(): SessionSnapshot {
    return {
      apiKey: this.apiKey,
      apiVersion: this.apiVersion,
      context: this.context,
      userAgent: this.userAgent,
      playerId: this.playerId,
      signatureTimestamp: this.signatureTimestamp,
      configData: this.configData,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Create a Session directly from a snapshot (no network calls).
   */
  static fromSnapshot(snapshot: SessionSnapshot, options?: SessionOptions): Session {
    return new Session({
      context: snapshot.context,
      apiKey: snapshot.apiKey,
      apiVersion: snapshot.apiVersion,
      accountIndex: options?.accountIndex ?? 0,
      configData: snapshot.configData,
      userAgent: snapshot.userAgent,
      cookie: options?.cookie,
      poToken: options?.poToken,
      signatureTimestamp: snapshot.signatureTimestamp,
      playerId: snapshot.playerId,
      playerUrl: snapshot.playerId ? Session.getPlayerUrl(snapshot.playerId) : undefined,
    });
  }

  static invalidate(): void {
    Session.cached = null;
  }

  /**
   * Invalidate and also clear external cache.
   */
  static async invalidateAll(cacheAdapter?: SessionCacheAdapter): Promise<void> {
    Session.cached = null;
    if (cacheAdapter) {
      try { await cacheAdapter.clear(); } catch { /* ignore */ }
    }
  }

  // ==================== Fresh Session Builder ====================

  private static async buildFreshSession(
    http: HttpAdapter,
    options?: SessionOptions,
  ): Promise<Session | null> {
    const args: SessionArgs = {
      clientName: 'WEB',
      userAgent:
        options?.userAgent ??
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      deviceCategory: 'desktop',
      timeZone: 'Europe/Kiev',
      enableSafetyMode: false,
      lang: options?.lang,
      location: options?.location,
    };

    // Step 1: Fetch sw.js_data (required)
    const sessionDataResult = await Session.fetchSessionDataResult(http, args);
    if (!sessionDataResult) return null;

    const deviceInfo = sessionDataResult.deviceInfo;
    const apiKey = sessionDataResult.apiKey;
    if (!deviceInfo || !apiKey) return null;

    // Build context
    const context = buildInnertubeContext(args, deviceInfo);

    // Step 2 & 3: Fetch config + player in PARALLEL
    const [configResult, playerInfo] = await Promise.all([
      options?.retrieveInnertubeConfig !== false
        ? Session.fetchInnertubeConfig(http, sessionDataResult, context)
        : Promise.resolve(null),
      options?.skipPlayerFetch
        ? Promise.resolve({ playerId: undefined, signatureTimestamp: undefined })
        : Session.fetchPlayerInfo(http, options?.playerId),
    ]);

    // Apply config data
    let configData: string | undefined;
    if (configResult) {
      configData = configResult.configData ?? undefined;

      const coldConfigData =
        configResult.responseContext?.globalConfigGroup?.rawColdConfigGroup?.configData;
      const coldHashData =
        configResult.responseContext?.globalConfigGroup?.coldHashData;
      const hotHashData =
        configResult.responseContext?.globalConfigGroup?.hotHashData;

      if (context.client.configInfo && coldConfigData && coldHashData && hotHashData) {
        context.client.configInfo.coldConfigData = coldConfigData;
        context.client.configInfo.coldHashData = coldHashData;
        context.client.configInfo.hotHashData = hotHashData;
      }
    }

    return new Session({
      context,
      apiKey,
      apiVersion: CLIENTS.WEB.API_VERSION,
      accountIndex: options?.accountIndex ?? 0,
      configData,
      userAgent: args.userAgent,
      cookie: options?.cookie,
      poToken: options?.poToken,
      signatureTimestamp: playerInfo.signatureTimestamp,
      playerId: playerInfo.playerId,
      playerUrl: playerInfo.playerId ? Session.getPlayerUrl(playerInfo.playerId) : undefined,
    });
  }

  /**
   * Fetches playerId + signatureTimestamp in 2 sequential calls.
   * This is the slowest part (~500-700ms) because the player JS is ~1MB.
   */
  private static async fetchPlayerInfo(
    http: HttpAdapter,
    existingPlayerId?: string,
  ): Promise<{ playerId?: string; signatureTimestamp?: string }> {
    const playerId = existingPlayerId ?? (await Session.getPlayerId(http));
    if (!playerId) return {};

    const playerUrl = Session.getPlayerUrl(playerId);
    let signatureTimestamp: string | undefined;

    try {
      const resp = await http.request(playerUrl, {
        method: 'GET',
        headers: { 'User-Agent': getRandomUserAgent(DeviceCategory.DESKTOP) },
      });
      const playerJs = await resp.text();
      signatureTimestamp =
        getStringBetweenStrings(playerJs, 'signatureTimestamp:', ',') ??
        getStringBetweenStrings(playerJs, 'sts:', ',') ??
        undefined;
    } catch {
      // ignore
    }

    return { playerId, signatureTimestamp };
  }

  // ==================== Validation ====================

  /**
   * Check if a snapshot is still valid.
   * @param maxAge Maximum age in milliseconds (default: 6 hours)
   */
  private static isSnapshotValid(snapshot: SessionSnapshot, maxAge?: number): boolean {
    if (!snapshot.apiKey || !snapshot.context) return false;

    const age = Date.now() - new Date(snapshot.createdAt).getTime();
    const maxAgeMs = maxAge ?? 6 * 60 * 60 * 1000; // default 6 hours
    return age < maxAgeMs;
  }

  // ==================== Session data fetching ====================

  /**
   * Parses the sw.js_data response.
   * The response is a JSPB (JavaScript Protocol Buffers) array, not standard JSON.
   */
  private static async fetchSessionDataResult(
    http: HttpAdapter,
    args: SessionArgs,
  ): Promise<{ apiKey?: string; deviceInfo?: DeviceInfo } | null> {
    const lang = args.lang ?? 'en-US';
    const visitorId = generateRandomString(11);

    const headers: Record<string, string> = {
      'Accept-Language': lang,
      'User-Agent': args.userAgent,
      Accept: '*/*',
      Referer: `${URLS.YT_BASE}/sw.js`,
      Cookie: `PREF=tz=${args.timeZone.replace(/\//g, '.')};VISITOR_INFO1_LIVE=${visitorId};`,
    };

    try {
      const resp = await http.request(`${URLS.YT_BASE}/sw.js_data`, {
        method: 'GET',
        headers,
      });
      const text = await resp.text();

      // The response starts with ")]}\'\n" then JSON
      const jsonStr = text.replace(/^\)\]\}'\n?/, '');
      const raw = JSON.parse(jsonStr);

      // Extract from the JSPB structure
      const ytcfg = raw?.[0]?.[2];
      if (!ytcfg) return null;

      const apiKey = ytcfg?.[1] as string | undefined;
      const deviceInfoArr = ytcfg?.[0]?.[0] as any[] | undefined;

      let deviceInfo: DeviceInfo | undefined;
      if (deviceInfoArr) {
        deviceInfo = {
          hl: deviceInfoArr[0] ?? undefined,
          gl: deviceInfoArr[1] ?? undefined,
          remoteHost: deviceInfoArr[3] ?? undefined,
          deviceMake: deviceInfoArr[11] ?? undefined,
          deviceModel: deviceInfoArr[12] ?? undefined,
          visitorData: deviceInfoArr[13] ?? undefined,
          clientVersion: deviceInfoArr[16] ?? undefined,
          osName: deviceInfoArr[17] ?? undefined,
          osVersion: deviceInfoArr[18] ?? undefined,
          appInstallData: deviceInfoArr[61]
            ? (Array.isArray(deviceInfoArr[61])
              ? deviceInfoArr[61][deviceInfoArr[61].length - 1]
              : deviceInfoArr[61])
            : undefined,
          timeZone: deviceInfoArr[79] ?? undefined,
          browserName: deviceInfoArr[86] ?? undefined,
          browserVersion: deviceInfoArr[87] ?? undefined,
          deviceExperimentId: deviceInfoArr[103] ?? undefined,
          rolloutToken: deviceInfoArr[107] ?? undefined,
        };
      }

      return { apiKey, deviceInfo };
    } catch (e) {
      console.error('[ytbapi] Failed to fetch session data:', e);
      return null;
    }
  }

  private static async fetchInnertubeConfig(
    http: HttpAdapter,
    sessionData: { apiKey?: string; deviceInfo?: DeviceInfo },
    context: InnertubeContext,
  ): Promise<InnertubeConfigResult | null> {
    const headers: Record<string, string> = {
      'Accept-Language': '',
      Accept: '*/*',
      Referer: URLS.YT_BASE,
      'X-Origin': URLS.YT_BASE,
      'Content-Type': 'application/json',
    };

    if (sessionData.deviceInfo?.visitorData) {
      headers['X-Goog-Visitor-Id'] = sessionData.deviceInfo.visitorData;
    }
    if (sessionData.deviceInfo?.clientVersion) {
      headers['X-Youtube-Client-Version'] = sessionData.deviceInfo.clientVersion;
    }

    const body = JSON.stringify({ context });

    try {
      const resp = await http.request(
        `${URLS.API.PRODUCTION_1}v1/config`,
        { method: 'POST', headers, body },
      );
      return (await resp.json()) as InnertubeConfigResult;
    } catch {
      return null;
    }
  }

  // ==================== Player ID ====================

  static async getPlayerId(http: HttpAdapter): Promise<string | undefined> {
    try {
      const resp = await http.request(`${URLS.YT_BASE}/iframe_api`, {
        method: 'GET',
        headers: {},
      });
      const text = await resp.text();
      return getStringBetweenStrings(text, 'player\\/', '\\/') ?? undefined;
    } catch {
      return undefined;
    }
  }

  static getPlayerUrl(playerId: string): string {
    return `${URLS.YT_BASE}/s/player/${playerId}/player_ias.vflset/en_US/base.js`;
  }
}
