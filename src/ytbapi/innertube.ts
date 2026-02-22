/**
 * InnerTube Service – Main entry point for the YouTube API
 * Migrated from InnertubeService.kt + BrowseService2.kt
 *
 * Works on both Node.js and React Native.
 */

import type { HttpAdapter } from './http.js';
import { FetchHttpAdapter } from './http.js';
import type { SessionOptions, MediaItemFormatInfo, PlayerResult } from './types.js';
import { Session } from './session.js';
import { HTTPClient, createRequestBody, type RequestInit } from './http-client.js';
import { buildFormatInfo } from './format-helpers.js';
import { BrowseService, SEARCH_FILTERS, SearchFilter, type SearchFilterOptions, type BrowseResponse, type SearchResponse, type SearchSuggestion } from './browse.js';
import { YouTubeMusicService, type MusicSearchResponse, type MusicBrowseResponse, type MusicItem } from './music.js';
import { buildDashManifest, buildDashManifestDataUri, type DashManifestOptions } from './dash.js';
import { loadPlayerFunctions, decipherFormat, type PlayerCache } from './decipher.js';
import type { StreamingFormat } from './types.js';

export interface InnertubeServiceOptions extends SessionOptions {
  /**
   * Custom HTTP adapter. By default uses the native `fetch` API.
   * Provide your own if you need custom networking (e.g., proxies, interceptors).
   */
  httpAdapter?: HttpAdapter;
  /**
   * Disable signature deciphering. Default: false.
   * When disabled, WEB client formats with signatureCipher won't have URLs.
   * iOS/Android clients don't need deciphering.
   */
  disableDecipher?: boolean;
}

export class InnertubeService {
  private http: HttpAdapter;
  private options: InnertubeServiceOptions;
  private _browse: BrowseService;
  private _music: YouTubeMusicService;

  constructor(options: InnertubeServiceOptions = {}) {
    this.http = options.httpAdapter ?? new FetchHttpAdapter();
    this.options = options;
    this._browse = new BrowseService(this.http, options);
    this._music = new YouTubeMusicService(this.http, options);
  }

  /** Access the browse/search service directly for advanced usage */
  get browse(): BrowseService {
    return this._browse;
  }

  /** Access YouTube Music service directly */
  get music(): YouTubeMusicService {
    return this._music;
  }

  // ==================== Player / Video Info ====================

  /**
   * Get video format info (streaming URLs, subtitles, metadata, etc.)
   *
   * When using the WEB client (default), formats may have ciphered URLs.
   * The library automatically deciphers them unless `disableDecipher` is set.
   *
   * For iOS/Android clients, URLs are returned directly (no deciphering needed).
   */
  async getVideoInfo(videoId: string, client?: string): Promise<MediaItemFormatInfo | null> {
    const session = await Session.create(this.http, this.options);
    if (!session) {
      console.error('[ytbapi] Failed to create session');
      return null;
    }

    const httpClient = new HTTPClient(session, this.http);

    const body = createRequestBody(videoId, session, client);
    const requestInit: RequestInit = { body };

    const playerResult = await httpClient.fetch('/player', requestInit);
    if (!playerResult) {
      console.error('[ytbapi] Failed to fetch player result');
      return null;
    }

    // Decipher if needed (WEB client returns ciphered URLs)
    if (!this.options.disableDecipher) {
      await this.decipherPlayerResult(playerResult, session, client);
    }

    const formatInfo = buildFormatInfo(playerResult);

    if (formatInfo.isUnplayable) {
      Session.invalidate();
    }

    return formatInfo;
  }

