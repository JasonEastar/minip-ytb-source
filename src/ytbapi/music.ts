/**
 * YouTube Music API service
 *
 * Uses the WEB_REMIX (YouTube Music) client to access YT Music endpoints.
 * Supports: search, browse, playlists, albums, artists, charts, etc.
 */

import type { HttpAdapter } from './http.js';
import type { SessionOptions, MediaItemFormatInfo } from './types.js';
import { URLS, CLIENTS } from './constants.js';
import { getText } from './format-helpers.js';
import { Session } from './session.js';
import type { BrowseItem, BrowseSection, SearchSuggestion } from './browse.js';
import { buildFormatInfo } from './format-helpers.js';

// ==================== YT Music Constants ====================

const YTM_BASE = 'https://music.youtube.com';
const YTM_API = `${YTM_BASE}/youtubei/v1`;
const YTM_CLIENT_NAME = 'WEB_REMIX';
const YTM_CLIENT_VERSION = '1.20250219.01.00';

export const YTMUSIC_BROWSE_IDS = {
  HOME: 'FEmusic_home',
  EXPLORE: 'FEmusic_explore',
  LIBRARY: 'FEmusic_library_landing',
  CHARTS: 'FEmusic_charts',
  MOODS: 'FEmusic_moods_and_genres',
  NEW_RELEASES_ALBUMS: 'FEmusic_new_releases_albums',
  NEW_RELEASES_VIDEOS: 'FEmusic_new_releases_videos',
  LIKED_SONGS: 'FEmusic_liked_videos',
  LIKED_PLAYLISTS: 'FEmusic_liked_playlists',
  HISTORY: 'FEmusic_history',
} as const;

// Search filter params for YT Music
export const YTMUSIC_SEARCH_FILTERS = {
  SONGS: 'EgWKAQIIAWoMEAMQBBAJEA4QChAF',
  VIDEOS: 'EgWKAQIQAWoMEAMQBBAJEA4QChAF',
  ALBUMS: 'EgWKAQIYAWoMEAMQBBAJEA4QChAF',
  ARTISTS: 'EgWKAQIgAWoMEAMQBBAJEA4QChAF',
  PLAYLISTS: 'EgWKAQIoAWoMEAMQBBAJEA4QChAF',
  COMMUNITY_PLAYLISTS: 'EgeKAQQoADgBagwQAxAEEAkQDhAKEAU%3D',
  FEATURED_PLAYLISTS: 'EgeKAQQoAEABagwQAxAEEAkQDhAKEAU%3D',
  PODCASTS: 'EgWKAQJQAWoMEAMQBBAJEA4QChAF',
  PROFILES: 'EgWKAQJYAWoMEAMQBBAJEA4QChAF',
} as const;

// ==================== YT Music Response Types ====================

export interface MusicItem {
  videoId?: string;
  title?: string;
  artists?: Array<{ name: string; id?: string }>;
  album?: { name: string; id?: string };
  thumbnails?: Array<{ url: string; width?: number; height?: number }>;
  duration?: string;
  durationSeconds?: number;
  playlistId?: string;
  isExplicit?: boolean;
  year?: string;
  views?: string;
  /** For albums/playlists */
  browseId?: string;
  itemType?: 'song' | 'video' | 'album' | 'artist' | 'playlist' | 'podcast' | 'profile';
  subtitle?: string;
}

export interface MusicSection {
  title?: string;
  items: MusicItem[];
  browseId?: string;
  params?: string;
  continuationToken?: string;
}

export interface MusicSearchResponse {
  sections: MusicSection[];
  continuationToken?: string;
}

export interface MusicBrowseResponse {
  sections: MusicSection[];
  continuationToken?: string;
  header?: {
    title?: string;
    subtitle?: string;
    description?: string;
    thumbnails?: Array<{ url: string; width?: number; height?: number }>;
    year?: string;
    trackCount?: string;
    playlistId?: string;
  };
}

// ==================== YouTube Music Service ====================

