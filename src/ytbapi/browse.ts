/**
 * Browse & Search API for YouTube InnerTube
 * Migrated from BrowseApi.kt, BrowseApiHelper.kt, BrowseService2.kt, SearchApi.java
 *
 * Provides: channels, playlists, home feed, trending, search, subscriptions, etc.
 */

import type { HttpAdapter } from './http.js';
import type { InnertubeContext } from './context.js';
import { URLS } from './constants.js';
import { getText } from './format-helpers.js';
import { Session } from './session.js';
import type { TextItem, ThumbnailItem, SessionOptions } from './types.js';

// ==================== Browse IDs & Params ====================

export const BROWSE_IDS = {
  HOME: 'FEwhat_to_watch',
  TRENDING: 'FEtrending',
  SUBSCRIPTIONS: 'FEsubscriptions',
  LIBRARY: 'FElibrary',
  HISTORY: 'FEhistory',
  WATCH_LATER_PLAYLIST: 'VLWL',
  LIKED_PLAYLIST: 'VLLL',
  LIKED_MUSIC: 'VLLM',
  MY_PLAYLISTS: 'FEplaylist_aggregation',
  MY_VIDEOS: 'FEmy_videos',
  MUSIC: 'FEtopics_music',
  GAMING: 'FEtopics_gaming',
  NEWS: 'FEtopics_news',
  SPORTS: 'FEtopics_sports',
  LIVE: 'FEtopics_live',
  MOVIES: 'FEtopics_movies',
  KIDS_HOME: 'FEkids_home',
} as const;

export const CHANNEL_PARAMS = {
  HOME: 'EghmZWF0dXJlZPIGBAoCMgA%3D',
  VIDEOS: 'EgZ2aWRlb3PyBgQKAjoA',
  SHORTS: 'EgZzaG9ydHPyBgUKA5oBAA%3D%3D',
  LIVE: 'EgdzdHJlYW1z8gYECgJ6AA%3D%3D',
  PLAYLISTS: 'EglwbGF5bGlzdHPyBgQKAkIA',
  RELEASES: 'EghyZWxlYXNlc_IGBQoDsgEA',
  COMMUNITY: 'Egljb21tdW5pdHnyBgQKAkoA',
} as const;

/**
 * YouTube search filter params (simple constants for single-criteria filtering).
 * For combining multiple criteria, use `SearchFilter.create()` instead.
 */
export const SEARCH_FILTERS = {
  // Type filters
  TYPE_VIDEO: 'EgIQAQ%3D%3D',
  TYPE_CHANNEL: 'EgIQAg%3D%3D',
  TYPE_PLAYLIST: 'EgIQAw%3D%3D',
  TYPE_MOVIE: 'EgIQBA%3D%3D',

  // Upload date
  UPLOAD_LAST_HOUR: 'EgQIARAB',
  UPLOAD_TODAY: 'EgQIAhAB',
  UPLOAD_THIS_WEEK: 'EgQIAxAB',
  UPLOAD_THIS_MONTH: 'EgQIBBAB',
  UPLOAD_THIS_YEAR: 'EgQIBRAB',

  // Duration
  DURATION_UNDER_4_MIN: 'EgQQARgB',
  DURATION_4_TO_20_MIN: 'EgQQARgD',
  DURATION_OVER_20_MIN: 'EgQQARgC',

  // Features
  FEATURE_LIVE: 'EgJAAQ%3D%3D',
  FEATURE_4K: 'EgJwAQ%3D%3D',
  FEATURE_HDR: 'EgPIAQE%3D',

  // Sort
  SORT_BY_RELEVANCE: undefined as string | undefined,
  SORT_BY_UPLOAD_DATE: 'CAI%3D',
  SORT_BY_VIEW_COUNT: 'CAMSAhAB',
  SORT_BY_RATING: 'CAESAhAB',
} as const;

// ==================== Search Filter Builder ====================

export type SearchUploadDate = 'lastHour' | 'today' | 'thisWeek' | 'thisMonth' | 'thisYear';
export type SearchDuration = 'short' | 'medium' | 'long';
export type SearchType = 'video' | 'channel' | 'playlist' | 'movie';
export type SearchFeature = 'live' | '4k' | 'hdr';
export type SearchSortBy = 'relevance' | 'uploadDate' | 'viewCount' | 'rating';

export interface SearchFilterOptions {
  uploadDate?: SearchUploadDate;
  duration?: SearchDuration;
  type?: SearchType;
  features?: SearchFeature[];
  sortBy?: SearchSortBy;
}

