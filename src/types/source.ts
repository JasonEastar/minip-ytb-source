/**
 * Media Source Interface (SDK)
 *
 * Every media source must implement this interface.
 * Sources are standalone JS bundles that export a factory function:
 *
 *   export default function createSource(host: SourceHost): MediaSource { ... }
 */

import type {
  MediaCapabilities,
  MediaItem,
  AudioPlaybackInfo,
  MediaFeedSection,
  MediaCollection,
  SubtitleTrack,
  DownloadInfo,
  SearchResults,
  ArtistInfo,
} from './media';

export interface MediaSource {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly capabilities: MediaCapabilities;

  // ─── Lifecycle ──────────────────────────────────────────────

  initialize(): Promise<void>;
  dispose(): Promise<void>;

  // ─── Playback ───────────────────────────────────────────────

  /** Get a streaming URL for playback (may be HLS, DASH, or direct). */
  getStreamUrl(contentId: string): Promise<AudioPlaybackInfo>;

  /** Get a direct download URL + content length for offline caching. */
  getDownloadUrl(contentId: string): Promise<DownloadInfo>;

  // ─── Search ─────────────────────────────────────────────────

  search?(query: string): Promise<MediaItem[]>;
  searchGrouped?(query: string): Promise<SearchResults>;
  getSearchSuggestions?(query: string): Promise<string[]>;

  // ─── Feed ───────────────────────────────────────────────────

  getHomeFeed?(): Promise<MediaFeedSection[]>;

  // ─── Collections ────────────────────────────────────────────

  getCollection?(browseId: string): Promise<MediaCollection>;

  // ─── Artist / Channel ───────────────────────────────────────

  getArtist?(browseId: string): Promise<ArtistInfo>;

  // ─── Suggestions ────────────────────────────────────────────

  getSuggestions?(contentId: string): Promise<MediaItem[]>;

  // ─── Subtitles ──────────────────────────────────────────────

  getSubtitles?(contentId: string): Promise<SubtitleTrack[]>;

  // ─── Watch Progress ─────────────────────────────────────────

  reportProgress?(contentId: string, positionSeconds: number, durationSeconds: number): void;
  getWatchProgress?(contentId: string): number;
}

export type SourceFactory = (host: import('./host').SourceHost) => MediaSource;