export class YouTubeMusicService {
  private http: HttpAdapter;
  private sessionOptions?: SessionOptions;

  constructor(http: HttpAdapter, sessionOptions?: SessionOptions) {
    this.http = http;
    this.sessionOptions = sessionOptions;
  }

  // ==================== Search ====================

  /**
   * Search YouTube Music.
   * @param query Search query
   * @param filter Optional filter from YTMUSIC_SEARCH_FILTERS
   */
  async search(query: string, filter?: string): Promise<MusicSearchResponse | null> {
    const body: any = {
      query,
    };
    if (filter) {
      body.params = filter;
    }

    const result = await this.postMusicApi('/search', body);
    if (!result) return null;

    return this.parseMusicSearchResult(result);
  }

  /**
   * Search for songs only.
   */
  async searchSongs(query: string): Promise<MusicSearchResponse | null> {
    return this.search(query, YTMUSIC_SEARCH_FILTERS.SONGS);
  }

  /**
   * Search for videos only.
   */
  async searchVideos(query: string): Promise<MusicSearchResponse | null> {
    return this.search(query, YTMUSIC_SEARCH_FILTERS.VIDEOS);
  }

  /**
   * Search for albums only.
   */
  async searchAlbums(query: string): Promise<MusicSearchResponse | null> {
    return this.search(query, YTMUSIC_SEARCH_FILTERS.ALBUMS);
  }

  /**
   * Search for artists only.
   */
  async searchArtists(query: string): Promise<MusicSearchResponse | null> {
    return this.search(query, YTMUSIC_SEARCH_FILTERS.ARTISTS);
  }

  /**
   * Search for playlists only.
   */
  async searchPlaylists(query: string): Promise<MusicSearchResponse | null> {
    return this.search(query, YTMUSIC_SEARCH_FILTERS.PLAYLISTS);
  }

  /**
   * Get YouTube Music search suggestions.
   */
  async getSearchSuggestions(query: string): Promise<SearchSuggestion[]> {
    const body = {
      input: query,
    };

    const result = await this.postMusicApi('/music/get_search_suggestions', body);
    if (!result) return [];

    const suggestions: SearchSuggestion[] = [];
    const contents = result.contents;

    if (Array.isArray(contents)) {
      for (const section of contents) {
        const items = section?.searchSuggestionsSectionRenderer?.contents ?? [];
        for (const item of items) {
          const sr = item?.searchSuggestionRenderer;
          const msr = item?.musicResponsiveListItemRenderer;

          if (sr) {
            const text = getText(sr.suggestion ?? sr.navigationEndpoint?.searchEndpoint?.query);
            if (text) suggestions.push({ text });
          }
          if (msr) {
            const text = this.getFlexColumnText(msr, 0);
            if (text) suggestions.push({ text });
          }
        }
      }
    }

    return suggestions;
  }

  // ==================== Browse ====================

  /**
   * Browse a YouTube Music page.
   */
  async browse(browseId: string, params?: string): Promise<MusicBrowseResponse | null> {
    const body: any = { browseId };
    if (params) body.params = params;

    const result = await this.postMusicApi('/browse', body);
    if (!result) return null;

    return this.parseMusicBrowseResult(result);
  }

  /**
   * Get YouTube Music home feed.
   */
  async getHome(): Promise<MusicBrowseResponse | null> {
    return this.browse(YTMUSIC_BROWSE_IDS.HOME);
  }

  /**
   * Get YouTube Music explore/discover page.
   */
  async getExplore(): Promise<MusicBrowseResponse | null> {
    return this.browse(YTMUSIC_BROWSE_IDS.EXPLORE);
  }

  /**
   * Get charts.
   */
  async getCharts(): Promise<MusicBrowseResponse | null> {
    return this.browse(YTMUSIC_BROWSE_IDS.CHARTS);
  }

