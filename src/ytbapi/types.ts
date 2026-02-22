/**
 * TypeScript interfaces for YouTube InnerTube API responses
 * Migrated from PlayerResult.kt, SessionDataResult.kt, InnertubeConfigResult.kt, etc.
 */

// ==================== PlayerResult ====================

export interface PlayerResult {
  playabilityStatus?: PlayabilityStatus;
  streamingData?: StreamingData;
  playerConfig?: PlayerConfig;
  captions?: Captions;
  videoDetails?: VideoDetails;
  storyboards?: Storyboards;
  microformat?: Microformat;
  paidContentOverlay?: PaidContentOverlay;
  playbackTracking?: PlaybackTracking;
}

export interface PlayabilityStatus {
  status?: string;
  reason?: string;
  playableInEmbed?: boolean;
  errorScreen?: {
    playerLegacyDesktopYpcTrailerRenderer?: {
      trailerVideoId?: string;
    };
    playerErrorMessageRenderer?: {
      subreason?: TextItem;
    };
  };
}

export interface PlayerConfig {
  mediaCommonConfig?: {
    mediaUstreamerRequestConfig?: {
      videoPlaybackUstreamerConfig?: string;
    };
  };
  audioConfig?: {
    loudnessDb?: number;
  };
}

export interface Captions {
  playerCaptionsTracklistRenderer?: {
    captionTracks?: CaptionTrack[];
    translationLanguages?: TranslationLanguage[];
  };
}

export interface CaptionTrack {
  baseUrl?: string;
  isTranslatable?: boolean;
  languageCode?: string;
  vssId?: string;
  name?: TextItem;
  kind?: string;
}

export interface TranslationLanguage {
  languageCode?: string;
  languageName?: TextItem;
}

export interface Storyboards {
  playerStoryboardSpecRenderer?: { spec?: string };
  playerLiveStoryboardSpecRenderer?: { spec?: string };
}

export interface Microformat {
  playerMicroformatRenderer?: {
    liveBroadcastDetails?: {
      startTimestamp?: string;
    };
    uploadDate?: string;
  };
}

export interface PaidContentOverlay {
  paidContentOverlayRenderer?: {
    text?: TextItem;
  };
}

export interface PlaybackTracking {
  videostatsPlaybackUrl?: { baseUrl?: string };
  videostatsWatchtimeUrl?: { baseUrl?: string };
}

// ==================== StreamingData ====================

export interface StreamingData {
  expiresInSeconds?: string;
  formats?: StreamingFormat[];
  adaptiveFormats?: StreamingFormat[];
  serverAbrStreamingUrl?: string;
  hlsManifestUrl?: string;
  dashManifestUrl?: string;
}

export interface StreamingFormat {
  itag?: number;
  mimeType?: string;
  bitrate?: number;
  width?: number;
  height?: number;
  lastModified?: string;
  contentLength?: string;
  quality?: string;
  fps?: number;
  qualityLabel?: string;
  projectionType?: string;
  averageBitrate?: number;
  approxDurationMs?: string;
  targetDurationSec?: number;
  maxDvrDurationSec?: number;
  qualityOrdinal?: string;
  // audio
  highReplication?: boolean;
  audioSampleRate?: string;
  audioChannels?: number;
  loudnessDb?: number;
  trackAbsoluteLoudnessLkfs?: number;
  isDrc?: boolean;
  type?: string; // OTF
  // DASH values
  url?: string;
  cipher?: string;
  signatureCipher?: string;
  // LegacyFormat
  audioQuality?: string;
  // AdaptiveFormat
  initRange?: FormatRange;
  indexRange?: FormatRange;
}

export interface FormatRange {
  start?: string;
  end?: string;
}

// ==================== VideoDetails ====================

export interface VideoDetails {
  lengthSeconds?: string;
  title?: string;
  channelId?: string;
  videoId?: string;
  shortDescription?: string;
  viewCount?: string;
  author?: string;
  isLive?: boolean;
  isLiveContent?: boolean;
  isOwnerViewing?: boolean;
  thumbnail?: ThumbnailItem;
  isLowLatencyLiveStream?: boolean;
}

// ==================== Common Items ====================

export interface TextItem {
  simpleText?: string;
  runs?: Array<{ text?: string }>;
  accessibility?: {
    accessibilityData?: {
      label?: string;
    };
  };
  content?: string;
}