/**
 * Combinable YouTube search filter.
 *
 * @example
 * ```typescript
 * // Videos uploaded today, under 4 minutes, sorted by view count
 * const filter = SearchFilter.create({
 *   type: 'video',
 *   uploadDate: 'today',
 *   duration: 'short',
 *   sortBy: 'viewCount',
 * });
 * const results = await yt.search('lofi', filter);
 *
 * // Live 4K streams
 * const filter2 = SearchFilter.create({
 *   type: 'video',
 *   features: ['live', '4k'],
 * });
 *
 * // Channels only
 * const filter3 = SearchFilter.create({ type: 'channel' });
 * ```
 */
export class SearchFilter {
  // Pre-encoded protobuf params for combinations (from SearchFilterHelper.java)
  private static readonly PARAMS: Record<string, string> = {
    // ── Single criteria ──

    // Upload date
    'u1': 'EgQIARAB',     // lastHour
    'u2': 'EgQIAhAB',     // today
    'u3': 'EgQIAxAB',     // thisWeek
    'u4': 'EgQIBBAB',     // thisMonth
    'u5': 'EgQIBRAB',     // thisYear

    // Duration
    'd1': 'EgQQARgB',     // short (under 4 min)
    'd2': 'EgQQARgD',     // medium (4-20 min)
    'd3': 'EgQQARgC',     // long (over 20 min)

    // Type
    't1': 'EgIQAQ%3D%3D', // video
    't2': 'EgIQAg%3D%3D', // channel
    't3': 'EgIQAw%3D%3D', // playlist
    't4': 'EgIQBA%3D%3D', // movie

    // Features
    'f1': 'EgJAAQ%3D%3D', // live
    'f2': 'EgJwAQ%3D%3D', // 4k
    'f3': 'EgPIAQE%3D',   // hdr
    'f12': 'EgRAAXAB',    // live + 4k
    'f23': 'EgVwAcgBAQ%3D%3D', // 4k + hdr
    'f123': 'EgdAAXAByAEB', // live + 4k + hdr

    // Sort
    's1': 'CAI%3D',        // uploadDate
    's2': 'CAMSAhAB',     // viewCount
    's3': 'CAESAhAB',     // rating

    // ── Upload date + duration ──
    'u2d1': 'EgYIAhABGAE%3D',  // today + short
    'u2d2': 'EgYIAhABGAM%3D',  // today + medium
    'u2d3': 'EgYIAhABGAI%3D',  // today + long
    'u3d1': 'EgYIAxABGAE%3D',  // thisWeek + short
    'u3d2': 'EgYIAxABGAM%3D',  // thisWeek + medium
    'u3d3': 'EgYIAxABGAI%3D',  // thisWeek + long
    'u4d1': 'EgYIBBABGAE%3D',  // thisMonth + short
    'u4d2': 'EgYIBBABGAM%3D',  // thisMonth + medium
    'u4d3': 'EgYIBBABGAI%3D',  // thisMonth + long

    // ── Upload date + duration + sort ──
    'u3d1s1': 'CAISBBABGAI%3D', // thisWeek + short + uploadDate
    'u3d2s2': 'CAMSBBABGAI%3D', // thisWeek + medium + viewCount
    'u3d3s3': 'CAESBBABGAI%3D', // thisWeek + long + rating
  };

  /**
   * Create a search filter params string from the given options.
   * Returns `undefined` for no filter (default/relevance).
   */
  static create(options: SearchFilterOptions): string | undefined {
    if (!options) return undefined;

    const {
      uploadDate,
      duration,
      type,
      features,
      sortBy,
    } = options;

    // If only sort by relevance and nothing else, no filter needed
    const hasFilter = uploadDate || duration || type || (features && features.length > 0) || (sortBy && sortBy !== 'relevance');
    if (!hasFilter) return undefined;

    // Build lookup key
    const key = SearchFilter.buildKey(options);

    // Try exact match in the pre-computed table
    const exact = SearchFilter.PARAMS[key];
    if (exact) return exact;

    // Fall back to individual params (best effort — most common single criteria)
    if (type) {
      const typeKey = 't' + SearchFilter.typeIndex(type);
      if (SearchFilter.PARAMS[typeKey]) return SearchFilter.PARAMS[typeKey];
    }
    if (uploadDate) {
      const udKey = 'u' + SearchFilter.uploadDateIndex(uploadDate);
      if (SearchFilter.PARAMS[udKey]) return SearchFilter.PARAMS[udKey];
    }
    if (duration) {
      const dKey = 'd' + SearchFilter.durationIndex(duration);
      if (SearchFilter.PARAMS[dKey]) return SearchFilter.PARAMS[dKey];
    }
    if (features && features.length > 0) {
      const fKey = 'f' + SearchFilter.featuresKey(features);
      if (SearchFilter.PARAMS[fKey]) return SearchFilter.PARAMS[fKey];
    }
    if (sortBy && sortBy !== 'relevance') {
      const sKey = 's' + SearchFilter.sortIndex(sortBy);
      if (SearchFilter.PARAMS[sKey]) return SearchFilter.PARAMS[sKey];
    }

    return undefined;
  }