  /**
   * Get moods and genres.
   */
  async getMoods(): Promise<MusicBrowseResponse | null> {
    return this.browse(YTMUSIC_BROWSE_IDS.MOODS);
  }

  /**
   * Get new album releases.
   */
  async getNewAlbums(): Promise<MusicBrowseResponse | null> {
    return this.browse(YTMUSIC_BROWSE_IDS.NEW_RELEASES_ALBUMS);
  }

  /**
   * Get new music video releases.
   */
  async getNewVideos(): Promise<MusicBrowseResponse | null> {
    return this.browse(YTMUSIC_BROWSE_IDS.NEW_RELEASES_VIDEOS);
  }

  /**
   * Get an artist page.
   */
  async getArtist(artistId: string): Promise<MusicBrowseResponse | null> {
    return this.browse(artistId);
  }

  /**
   * Get an album page.
   */
  async getAlbum(albumId: string): Promise<MusicBrowseResponse | null> {
    return this.browse(albumId);
  }

  /**
   * Get a playlist.
   */
  async getPlaylist(playlistId: string): Promise<MusicBrowseResponse | null> {
    const browseId = playlistId.startsWith('VL') ? playlistId : `VL${playlistId}`;
    return this.browse(browseId);
  }

  /**
   * Continue paginated results.
   */
  async continueResults(continuationToken: string): Promise<MusicBrowseResponse | null> {
    const body = { continuation: continuationToken };
    const result = await this.postMusicApi('/browse', body);
    if (!result) return null;
    return this.parseMusicBrowseResult(result);
  }

  /**
   * Get "Up Next" / queue for a song.
   */
  async getQueue(videoId: string, playlistId?: string): Promise<MusicItem[]> {
    const body: any = { videoId };
    if (playlistId) body.playlistId = playlistId;

    const result = await this.postMusicApi('/next', body);
    if (!result) return [];

    const items: MusicItem[] = [];
    const tabs =
      result.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer
        ?.watchNextTabbedResultsRenderer?.tabs ?? [];

    for (const tab of tabs) {
      const panelItems =
        tab?.tabRenderer?.content?.musicQueueRenderer?.content
          ?.playlistPanelRenderer?.contents ?? [];

      for (const item of panelItems) {
        const pvr = item?.playlistPanelVideoRenderer;
        if (pvr) {
          items.push({
            videoId: pvr.videoId,
            title: getText(pvr.title),
            artists: pvr.longBylineText?.runs
              ?.filter((_: any, i: number) => i % 2 === 0)
              .map((r: any) => ({
                name: r.text,
                id: r.navigationEndpoint?.browseEndpoint?.browseId,
              })),
            thumbnails: pvr.thumbnail?.thumbnails,
            duration: getText(pvr.lengthText),
          });
        }
      }
    }

    return items;
  }

  /**
   * Get lyrics for a song.
   */
  async getLyrics(videoId: string): Promise<string | null> {
    // First get the next endpoint to find the lyrics browse endpoint
    const nextResult = await this.postMusicApi('/next', { videoId });
    if (!nextResult) return null;

    const tabs =
      nextResult.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer
        ?.watchNextTabbedResultsRenderer?.tabs ?? [];

    let lyricsBrowseId: string | undefined;
    for (const tab of tabs) {
      const endpoint = tab?.tabRenderer?.endpoint?.browseEndpoint;
      if (endpoint?.browseId?.startsWith('MPLYt_')) {
        lyricsBrowseId = endpoint.browseId;
        break;
      }
    }

    if (!lyricsBrowseId) return null;

    const lyricsResult = await this.postMusicApi('/browse', { browseId: lyricsBrowseId });
    if (!lyricsResult) return null;

    const description =
      lyricsResult.contents?.sectionListRenderer?.contents?.[0]
        ?.musicDescriptionShelfRenderer?.description;

    return description ? (getText(description) ?? null) : null;
  }

  // ==================== Internal Helpers ====================

