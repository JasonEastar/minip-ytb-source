/**
 * ytbapi - Unofficial YouTube InnerTube API client
 *
 * Works on both Node.js and React Native.
 *
 * @example
 * ```typescript
 * import { InnertubeService } from 'ytbapi';
 *
 * const yt = new InnertubeService();
 *
 * // Get video streaming info
 * const info = await yt.getVideoInfo('dQw4w9WgXcQ');
 *
 * // Search
 * const results = await yt.search('never gonna give you up');
 * const videos = await yt.searchVideos('lofi beats');
 * const channels = await yt.searchChannels('rick astley');
 * ```
 */

// Main service
export { InnertubeService } from './innertube.js';
export type { InnertubeServiceOptions } from './innertube.js';

// Browse & Search
export { BrowseService, BROWSE_IDS, CHANNEL_PARAMS, SEARCH_FILTERS, SearchFilter } from './browse.js';
export type {
  BrowseItem,
  BrowseSection,
  BrowseResponse,
  SearchResponse,
  SearchSuggestion,
  SearchFilterOptions,
  SearchUploadDate,
  SearchDuration,
  SearchType,
  SearchFeature,
  SearchSortBy,
} from './browse.js';

// Session
export { Session } from './session.js';
export type { SessionData, SessionSnapshot, SessionCacheAdapter } from './session.js';

// HTTP adapter (for custom networking)
export { FetchHttpAdapter } from './http.js';
export type { HttpAdapter, HttpResponse } from './http.js';

// HTTP Client
export { HTTPClient, createRequestBody } from './http-client.js';
export type { RequestInit, RequestBody } from './http-client.js';

// Types
export type {
  PlayerResult,
  PlayabilityStatus,
  StreamingData,
  StreamingFormat,
  FormatRange,
  VideoDetails,
  TextItem,
  ThumbnailItem,
  CaptionTrack,
  TranslationLanguage,
  MediaFormat,
  MediaItemFormatInfo,
  MediaSubtitle,
  SessionOptions,
  SessionArgs,
  DeviceInfo,
  InnertubeConfigResult,
} from './types.js';

export {
  FORMAT_TYPE_REGULAR,
  FORMAT_TYPE_DASH,
  FORMAT_TYPE_SABR,
} from './types.js';

// Context
export { buildInnertubeContext } from './context.js';
export type { InnertubeContext, InnertubeClient } from './context.js';

// Constants
export { URLS, CLIENTS, CLIENT_NAME_IDS, SUPPORTED_CLIENTS } from './constants.js';
export type { ClientConfig } from './constants.js';

// Utilities
export {
  getStringBetweenStrings,
  escapeStringRegexp,
  generateRandomString,
  UrlQueryString,
} from './utils.js';

// Format helpers
export {
  getText,
  buildFormatInfo,
  toMediaFormat,
  toMediaSubtitle,
  getAdaptiveFormats,
  getLegacyFormats,
  getPlayabilityStatus,
  getPlayabilityReason,
  getStoryboardSpec,
  getVideoPlaybackUstreamerConfig,
  getServerAbrStreamingUrl,
  getLoudnessDb,
} from './format-helpers.js';