  /** Helper: build a lookup key from options */
  private static buildKey(options: SearchFilterOptions): string {
    let key = '';
    if (options.uploadDate) key += 'u' + SearchFilter.uploadDateIndex(options.uploadDate);
    if (options.duration) key += 'd' + SearchFilter.durationIndex(options.duration);
    if (options.type) key += 't' + SearchFilter.typeIndex(options.type);
    if (options.features && options.features.length > 0) key += 'f' + SearchFilter.featuresKey(options.features);
    if (options.sortBy && options.sortBy !== 'relevance') key += 's' + SearchFilter.sortIndex(options.sortBy);
    return key;
  }

  private static uploadDateIndex(v: SearchUploadDate): number {
    return { lastHour: 1, today: 2, thisWeek: 3, thisMonth: 4, thisYear: 5 }[v] ?? 0;
  }

  private static durationIndex(v: SearchDuration): number {
    return { short: 1, medium: 2, long: 3 }[v] ?? 0;
  }

  private static typeIndex(v: SearchType): number {
    return { video: 1, channel: 2, playlist: 3, movie: 4 }[v] ?? 0;
  }

  private static sortIndex(v: SearchSortBy): number {
    return { relevance: 0, uploadDate: 1, viewCount: 2, rating: 3 }[v] ?? 0;
  }

  private static featuresKey(features: SearchFeature[]): string {
    const indices = features
      .map(f => ({ live: 1, '4k': 2, hdr: 3 })[f] ?? 0)
      .filter(i => i > 0)
      .sort();
    return indices.join('');
  }
}

// ==================== Response Types ====================

export interface BrowseItem {
  videoId?: string;
  title?: string;
  thumbnails?: Array<{ url: string; width?: number; height?: number }>;
  channelName?: string;
  channelId?: string;
  channelThumbnail?: string;
  viewCount?: string;
  publishedTimeText?: string;
  lengthText?: string;
  description?: string;
  isLive?: boolean;
  isShort?: boolean;
  playlistId?: string;
  videoCount?: string;
  /** For playlist items */
  index?: number;
  badges?: string[];
}

export interface BrowseSection {
  title?: string;
  items: BrowseItem[];
  continuationToken?: string;
}

export interface BrowseResponse {
  sections: BrowseSection[];
  continuationToken?: string;
  /** Channel metadata, if browsing a channel */
  channelMeta?: {
    title?: string;
    description?: string;
    channelId?: string;
    subscriberCount?: string;
    thumbnails?: Array<{ url: string; width?: number; height?: number }>;
    bannerThumbnails?: Array<{ url: string; width?: number; height?: number }>;
  };
}

export interface SearchResponse {
  items: BrowseItem[];
  continuationToken?: string;
  estimatedResults?: string;
  refinements?: string[];
}

export interface SearchSuggestion {
  text: string;
}

// ==================== Browse Service ====================

export class BrowseService {
  private http: HttpAdapter;
  private sessionOptions?: SessionOptions;

  constructor(http: HttpAdapter, sessionOptions?: SessionOptions) {
    this.http = http;
    this.sessionOptions = sessionOptions;
  }

  /**
   * Browse a feed (home, trending, subscriptions, etc.) or a channel/playlist.
   */
  async browse(browseId: string, params?: string): Promise<BrowseResponse | null> {
    const session = await Session.create(this.http, this.sessionOptions);
    if (!session) return null;

    const body: any = {
      context: session.context,
      browseId,
    };
    if (params) {
      body.params = params;
    }

    const result = await this.postInnertube(session, '/browse', body);
    if (!result) return null;

    return this.parseBrowseResult(result);
  }

  /**
   * Browse channel videos specifically.
   */
  async getChannelVideos(channelId: string): Promise<BrowseResponse | null> {
    return this.browse(channelId, CHANNEL_PARAMS.VIDEOS);
  }

  /**
   * Browse channel shorts.
   */
  async getChannelShorts(channelId: string): Promise<BrowseResponse | null> {
    return this.browse(channelId, CHANNEL_PARAMS.SHORTS);
  }

  /**
   * Browse channel live streams.
   */
  async getChannelLive(channelId: string): Promise<BrowseResponse | null> {
    return this.browse(channelId, CHANNEL_PARAMS.LIVE);
  }

  /**
   * Browse channel playlists.
   */
  async getChannelPlaylists(channelId: string): Promise<BrowseResponse | null> {
    return this.browse(channelId, CHANNEL_PARAMS.PLAYLISTS);
  }

  /**
   * Browse channel releases (albums).
   */
  async getChannelReleases(channelId: string): Promise<BrowseResponse | null> {
    return this.browse(channelId, CHANNEL_PARAMS.RELEASES);
  }

  /**
   * Browse channel community posts.
   */
  async getChannelCommunity(channelId: string): Promise<BrowseResponse | null> {
    return this.browse(channelId, CHANNEL_PARAMS.COMMUNITY);
  }