  /**
   * Decipher ciphered streaming format URLs in-place.
   */
  private async decipherPlayerResult(
    playerResult: PlayerResult,
    session: Session,
    client?: string,
  ): Promise<void> {
    // iOS/Android clients don't use ciphered URLs
    const cl = client?.toUpperCase();
    if (cl === 'IOS' || cl === 'ANDROID' || cl === 'ANDROID_VR') return;

    const sd = playerResult.streamingData;
    if (!sd) return;

    // Check if any format actually needs deciphering
    const allFormats = [...(sd.adaptiveFormats ?? []), ...(sd.formats ?? [])];
    const hasCiphered = allFormats.some(f => f.signatureCipher || f.cipher);
    const hasNParam = allFormats.some(f => f.url?.includes('&n='));

    if (!hasCiphered && !hasNParam) return;

    // Load player functions
    let playerCache: PlayerCache | undefined;
    try {
      // Get player ID and URL from session
      const playerId = session.playerId ?? (await Session.getPlayerId(this.http));
      if (!playerId) {
        console.warn('[ytbapi] Cannot decipher: no player ID');
        return;
      }

      const playerUrl = Session.getPlayerUrl(playerId);
      playerCache = await loadPlayerFunctions(this.http, playerUrl, playerId);
    } catch (e) {
      console.error('[ytbapi] Failed to load player functions:', e);
      return;
    }

    // Decipher all formats
    if (sd.adaptiveFormats) {
      sd.adaptiveFormats = sd.adaptiveFormats.map(f => decipherFormat(f, playerCache!));
    }
    if (sd.formats) {
      sd.formats = sd.formats.map(f => decipherFormat(f, playerCache!));
    }
  }

  /**
   * Get raw player result (unprocessed response from YouTube).
   */
  async getRawPlayerResult(videoId: string, client?: string): Promise<PlayerResult | null> {
    const session = await Session.create(this.http, this.options);
    if (!session) return null;

    const httpClient = new HTTPClient(session, this.http);
    const body = createRequestBody(videoId, session, client);
    return httpClient.fetch('/player', { body });
  }

  // ==================== DASH ====================

  /**
   * Get a DASH MPD manifest XML for a video.
   *
   * @param videoId YouTube video ID
   * @param options Optional codec filtering and subtitle inclusion
   * @returns XML string of the MPD manifest, or null
   *
   * @example
   * ```typescript
   * const mpd = await yt.getDashManifest('dQw4w9WgXcQ');
   * // Feed to dash.js, shaka-player, ExoPlayer...
   * ```
   */
  async getDashManifest(videoId: string, options?: DashManifestOptions): Promise<string | null> {
    // IOS client provides direct URLs for adaptive formats (no deciphering needed).
    // WEB/WEB_REMIX now return SABR-only adaptive formats without individual URLs.
    const info = await this.getVideoInfo(videoId, 'IOS');
    if (!info) return null;
    return buildDashManifest(info, options);
  }

  /**
   * Get a DASH MPD manifest as a data URI (base64-encoded).
   * Can be loaded directly by media players.
   */
  async getDashManifestDataUri(videoId: string, options?: DashManifestOptions): Promise<string | null> {
    const info = await this.getVideoInfo(videoId, 'IOS');
    if (!info) return null;
    return buildDashManifestDataUri(info, options);
  }

  // ==================== Search ====================

  /**
   * Search YouTube (all types).
   *
   * @param query Search query string
   * @param filter Optional filter: a raw params string, or a SearchFilterOptions object
   *
   * @example
   * ```typescript
   * // No filter
   * await yt.search('lofi');
   *
   * // Filter by type
   * await yt.search('lofi', { type: 'video' });
   *
   * // Combine filters
   * await yt.search('lofi', { type: 'video', uploadDate: 'thisWeek', duration: 'long', sortBy: 'viewCount' });
   *
   * // Live 4K
   * await yt.search('gaming', { type: 'video', features: ['live', '4k'] });
   * ```
   */
  async search(query: string, filter?: string | SearchFilterOptions): Promise<SearchResponse | null> {
    return this._browse.search(query, filter);
  }

  /** Search for videos only */
  async searchVideos(query: string): Promise<SearchResponse | null> {
    return this._browse.search(query, SEARCH_FILTERS.TYPE_VIDEO);
  }

  /** Search for channels only */
  async searchChannels(query: string): Promise<SearchResponse | null> {
    return this._browse.search(query, SEARCH_FILTERS.TYPE_CHANNEL);
  }

  /** Search for playlists only */
  async searchPlaylists(query: string): Promise<SearchResponse | null> {
    return this._browse.search(query, SEARCH_FILTERS.TYPE_PLAYLIST);
  }