  private async postMusicApi(endpoint: string, body: any): Promise<any | null> {
    const session = await Session.create(this.http, this.sessionOptions);
    if (!session) return null;

    // Build YT Music context (override client to WEB_REMIX)
    const context = JSON.parse(JSON.stringify(session.context));
    context.client.clientName = YTM_CLIENT_NAME;
    context.client.clientVersion = YTM_CLIENT_VERSION;
    context.client.originalUrl = YTM_BASE;
    context.client.mainAppWebInfo = {
      ...context.client.mainAppWebInfo,
      graftUrl: YTM_BASE,
    };

    const fullBody = { context, ...body };

    const url = `${YTM_API}${endpoint}?prettyPrint=false&alt=json`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': session.userAgent,
      Accept: '*/*',
      'Accept-Language': '*',
      Origin: YTM_BASE,
      Referer: `${YTM_BASE}/`,
      'X-Youtube-Client-Name': '67',
      'X-Youtube-Client-Version': YTM_CLIENT_VERSION,
      'X-Goog-Visitor-Id': session.context.client.visitorData ?? '',
    };

    try {
      const resp = await this.http.request(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(fullBody),
      });
      return await resp.json();
    } catch (e) {
      console.error('[ytbapi] Music API request failed:', e);
      return null;
    }
  }

  // ==================== Parsers ====================

  private parseMusicSearchResult(data: any): MusicSearchResponse {
    const sections: MusicSection[] = [];
    let continuationToken: string | undefined;

    // Search results are in tabbedSearchResultsRenderer or contents.sectionListRenderer
    const tabContents =
      data.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content
        ?.sectionListRenderer?.contents ??
      data.contents?.sectionListRenderer?.contents ??
      [];

    for (const section of tabContents) {
      const shelf = section?.musicShelfRenderer;
      const carousel = section?.musicCarouselShelfRenderer;

      if (shelf) {
        const parsed = this.parseMusicShelf(shelf);
        if (parsed.items.length > 0) sections.push(parsed);
      }

      if (carousel) {
        const parsed = this.parseMusicCarousel(carousel);
        if (parsed.items.length > 0) sections.push(parsed);
      }
    }

    // Continuation from onResponseReceivedActions
    const commands = data.onResponseReceivedActions ?? [];
    for (const cmd of commands) {
      const items =
        cmd?.appendContinuationItemsAction?.continuationItems ?? [];
      for (const item of items) {
        if (item?.musicShelfRenderer) {
          const parsed = this.parseMusicShelf(item.musicShelfRenderer);
          if (parsed.items.length > 0) sections.push(parsed);
        }
      }
    }

    return { sections, continuationToken };
  }

  private parseMusicBrowseResult(data: any): MusicBrowseResponse {
    const sections: MusicSection[] = [];
    let continuationToken: string | undefined;

    // Parse header
    let header: MusicBrowseResponse['header'];
    const headerRenderer =
      data.header?.musicImmersiveHeaderRenderer ??
      data.header?.musicDetailHeaderRenderer ??
      data.header?.musicVisualHeaderRenderer;

    if (headerRenderer) {
      header = {
        title: getText(headerRenderer.title),
        subtitle: getText(headerRenderer.subtitle),
        description: getText(headerRenderer.description),
        thumbnails: headerRenderer.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails ??
          headerRenderer.thumbnail?.thumbnails,
      };

      // Extract year and track count from subtitle runs
      const subtitleRuns = headerRenderer.subtitle?.runs ?? [];
      for (const run of subtitleRuns) {
        const t = run?.text;
        if (t && /^\d{4}$/.test(t)) header.year = t;
        if (t && /^\d+ songs?$/.test(t)) header.trackCount = t;
      }
    }

    // Also try the responsive header
    const respHeader = data.header?.musicResponsiveHeaderRenderer;
    if (respHeader) {
      header = {
        title: getText(respHeader.title),
        subtitle: getText(respHeader.subtitle),
        description: getText(respHeader.description),
        thumbnails: respHeader.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails,
      };

      const strapline = respHeader.straplineTextOne?.runs;
      if (strapline && strapline.length > 0) {
        if (!header.subtitle) header.subtitle = strapline.map((r: any) => r.text).join('');
      }
    }

    // Parse browse contents
    const tabContents =
      data.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer
        ?.content?.sectionListRenderer?.contents ??
      data.contents?.sectionListRenderer?.contents ??
      [];

    for (const section of tabContents) {
      if (section?.musicShelfRenderer) {
        const parsed = this.parseMusicShelf(section.musicShelfRenderer);
        if (parsed.items.length > 0) sections.push(parsed);
      }
      if (section?.musicCarouselShelfRenderer) {
        const parsed = this.parseMusicCarousel(section.musicCarouselShelfRenderer);
        if (parsed.items.length > 0) sections.push(parsed);
      }
      if (section?.musicDescriptionShelfRenderer) {
        // Metadata section (like album description)
        continue;
      }
      if (section?.gridRenderer) {
        const parsed = this.parseGridRenderer(section.gridRenderer);
        if (parsed.items.length > 0) sections.push(parsed);
      }
      if (section?.musicPlaylistShelfRenderer) {
        const parsed = this.parseMusicPlaylistShelf(section.musicPlaylistShelfRenderer);
        if (parsed.items.length > 0) sections.push(parsed);
      }

      // Continuation
      if (section?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token) {
        continuationToken = section.continuationItemRenderer.continuationEndpoint.continuationCommand.token;
      }
    }

    // Continuation actions
    const commands = data.onResponseReceivedActions ?? [];
    for (const cmd of commands) {
      const items = cmd?.appendContinuationItemsAction?.continuationItems ?? [];
      for (const item of items) {
        if (item?.musicShelfRenderer) {
          const parsed = this.parseMusicShelf(item.musicShelfRenderer);
          if (parsed.items.length > 0) sections.push(parsed);
        }
        if (item?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token) {
          continuationToken = item.continuationItemRenderer.continuationEndpoint.continuationCommand.token;
        }
      }
    }

    return { sections, continuationToken, header };
  }

  private parseMusicShelf(shelf: any): MusicSection {
    const title = getText(shelf.title);
    const items: MusicItem[] = [];
    let continuationToken: string | undefined;

    for (const item of shelf.contents ?? []) {
      const parsed = this.parseMusicResponsiveItem(item?.musicResponsiveListItemRenderer);
      if (parsed) items.push(parsed);

      // Also handle two-row items (horizontal cards)
      const twoRow = item?.musicTwoRowItemRenderer;
      if (twoRow) {
        const parsed2 = this.parseTwoRowItem(twoRow);
        if (parsed2) items.push(parsed2);
      }
    }

    // Continuation from shelf
    const contTokens = shelf.continuations;
    if (Array.isArray(contTokens)) {
      for (const c of contTokens) {
        if (c?.nextContinuationData?.continuation) {
          continuationToken = c.nextContinuationData.continuation;
        }
        if (c?.reloadContinuationData?.continuation) {
          continuationToken = c.reloadContinuationData.continuation;
        }
      }
    }

    const browseId = shelf.bottomEndpoint?.browseEndpoint?.browseId;
    const params = shelf.bottomEndpoint?.browseEndpoint?.params;

    return { title, items, browseId, params, continuationToken };
  }

  private parseMusicCarousel(carousel: any): MusicSection {
    const title = getText(
      carousel.header?.musicCarouselShelfBasicHeaderRenderer?.title,
    );
    const items: MusicItem[] = [];

    for (const item of carousel.contents ?? []) {
      const twoRow = item?.musicTwoRowItemRenderer;
      if (twoRow) {
        const parsed = this.parseTwoRowItem(twoRow);
        if (parsed) items.push(parsed);
      }

      const responsive = item?.musicResponsiveListItemRenderer;
      if (responsive) {
        const parsed = this.parseMusicResponsiveItem(responsive);
        if (parsed) items.push(parsed);
      }
    }

    const browseId =
      carousel.header?.musicCarouselShelfBasicHeaderRenderer?.moreContentButton
        ?.buttonRenderer?.navigationEndpoint?.browseEndpoint?.browseId;

    return { title, items, browseId };
  }

  private parseMusicPlaylistShelf(shelf: any): MusicSection {
    const items: MusicItem[] = [];
    let continuationToken: string | undefined;

    for (const item of shelf.contents ?? []) {
      const parsed = this.parseMusicResponsiveItem(item?.musicResponsiveListItemRenderer);
      if (parsed) items.push(parsed);
    }

    const contTokens = shelf.continuations;
    if (Array.isArray(contTokens)) {
      for (const c of contTokens) {
        if (c?.nextContinuationData?.continuation) {
          continuationToken = c.nextContinuationData.continuation;
        }
      }
    }

    return { title: undefined, items, continuationToken };
  }

  private parseGridRenderer(grid: any): MusicSection {
    const title = getText(grid.header?.gridHeaderRenderer?.title);
    const items: MusicItem[] = [];

    for (const item of grid.items ?? []) {
      const navItem = item?.musicNavigationButtonRenderer;
      if (navItem) {
        items.push({
          title: getText(navItem.buttonText),
          browseId: navItem.clickCommand?.browseEndpoint?.browseId,
          thumbnails: navItem.solid?.leftStripeColor
            ? undefined
            : undefined,
          itemType: 'playlist',
        });
      }
      const twoRow = item?.musicTwoRowItemRenderer;
      if (twoRow) {
        const parsed = this.parseTwoRowItem(twoRow);
        if (parsed) items.push(parsed);
      }
    }

    return { title, items };
  }

  // ==================== Item Parsers ====================

  private parseMusicResponsiveItem(item: any): MusicItem | null {
    if (!item) return null;

    const overlay = item.overlay?.musicItemThumbnailOverlayRenderer;
    const playNav = overlay?.content?.musicPlayButtonRenderer?.playNavigationEndpoint;
    const watchEndpoint = playNav?.watchEndpoint ?? item.navigationEndpoint?.watchEndpoint;
    const browseEndpoint = item.navigationEndpoint?.browseEndpoint;

    const videoId = watchEndpoint?.videoId;
    const playlistId = watchEndpoint?.playlistId;
    const browseId = browseEndpoint?.browseId;

    // Get title from first flex column
    const title = this.getFlexColumnText(item, 0);

    // Get artists/subtitle from second flex column
    const secondColumn = this.getFlexColumnRuns(item, 1);
    const artists: MusicItem['artists'] = [];
    let album: MusicItem['album'];
    let subtitle = '';
    let year: string | undefined;
    let views: string | undefined;

    if (secondColumn) {
      for (const run of secondColumn) {
        const text = run?.text;
        const browseId = run?.navigationEndpoint?.browseEndpoint?.browseId;

        if (!text || text === ' • ' || text === ' & ' || text === ', ' || text === ' · ') {
          subtitle += text ?? '';
          continue;
        }

        subtitle += text;

        if (browseId?.startsWith('UC')) {
          artists.push({ name: text, id: browseId });
        } else if (browseId?.startsWith('MPREb_')) {
          album = { name: text, id: browseId };
        } else if (/^\d{4}$/.test(text)) {
          year = text;
        } else if (text.includes('plays') || text.includes('views') || text.includes('listeners')) {
          views = text;
        } else if (!browseId && artists.length === 0) {
          artists.push({ name: text });
        }
      }
    }

    // Get duration from the last flex column or from fixed columns
    let duration: string | undefined;
    let durationSeconds: number | undefined;
    const thirdColumn = this.getFlexColumnText(item, 2);
    if (thirdColumn) {
      if (/\d+:\d+/.test(thirdColumn)) {
        duration = thirdColumn;
        durationSeconds = this.parseDuration(thirdColumn);
      }
    }

    // Also check fixed columns
    const fixedColumns = item.fixedColumns ?? [];
    for (const col of fixedColumns) {
      const colText = getText(
        col?.musicResponsiveListItemFixedColumnRenderer?.text,
      );
      if (colText && /\d+:\d+/.test(colText)) {
        duration = colText;
        durationSeconds = this.parseDuration(colText);
      }
    }

    // Detect explicit
    const badges = item.badges ?? item.subtitleBadges ?? [];
    const isExplicit = badges.some(
      (b: any) => b?.musicInlineBadgeRenderer?.icon?.iconType === 'MUSIC_EXPLICIT_BADGE',
    );

    // Thumbnails
    const thumbnails =
      item.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails ??
      item.thumbnail?.thumbnails;

    // Detect item type from browseId prefix
    let itemType: MusicItem['itemType'];
    if (browseId?.startsWith('MPREb_')) itemType = 'album';
    else if (browseId?.startsWith('UC')) itemType = 'artist';
    else if (browseId?.startsWith('VLPL') || browseId?.startsWith('VL')) itemType = 'playlist';
    else if (browseId?.startsWith('MPSP')) itemType = 'podcast';
    else if (videoId) itemType = playlistId ? 'song' : 'video';

    return {
      videoId,
      title,
      artists: artists.length > 0 ? artists : undefined,
      album,
      thumbnails,
      duration,
      durationSeconds,
      playlistId,
      isExplicit,
      year,
      views,
      browseId,
      itemType,
      subtitle: subtitle || undefined,
    };
  }

  private parseTwoRowItem(item: any): MusicItem | null {
    if (!item) return null;

    const title = getText(item.title);
    const subtitle = getText(item.subtitle);
    const thumbnails =
      item.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails ??
      item.thumbnail?.thumbnails;

    const navEndpoint = item.navigationEndpoint;
    const browseId = navEndpoint?.browseEndpoint?.browseId;
    const videoId = navEndpoint?.watchEndpoint?.videoId;
    const playlistId = navEndpoint?.watchEndpoint?.playlistId;

    // Parse subtitle runs for artist info
    const subtitleRuns = item.subtitle?.runs ?? [];
    const artists: MusicItem['artists'] = [];
    let year: string | undefined;

    for (const run of subtitleRuns) {
      const text = run?.text;
      const bId = run?.navigationEndpoint?.browseEndpoint?.browseId;
      if (!text || text === ' • ' || text === ' & ' || text === ', ' || text === ' · ') continue;
      if (bId?.startsWith('UC')) {
        artists.push({ name: text, id: bId });
      } else if (/^\d{4}$/.test(text)) {
        year = text;
      }
    }

    let itemType: MusicItem['itemType'];
    if (browseId?.startsWith('MPREb_')) itemType = 'album';
    else if (browseId?.startsWith('UC')) itemType = 'artist';
    else if (browseId?.startsWith('VL') || playlistId) itemType = 'playlist';
    else if (videoId) itemType = 'song';

    return {
      videoId,
      title,
      artists: artists.length > 0 ? artists : undefined,
      thumbnails,
      playlistId,
      year,
      browseId,
      itemType,
      subtitle,
    };
  }

  // ==================== Utilities ====================

  private getFlexColumnText(item: any, index: number): string | undefined {
    const cols = item?.flexColumns;
    if (!cols || index >= cols.length) return undefined;

    const renderer = cols[index]?.musicResponsiveListItemFlexColumnRenderer;
    return getText(renderer?.text);
  }

  private getFlexColumnRuns(item: any, index: number): any[] | undefined {
    const cols = item?.flexColumns;
    if (!cols || index >= cols.length) return undefined;

    const renderer = cols[index]?.musicResponsiveListItemFlexColumnRenderer;
    return renderer?.text?.runs;
  }

  private parseDuration(durationStr: string): number {
    const parts = durationStr.split(':').map(Number);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parts[0] ?? 0;
  }
}