  /**
   * Browse channel home/featured.
   */
  async getChannelHome(channelId: string): Promise<BrowseResponse | null> {
    return this.browse(channelId, CHANNEL_PARAMS.HOME);
  }

  /**
   * Browse a playlist by playlist ID.
   */
  async getPlaylist(playlistId: string): Promise<BrowseResponse | null> {
    // Playlist browse IDs start with "VL"
    const browseId = playlistId.startsWith('VL') ? playlistId : `VL${playlistId}`;
    return this.browse(browseId);
  }

  /**
   * Get home feed.
   */
  async getHome(): Promise<BrowseResponse | null> {
    return this.browse(BROWSE_IDS.HOME);
  }

  /**
   * Get trending feed.
   */
  async getTrending(): Promise<BrowseResponse | null> {
    return this.browse(BROWSE_IDS.TRENDING);
  }

  /**
   * Get subscriptions feed (requires auth/cookie).
   */
  async getSubscriptions(): Promise<BrowseResponse | null> {
    return this.browse(BROWSE_IDS.SUBSCRIPTIONS);
  }

  /**
   * Get watch history (requires auth/cookie).
   */
  async getHistory(): Promise<BrowseResponse | null> {
    return this.browse(BROWSE_IDS.HISTORY);
  }

  /**
   * Get liked videos (requires auth/cookie).
   */
  async getLikedVideos(): Promise<BrowseResponse | null> {
    return this.browse(BROWSE_IDS.LIKED_PLAYLIST);
  }

  /**
   * Get watch later playlist (requires auth/cookie).
   */
  async getWatchLater(): Promise<BrowseResponse | null> {
    return this.browse(BROWSE_IDS.WATCH_LATER_PLAYLIST);
  }

  /**
   * Continue loading paginated results.
   */
  async continueResults(continuationToken: string): Promise<BrowseResponse | null> {
    const session = await Session.create(this.http, this.sessionOptions);
    if (!session) return null;

    const body = {
      context: session.context,
      continuation: continuationToken,
    };

    const result = await this.postInnertube(session, '/browse', body);
    if (!result) return null;

    return this.parseContinuationResult(result);
  }

  // ==================== Search ====================

  /**
   * Search YouTube.
   *
   * @param query Search query string
   * @param filter Either a raw params string (from SEARCH_FILTERS) or a SearchFilterOptions object
   *
   * @example
   * ```typescript
   * // Using raw params
   * await browse.search('lofi', SEARCH_FILTERS.TYPE_VIDEO);
   *
   * // Using SearchFilterOptions
   * await browse.search('lofi', { type: 'video', uploadDate: 'thisWeek', sortBy: 'viewCount' });
   *
   * // Using SearchFilter.create()
   * await browse.search('lofi', SearchFilter.create({ type: 'video', duration: 'long' }));
   * ```
   */
  async search(query: string, filter?: string | SearchFilterOptions): Promise<SearchResponse | null> {
    const session = await Session.create(this.http, this.sessionOptions);
    if (!session) return null;

    // Resolve filter
    let searchFilter: string | undefined;
    if (typeof filter === 'string') {
      searchFilter = filter;
    } else if (filter && typeof filter === 'object') {
      searchFilter = SearchFilter.create(filter);
    }

    const body: any = {
      context: session.context,
      query,
    };
    if (searchFilter) {
      body.params = searchFilter;
    }

    const result = await this.postInnertube(session, '/search', body);
    if (!result) return null;

    return this.parseSearchResult(result);
  }

  /**
   * Continue loading paginated search results.
   */
  async continueSearch(continuationToken: string): Promise<SearchResponse | null> {
    const session = await Session.create(this.http, this.sessionOptions);
    if (!session) return null;

    const body = {
      context: session.context,
      continuation: continuationToken,
    };

    const result = await this.postInnertube(session, '/search', body);
    if (!result) return null;

    return this.parseSearchResult(result);
  }

  /**
   * Get search suggestions/autocomplete.
   */
  async getSearchSuggestions(query: string, lang = 'en', country = 'us'): Promise<SearchSuggestion[]> {
    const url = `https://suggestqueries-clients6.youtube.com/complete/search?client=youtube&ds=yt&q=${encodeURIComponent(query)}&hl=${lang}&gl=${country}&xhr=t&xssi=t`;

    try {
      const resp = await this.http.request(url, { method: 'GET', headers: {} });
      const text = await resp.text();
      // Response starts with ")]}'\n"
      const jsonStr = text.replace(/^\)\]\}'\n?/, '');
      const data = JSON.parse(jsonStr);