  /** Continue loading paginated search results */
  async continueSearch(continuationToken: string): Promise<SearchResponse | null> {
    return this._browse.continueSearch(continuationToken);
  }

  /** Get search autocomplete suggestions */
  async getSearchSuggestions(query: string, lang?: string, country?: string): Promise<SearchSuggestion[]> {
    return this._browse.getSearchSuggestions(query, lang, country);
  }

  // ==================== Browse - Channels ====================

  /** Get a channel's home/featured tab */
  async getChannelHome(channelId: string): Promise<BrowseResponse | null> {
    return this._browse.getChannelHome(channelId);
  }

  /** Get a channel's videos */
  async getChannelVideos(channelId: string): Promise<BrowseResponse | null> {
    return this._browse.getChannelVideos(channelId);
  }

  /** Get a channel's shorts */
  async getChannelShorts(channelId: string): Promise<BrowseResponse | null> {
    return this._browse.getChannelShorts(channelId);
  }

  /** Get a channel's live streams */
  async getChannelLive(channelId: string): Promise<BrowseResponse | null> {
    return this._browse.getChannelLive(channelId);
  }

  /** Get a channel's playlists */
  async getChannelPlaylists(channelId: string): Promise<BrowseResponse | null> {
    return this._browse.getChannelPlaylists(channelId);
  }

  /** Get a channel's releases/albums */
  async getChannelReleases(channelId: string): Promise<BrowseResponse | null> {
    return this._browse.getChannelReleases(channelId);
  }

  /** Get a channel's community posts */
  async getChannelCommunity(channelId: string): Promise<BrowseResponse | null> {
    return this._browse.getChannelCommunity(channelId);
  }

  // ==================== Browse - Playlists ====================

  /** Browse a playlist by playlist ID */
  async getPlaylist(playlistId: string): Promise<BrowseResponse | null> {
    return this._browse.getPlaylist(playlistId);
  }

  // ==================== Browse - Feeds ====================

  /** Get home/recommended feed */
  async getHome(): Promise<BrowseResponse | null> {
    return this._browse.getHome();
  }

  /** Get trending feed */
  async getTrending(): Promise<BrowseResponse | null> {
    return this._browse.getTrending();
  }

  /** Get subscriptions feed (requires auth/cookie) */
  async getSubscriptions(): Promise<BrowseResponse | null> {
    return this._browse.getSubscriptions();
  }

  /** Get watch history (requires auth/cookie) */
  async getHistory(): Promise<BrowseResponse | null> {
    return this._browse.getHistory();
  }

  /** Get liked videos (requires auth/cookie) */
  async getLikedVideos(): Promise<BrowseResponse | null> {
    return this._browse.getLikedVideos();
  }

  /** Get watch later playlist (requires auth/cookie) */
  async getWatchLater(): Promise<BrowseResponse | null> {
    return this._browse.getWatchLater();
  }

  // ==================== Browse - Generic ====================

  /** Generic browse by browseId with optional params */
  async browseById(browseId: string, params?: string): Promise<BrowseResponse | null> {
    return this._browse.browse(browseId, params);
  }

  /** Continue loading paginated results */
  async continueResults(continuationToken: string): Promise<BrowseResponse | null> {
    return this._browse.continueResults(continuationToken);
  }

  // ==================== Browse - Related / Next ====================

  /** Get related videos and video metadata via the /next endpoint */
  async getRelatedVideos(videoId: string, playlistId?: string): Promise<BrowseResponse | null> {
    return this._browse.getNext(videoId, playlistId);
  }

  // ==================== URL Resolution ====================

  /** Resolve a YouTube URL to its browse/watch endpoint data */
  async resolveUrl(url: string): Promise<{ browseId?: string; videoId?: string; playlistId?: string } | null> {
    return this._browse.resolveUrl(url);
  }

  // ==================== Session ====================

  /** Invalidate session cache */
  invalidateSession(): void {
    Session.invalidate();
  }

  /** Get the current session (creates one if needed) */
  async getSession(): Promise<Session | null> {
    return Session.create(this.http, this.options);
  }
}