export interface ThumbnailItem {
  thumbnails?: Array<{
    url: string;
    width?: number;
    height?: number;
  }>;
}

// ==================== Session Data ====================

export interface SessionDataResult {
  /** Raw sw.js_data array */
  raw: any[];
  ytcfg?: {
    apiKey?: string;
    deviceInfo?: DeviceInfo;
  };
}

export interface DeviceInfo {
  hl?: string;
  gl?: string;
  remoteHost?: string;
  visitorData?: string;
  clientVersion?: string;
  osName?: string;
  osVersion?: string;
  appInstallData?: string;
  timeZone?: string;
  browserName?: string;
  browserVersion?: string;
  deviceMake?: string;
  deviceModel?: string;
  deviceExperimentId?: string;
  rolloutToken?: string;
}

// ==================== InnertubeConfigResult ====================

export interface InnertubeConfigResult {
  responseContext?: {
    globalConfigGroup?: {
      rawColdConfigGroup?: {
        configData?: string;
      };
      coldHashData?: string;
      hotHashData?: string;
    };
  };
  configData?: string;
}

// ==================== MediaFormat (output) ====================

export const FORMAT_TYPE_REGULAR = 0;
export const FORMAT_TYPE_DASH = 1;
export const FORMAT_TYPE_SABR = 2;

export interface MediaFormat {
  formatType: number;
  url?: string;
  mimeType?: string;
  itag: string;
  isDrc: boolean;
  contentLength?: string;
  bitrate: string;
  projectionType?: string;
  width: number;
  height: number;
  initRange?: string;
  indexRange?: string;
  fps: string;
  lastModified?: string;
  qualityLabel?: string;
  format?: string; // OTF type
  isOtf: boolean;
  targetDurationSec: number;
  maxDvrDurationSec: number;
  approxDurationMs: number;
  audioQuality?: string;
  audioSampleRate?: string;
  audioChannels?: number;
}

// ==================== MediaItemFormatInfo (output) ====================

export interface MediaItemFormatInfo {
  videoId?: string;
  title?: string;
  author?: string;
  channelId?: string;
  viewCount?: string;
  description?: string;
  lengthSeconds?: string;
  isLive: boolean;
  isLiveContent: boolean;
  isUnplayable: boolean;
  playabilityReason?: string;
  adaptiveFormats?: MediaFormat[];
  urlFormats?: MediaFormat[];
  subtitles?: MediaSubtitle[];
  hlsManifestUrl?: string;
  dashManifestUrl?: string;
  serverAbrStreamingUrl?: string;
  storyboardSpec?: string;
  loudnessDb: number;
  volumeLevel: number;
  startTimestamp?: string;
  uploadDate?: string;
  eventId?: string;
  visitorMonitoringData?: string;
  ofParam?: string;
  poToken?: string;
  thumbnails?: Array<{ url: string; width?: number; height?: number }>;
}

export interface MediaSubtitle {
  baseUrl?: string;
  languageCode?: string;
  name?: string;
  isTranslatable?: boolean;
  isAutogenerated: boolean;
  mimeType: string;
  codecs: string;
}

// ==================== Session ====================

export interface SessionOptions {
  lang?: string;
  location?: string;
  userAgent?: string;
  poToken?: string;
  playerId?: string;
  retrieveInnertubeConfig?: boolean;
  accountIndex?: number;
  cookie?: string;
  /**
   * External cache adapter for persisting session data across app launches.
   * Implement `SessionCacheAdapter` to use AsyncStorage, localStorage, SQLite, etc.
   */
  sessionCache?: import('./session.js').SessionCacheAdapter;
  /**
   * Skip fetching the player JS (~1MB download). Set to `true` if you don't need
   * signatureTimestamp (e.g., when using iOS/Android client for direct URLs).
   * Saves ~300-500ms on cold start.
   */
  skipPlayerFetch?: boolean;
  /**
   * Maximum age of a cached session snapshot in milliseconds.
   * Default: 6 hours (21600000ms). After this, a fresh session is created.
   */
  maxSessionAge?: number;
}

export interface SessionArgs {
  lang?: string;
  location?: string;
  visitorData?: string;
  clientName: string;
  userAgent: string;
  deviceCategory: string;
  timeZone: string;
  enableSafetyMode: boolean;
  onBehalfOfUser?: string;
}