      if (Array.isArray(data) && Array.isArray(data[1])) {
        return data[1].map((item: any) => ({
          text: Array.isArray(item) ? item[0] : String(item),
        }));
      }
      return [];
    } catch {
      return [];
    }
  }

  // ==================== Next (Related Videos / Watch Info) ====================

  /**
   * Get "next" data for a video (related videos, comments metadata, etc.)
   */
  async getNext(videoId: string, playlistId?: string): Promise<BrowseResponse | null> {
    const session = await Session.create(this.http, this.sessionOptions);
    if (!session) return null;

    const body: any = {
      context: session.context,
      videoId,
    };
    if (playlistId) {
      body.playlistId = playlistId;
    }

    const result = await this.postInnertube(session, '/next', body);
    if (!result) return null;

    return this.parseNextResult(result);
  }

  // ==================== Resolve URL ====================

  /**
   * Resolve a YouTube URL to a browse endpoint (channel, playlist, video, etc.)
   */
  async resolveUrl(url: string): Promise<{ browseId?: string; videoId?: string; playlistId?: string } | null> {
    const session = await Session.create(this.http, this.sessionOptions);
    if (!session) return null;

    const body = {
      context: session.context,
      url,
    };

    const result = await this.postInnertube(session, '/navigation/resolve_url', body);
    if (!result) return null;

    const endpoint = result.endpoint;
    const browseEndpoint = endpoint?.browseEndpoint;
    const watchEndpoint = endpoint?.watchEndpoint;

    return {
      browseId: browseEndpoint?.browseId,
      videoId: watchEndpoint?.videoId,
      playlistId: watchEndpoint?.playlistId ?? browseEndpoint?.browseId,
    };
  }

  // ==================== Internal Helpers ====================

  private async postInnertube(
    session: Session,
    endpoint: string,
    body: any,
  ): Promise<any | null> {
    const url = `${URLS.API.PRODUCTION_1}v1${endpoint}?prettyPrint=false&alt=json`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': session.userAgent,
      Accept: '*/*',
      'Accept-Language': '*',
      Origin: URLS.YT_BASE,
      Referer: URLS.YT_BASE,
      'X-Youtube-Client-Version': session.context.client.clientVersion ?? '',
      'X-Goog-Visitor-Id': session.context.client.visitorData ?? '',
    };

    // Add cookie for authenticated requests
    if (session.cookie) {
      headers['Cookie'] = session.cookie;
    }

    try {
      const resp = await this.http.request(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      return await resp.json();
    } catch (e) {
      console.error('[ytbapi] Browse request failed:', e);
      return null;
    }
  }

  // ==================== Response Parsers ====================

  private parseBrowseResult(data: any): BrowseResponse {
    const sections: BrowseSection[] = [];
    let continuationToken: string | undefined;

    // Parse tabs
    const tabs =
      data.contents?.twoColumnBrowseResultsRenderer?.tabs ??
      data.contents?.singleColumnBrowseResultsRenderer?.tabs ??
      [];

    for (const tab of tabs) {
      const tabRenderer = tab?.tabRenderer ?? tab?.expandableTabRenderer;
      if (!tabRenderer?.content) continue;

      const sectionListRenderer =
        tabRenderer.content?.sectionListRenderer ??
        tabRenderer.content?.richGridRenderer;

      if (sectionListRenderer) {
        const parsed = this.parseSectionListRenderer(sectionListRenderer);
        sections.push(...parsed.sections);
        if (parsed.continuationToken) continuationToken = parsed.continuationToken;
      }
    }

    // Parse channel metadata
    let channelMeta: BrowseResponse['channelMeta'];
    const header = data.header;
    if (header) {
      const ch =
        header.c4TabbedHeaderRenderer ??
        header.pageHeaderRenderer?.pageHeaderViewModel ??
        header.playlistHeaderRenderer;

      if (ch) {
        channelMeta = {
          title: ch.title ? (typeof ch.title === 'string' ? ch.title : getText(ch.title)) : undefined,
          description: ch.description ? (typeof ch.description === 'string' ? ch.description : getText(ch.description)) : undefined,
          channelId: ch.channelId ?? ch.navigationEndpoint?.browseEndpoint?.browseId,
          subscriberCount: ch.subscriberCountText ? getText(ch.subscriberCountText) : undefined,
          thumbnails: ch.avatar?.thumbnails ?? ch.thumbnail?.thumbnails,
          bannerThumbnails: ch.banner?.thumbnails ?? ch.tvBanner?.thumbnails,
        };
      }
    }

    // Parse playlist header (pageHeaderRenderer for playlists)
    if (header?.pageHeaderRenderer) {
      const phr = header.pageHeaderRenderer;
      const titleObj = phr.pageHeaderViewModel?.title;
      const title = titleObj?.dynamicTextViewModel?.text?.content ?? getText(titleObj);
      if (title && !channelMeta) {
        channelMeta = { title };
      } else if (title && channelMeta) {
        channelMeta.title = channelMeta.title ?? title;
      }
    }

    // Also try metadata.playlistMetadataRenderer or channelMetadataRenderer
    const meta = data.metadata;
    if (meta) {
      const plMeta = meta.playlistMetadataRenderer;
      const chMeta = meta.channelMetadataRenderer;
      if (plMeta) {
        if (!channelMeta) channelMeta = {};
        channelMeta.title = channelMeta.title ?? plMeta.title;
        channelMeta.description = channelMeta.description ?? plMeta.description;
      }
      if (chMeta) {
        if (!channelMeta) channelMeta = {};
        channelMeta.title = channelMeta.title ?? chMeta.title;
        channelMeta.description = channelMeta.description ?? chMeta.description;
        channelMeta.channelId = channelMeta.channelId ?? chMeta.externalId;
        channelMeta.thumbnails = channelMeta.thumbnails ?? chMeta.avatar?.thumbnails;
      }
    }

    return { sections, continuationToken, channelMeta };
  }

  private parseContinuationResult(data: any): BrowseResponse {
    const sections: BrowseSection[] = [];
    let continuationToken: string | undefined;

    const actions = data.onResponseReceivedActions ?? data.onResponseReceivedEndpoints ?? [];

    for (const action of actions) {
      const items =
        action?.appendContinuationItemsAction?.continuationItems ??
        action?.reloadContinuationItemsCommand?.continuationItems ??
        [];

      const parsedItems: BrowseItem[] = [];
      for (const item of items) {
        // Check for continuation
        if (item?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token) {
          continuationToken = item.continuationItemRenderer.continuationEndpoint.continuationCommand.token;
          continue;
        }
        // Channel video continuations wrap each renderer in a rich item.
        const actualItem = item?.richItemRenderer?.content ?? item;
        const parsed = this.parseRendererItem(actualItem);
        if (parsed) parsedItems.push(parsed);
      }

      if (parsedItems.length > 0) {
        sections.push({ items: parsedItems, continuationToken });
      }
    }

    return { sections, continuationToken };
  }

  private parseSearchResult(data: any): SearchResponse {
    const items: BrowseItem[] = [];
    let continuationToken: string | undefined;

    const contents =
      data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents ??
      data.contents?.sectionListRenderer?.contents ??
      [];

    for (const section of contents) {
      const sectionRenderer =
        section?.itemSectionRenderer ??
        section?.shelfRenderer;

      if (sectionRenderer?.contents) {
        for (const item of sectionRenderer.contents) {
          const parsed = this.parseRendererItem(item);
          if (parsed) items.push(parsed);
        }
      }

      // Continuation in search
      if (section?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token) {
        continuationToken = section.continuationItemRenderer.continuationEndpoint.continuationCommand.token;
      }
    }

    // Also check for onResponseReceivedCommands (continuation search results)
    const commands = data.onResponseReceivedCommands ?? [];
    for (const cmd of commands) {
      const cmdItems = cmd?.appendContinuationItemsAction?.continuationItems ?? [];
      for (const item of cmdItems) {
        if (item?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token) {
          continuationToken = item.continuationItemRenderer.continuationEndpoint.continuationCommand.token;
          continue;
        }
        const sRenderer = item?.itemSectionRenderer;
        if (sRenderer?.contents) {
          for (const inner of sRenderer.contents) {
            const parsed = this.parseRendererItem(inner);
            if (parsed) items.push(parsed);
          }
        }
      }
    }

    return {
      items,
      continuationToken,
      estimatedResults: data.estimatedResults,
      refinements: data.refinements,
    };
  }

  private parseNextResult(data: any): BrowseResponse {
    const sections: BrowseSection[] = [];

    // Related videos
    const secondaryResults =
      data.contents?.twoColumnWatchNextResults?.secondaryResults?.secondaryResults?.results ??
      [];

    const relatedItems: BrowseItem[] = [];
    let relatedCont: string | undefined;

    for (const item of secondaryResults) {
      if (item?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token) {
        relatedCont = item.continuationItemRenderer.continuationEndpoint.continuationCommand.token;
        continue;
      }
      const parsed = this.parseRendererItem(item);
      if (parsed) relatedItems.push(parsed);
    }

    if (relatedItems.length > 0) {
      sections.push({ title: 'Related Videos', items: relatedItems, continuationToken: relatedCont });
    }

    // Playlist items
    const playlist = data.contents?.twoColumnWatchNextResults?.playlist?.playlist;
    if (playlist) {
      const playlistItems: BrowseItem[] = [];
      for (const item of playlist.contents ?? []) {
        const plr = item?.playlistPanelVideoRenderer;
        if (plr) {
          playlistItems.push({
            videoId: plr.videoId,
            title: getText(plr.title),
            thumbnails: plr.thumbnail?.thumbnails,
            channelName: getText(plr.shortBylineText ?? plr.longBylineText),
            lengthText: getText(plr.lengthText),
            index: plr.index ? parseInt(getText(plr.index) ?? '0') : undefined,
          });
        }
      }
      if (playlistItems.length > 0) {
        sections.push({ title: playlist.title ?? 'Playlist', items: playlistItems });
      }
    }

    return { sections };
  }

  private parseSectionListRenderer(renderer: any): { sections: BrowseSection[]; continuationToken?: string } {
    const sections: BrowseSection[] = [];
    let continuationToken: string | undefined;

    const contents = renderer.contents ?? renderer.items ?? [];

    for (const section of contents) {
      // Check for continuation token
      if (section?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token) {
        continuationToken = section.continuationItemRenderer.continuationEndpoint.continuationCommand.token;
        continue;
      }

      const sectionRenderer =
        section?.itemSectionRenderer ??
        section?.shelfRenderer ??
        section?.richSectionRenderer?.content?.richShelfRenderer ??
        section?.richItemRenderer;

      if (!sectionRenderer) continue;

      const sectionTitle = getText(
        sectionRenderer.title ?? sectionRenderer.headerRenderer?.shelfHeaderRenderer?.title,
      );

      const sectionItems: BrowseItem[] = [];
      let sectionContinuation: string | undefined;

      // Get items from various locations
      let itemsSource =
        sectionRenderer.contents ??
        sectionRenderer.content?.horizontalListRenderer?.items ??
        sectionRenderer.content?.expandedShelfContentsRenderer?.items ??
        sectionRenderer.items ??
        [];

      // Handle playlistVideoListRenderer (wrapped inside a single itemSectionRenderer content)
      if (itemsSource.length > 0) {
        const firstContent = itemsSource[0];
        if (firstContent?.playlistVideoListRenderer?.contents) {
          itemsSource = firstContent.playlistVideoListRenderer.contents;
          // Get continuation from the playlist video list
          for (const pItem of itemsSource) {
            if (pItem?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token) {
              sectionContinuation = pItem.continuationItemRenderer.continuationEndpoint.continuationCommand.token;
            }
          }
        }
      }

      // Also handle shelfRenderer content directly
      if (itemsSource.length > 0) {
        for (const innerItem of itemsSource) {
          if (innerItem?.shelfRenderer) {
            const shelf = innerItem.shelfRenderer;
            const shelfTitle = getText(shelf.title);
            const shelfItems: BrowseItem[] = [];
            const shelfContent =
              shelf.content?.expandedShelfContentsRenderer?.items ??
              shelf.content?.horizontalListRenderer?.items ??
              [];
            for (const si of shelfContent) {
              const parsed = this.parseRendererItem(si);
              if (parsed) shelfItems.push(parsed);
            }
            if (shelfItems.length > 0) {
              sections.push({ title: shelfTitle, items: shelfItems });
            }
          }
        }
      }

      // If this is a richItemRenderer directly
      if (sectionRenderer.content?.videoRenderer || sectionRenderer.content?.reelItemRenderer) {
        const parsed = this.parseRendererItem(sectionRenderer.content);
        if (parsed) sectionItems.push(parsed);
      }

      for (const item of itemsSource) {
        if (item?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token) {
          sectionContinuation = item.continuationItemRenderer.continuationEndpoint.continuationCommand.token;
          continue;
        }
        // Skip shelfRenderers (handled above)
        if (item?.shelfRenderer) continue;

        // Handle rich items (home feed)
        const actualItem = item?.richItemRenderer?.content ?? item;
        const parsed = this.parseRendererItem(actualItem);
        if (parsed) sectionItems.push(parsed);
      }

      if (sectionItems.length > 0) {
        sections.push({ title: sectionTitle, items: sectionItems, continuationToken: sectionContinuation });
      }
    }

    // Also check continuations array
    const continuations = renderer.continuations;
    if (Array.isArray(continuations)) {
      for (const c of continuations) {
        if (c?.nextContinuationData?.continuation) {
          continuationToken = c.nextContinuationData.continuation;
        }
      }
    }

    return { sections, continuationToken };
  }

  private parseRendererItem(item: any): BrowseItem | null {
    if (!item) return null;

    // Video renderer (standard)
    const vr =
      item.videoRenderer ??
      item.compactVideoRenderer ??
      item.gridVideoRenderer ??
      item.playlistVideoRenderer;

    if (vr) {
      return {
        videoId: vr.videoId,
        title: getText(vr.title ?? vr.headline),
        thumbnails: vr.thumbnail?.thumbnails,
        channelName: getText(
          vr.shortBylineText ??
          vr.longBylineText ??
          vr.ownerText,
        ),
        channelId:
          vr.shortBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId ??
          vr.longBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId ??
          vr.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId,
        viewCount: getText(vr.viewCountText ?? vr.shortViewCountText),
        publishedTimeText: getText(vr.publishedTimeText),
        lengthText: getText(vr.lengthText ?? vr.thumbnailOverlays?.[0]?.thumbnailOverlayTimeStatusRenderer?.text),
        description: getText(vr.descriptionSnippet ?? vr.detailedMetadataSnippets?.[0]?.snippetText),
        isLive: vr.badges?.some((b: any) =>
          b?.metadataBadgeRenderer?.style === 'BADGE_STYLE_TYPE_LIVE_NOW' ||
          b?.metadataBadgeRenderer?.label === 'LIVE',
        ) ?? false,
        badges: vr.badges?.map((b: any) => b?.metadataBadgeRenderer?.label).filter(Boolean),
        index: vr.index ? parseInt(getText(vr.index) ?? '0') : undefined,
        playlistId: vr.navigationEndpoint?.watchEndpoint?.playlistId,
      };
    }

    // Channel renderer
    const cr = item.channelRenderer ?? item.gridChannelRenderer;
    if (cr) {
      return {
        channelId: cr.channelId,
        title: getText(cr.title),
        thumbnails: cr.thumbnail?.thumbnails,
        channelName: getText(cr.title),
        description: getText(cr.descriptionSnippet),
        viewCount: getText(cr.subscriberCountText ?? cr.videoCountText),
      };
    }

    // Playlist renderer
    const pr = item.playlistRenderer ?? item.gridPlaylistRenderer ?? item.compactPlaylistRenderer;
    if (pr) {
      return {
        playlistId: pr.playlistId,
        title: getText(pr.title),
        thumbnails: pr.thumbnails?.[0]?.thumbnails ?? pr.thumbnail?.thumbnails,
        channelName: getText(pr.shortBylineText ?? pr.longBylineText),
        channelId:
          pr.shortBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId ??
          pr.longBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId,
        videoCount: getText(pr.videoCountText ?? pr.videoCountShortText),
      };
    }

    // Reel (Shorts) renderer
    const rr = item.reelItemRenderer ?? item.shortsLockupViewModel;
    if (rr) {
      return {
        videoId: rr.videoId ?? rr.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId,
        title: getText(rr.headline) ?? rr.overlayMetadata?.primaryText?.content,
        thumbnails: rr.thumbnail?.thumbnails,
        viewCount: rr.overlayMetadata?.secondaryText?.content ?? getText(rr.viewCountText),
        isShort: true,
      };
    }

    // Radio/mix renderer
    const mr = item.radioRenderer ?? item.compactRadioRenderer;
    if (mr) {
      return {
        playlistId: mr.playlistId,
        title: getText(mr.title),
        thumbnails: mr.thumbnail?.thumbnails,
        channelName: getText(mr.shortBylineText ?? mr.longBylineText),
      };
    }

    // lockupViewModel (newer YouTube related video format)
    const lvm = item.lockupViewModel;
    if (lvm) {
      const contentId = typeof lvm.contentId === 'string' ? lvm.contentId : undefined;
      // New channel grids use the same lockup renderer for videos and
      // playlists. YouTube video IDs are always 11 URL-safe characters;
      // playlist IDs are longer and must be sent back through /browse.
      const isVideo = Boolean(contentId && /^[A-Za-z0-9_-]{11}$/.test(contentId));
      const contentImage = lvm.contentImage?.collectionThumbnailViewModel?.primaryThumbnail?.thumbnailViewModel;
      const metadata = lvm.metadata?.lockupMetadataViewModel;
      const titleText = metadata?.title?.content;
      const metadataRows = metadata?.metadata?.contentMetadataViewModel?.metadataRows;
      let channelName: string | undefined;
      let viewCount: string | undefined;
      let publishedTime: string | undefined;

      if (metadataRows) {
        for (const row of metadataRows) {
          for (const part of row?.metadataParts ?? []) {
            const t = part?.text?.content;
            if (t) {
              if (t.includes('views') || t.includes('watching')) viewCount = t;
              else if (t.includes('ago') || t.includes('Streamed')) publishedTime = t;
              else if (!channelName) channelName = t;
            }
          }
        }
      }

      return {
        videoId: isVideo ? contentId : undefined,
        playlistId: !isVideo ? contentId : undefined,
        title: titleText,
        thumbnails: contentImage?.overlays?.[0]?.thumbnailOverlayBadgeViewModel?.thumbnailBadges?.[0]?.thumbnailBadgeViewModel?.icon?.sources ??
          contentImage?.image?.sources,
        channelName,
        viewCount,
        publishedTimeText: publishedTime,
        lengthText: contentImage?.overlays?.find((o: any) => o?.thumbnailOverlayBadgeViewModel)?.thumbnailOverlayBadgeViewModel?.thumbnailBadges?.[0]?.thumbnailBadgeViewModel?.text,
      };
    }

    return null;
  }
}
