/**
 * YouTube Source — Standalone Bundle Entry Point
 *
 * This file is the entry point for building the YouTube source as a
 * standalone JS bundle. It uses ONLY the SourceHost APIs (no @/ imports).
 *
 * Build: rollup bundles this + ytbapi into a single JS file.
 *
 * Bundle format:
 *   module.exports = function createSource(host) { ... return source; }
 */

import { InnertubeService } from './ytbapi';
import type { SourceHost } from './types/host';
import type { MediaSource } from './types/source';
import type {
  MediaItem,
  AudioPlaybackInfo,
  MediaFeedSection,
  MediaFeedItem,
  MediaCollection,
  DownloadInfo,
  SearchResults,
  SearchArtistResult,
  ArtistInfo,
  ArtistSection,
} from './types/media';

const SOURCE_ID = 'youtube';

// ─── Factory ────────────────────────────────────────────────────

export default function createYouTubeSource(host: SourceHost): MediaSource {
  let yt: InnertubeService;

  // ── Video Info Cache ────────────────────────────────────────

  type VideoInfoCache = { contentId: string; info: any };
  let _videoInfoCache: VideoInfoCache | null = null;

  async function getCachedVideoInfo(contentId: string): Promise<any> {
    if (_videoInfoCache?.contentId === contentId) {
      return _videoInfoCache.info;
    }
    // IOS client gives direct URLs — no deciphering needed
    const info = await yt.getVideoInfo(contentId, 'IOS');
    if (info) _videoInfoCache = { contentId, info };
    return info;
  }

  // ── Source Implementation ───────────────────────────────────

  const source: MediaSource = {
    id: SOURCE_ID,
    name: 'YouTube Music',
    version: '1.0.0',
    capabilities: {
      audio: true,
      video: true,
      search: true,
      feed: true,
      suggestions: true,
      playlists: true,
      movies: false,
      subtitles: false,
    },

    async initialize(): Promise<void> {
      yt = new InnertubeService({
        disableDecipher: true, // IOS client provides direct URLs
      });
    },

    async dispose(): Promise<void> {
      yt.invalidateSession();
    },

    // ── Playback ──────────────────────────────────────────────

    async getStreamUrl(contentId: string): Promise<AudioPlaybackInfo> {
      const info = await getCachedVideoInfo(contentId);
      if (!info) throw new Error('Failed to get video info for ' + contentId);

      const headers = { 'User-Agent': 'com.google.ios.youtube/20.11.6 (iPhone10,4; U; CPU iOS 16_7_7 like Mac OS X)' };

      // iOS: prefer HLS (native audio streaming support)
      if (host.platform === 'ios' && info.hlsManifestUrl) {
        host.log('Using HLS for', contentId);
        return { url: info.hlsManifestUrl, headers, isHLS: true };
      }

      // Direct audio-only from adaptive formats
      const audioFormats = (info.adaptiveFormats ?? [])
        .filter((f: any) => f.url && f.mimeType?.startsWith('audio/'))
        .sort((a: any, b: any) => parseInt(b.bitrate || '0') - parseInt(a.bitrate || '0'));

      if (audioFormats.length > 0) {
        host.log('Using direct audio for', contentId, `(${audioFormats[0].mimeType})`);
        return { url: audioFormats[0].url, headers };
      }

      // Muxed formats fallback
      const urlFormats = (info.urlFormats ?? []).filter((f: any) => f.url);
      if (urlFormats.length > 0) {
        return { url: urlFormats[0].url, headers };
      }

      throw new Error('No audio format available for ' + contentId);
    },

    async getDownloadUrl(contentId: string): Promise<DownloadInfo> {
      const info = await getCachedVideoInfo(contentId);
      if (!info) throw new Error('Failed to get video info for ' + contentId);

      const audioFormats = (info.adaptiveFormats ?? [])
        .filter((f: any) => f.url && f.mimeType?.startsWith('audio/'))
        .sort((a: any, b: any) => parseInt(b.bitrate || '0') - parseInt(a.bitrate || '0'));

      if (audioFormats.length > 0) {
        return {
          url: audioFormats[0].url,
          contentLength: parseInt(audioFormats[0].contentLength || '0'),
          headers: { 'User-Agent': 'com.google.ios.youtube/20.11.6 (iPhone10,4; U; CPU iOS 16_7_7 like Mac OS X)' },
        };
      }
      throw new Error('No audio format available for download');
    },

    // ── Search ────────────────────────────────────────────────

    async search(query: string): Promise<MediaItem[]> {
      const results = await yt.search(query, { type: 'video' });
      if (!results) return [];

      return results.items
        .filter((v) => v.videoId)
        .map((v): MediaItem => ({
          id: v.videoId!,
          sourceId: SOURCE_ID,
          type: 'track',
          title: v.title || 'Unknown',
          artist: v.channelName || 'Unknown',
          artwork: getBestThumbnail(v.thumbnails),
          duration: parseDuration(v.lengthText),
          contentId: v.videoId!,
        }));
    },

    async getSearchSuggestions(query: string): Promise<string[]> {
      try {
        const suggestions = await yt.getSearchSuggestions(query);
        return suggestions.map((s) => s.text);
      } catch { return []; }
    },

    async searchGrouped(query: string): Promise<SearchResults> {
      const tracks: MediaItem[] = [];
      const artists: SearchArtistResult[] = [];

      try {
        const videoResults = await yt.search(query, { type: 'video' });
        if (videoResults) {
          for (const v of videoResults.items) {
            if (!v.videoId) continue;
            tracks.push({
              id: v.videoId,
              sourceId: SOURCE_ID,
              type: 'track',
              title: v.title || 'Unknown',
              artist: v.channelName || 'Unknown',
              artwork: getBestThumbnail(v.thumbnails),
              duration: parseDuration(v.lengthText),
              contentId: v.videoId,
            });
          }
        }

        const channelResults = await yt.search(query, { type: 'channel' });
        if (channelResults) {
          for (const ch of channelResults.items) {
            if (!ch.channelId) continue;
            artists.push({
              id: ch.channelId,
              name: ch.title || 'Unknown',
              thumbnail: ch.channelThumbnail || getBestThumbnail(ch.thumbnails),
              sourceId: SOURCE_ID,
              browseId: ch.channelId,
            });
          }
        }
      } catch (e) {
        host.log('searchGrouped error:', e);
      }

      return { tracks, artists };
    },

    // ── Feed ──────────────────────────────────────────────────

    async getHomeFeed(): Promise<MediaFeedSection[]> {
      try {
        const home = await yt.getHome();
        if (!home) return [];

        const sections: MediaFeedSection[] = [];
        for (const section of home.sections) {
          if (!section.title) continue;
          const items: MediaFeedItem[] = [];
          for (const item of section.items) {
            if (!item.videoId && !item.playlistId) continue;
            items.push({
              id: item.videoId || item.playlistId || item.title || '',
              title: item.title || '',
              subtitle: item.channelName || '',
              thumbnail: getBestThumbnail(item.thumbnails),
              type: item.playlistId ? 'playlist' : 'song',
              trackId: item.videoId || undefined,
              browseId: item.playlistId || undefined,
            });
          }
          if (items.length > 0) {
            sections.push({ title: section.title, type: 'shelf', items, sourceId: SOURCE_ID });
          }
        }
        return sections;
      } catch (e) {
        host.log('getHomeFeed error:', e);
        return [];
      }
    },

    // ── Collections ───────────────────────────────────────────

    async getCollection(browseId: string): Promise<MediaCollection> {
      const playlist = await yt.getPlaylist(browseId);
      if (!playlist) return { title: 'Playlist', subtitle: '', thumbnail: '', items: [] };

      const items: MediaItem[] = [];
      for (const section of playlist.sections) {
        for (const item of section.items) {
          if (!item.videoId) continue;
          items.push({
            id: item.videoId,
            sourceId: SOURCE_ID,
            type: 'track',
            title: item.title || '',
            artist: item.channelName || 'Unknown',
            artwork: getBestThumbnail(item.thumbnails),
            duration: parseDuration(item.lengthText),
            contentId: item.videoId,
          });
        }
      }

      return {
        title: playlist.channelMeta?.title || 'Playlist',
        subtitle: '',
        thumbnail: getBestThumbnail(playlist.channelMeta?.thumbnails),
        items,
        collectionType: 'playlist',
      };
    },

    // ── Artist / Channel ──────────────────────────────────────

    async getArtist(browseId: string): Promise<ArtistInfo> {
      const channel = await yt.getChannelHome(browseId);
      if (!channel) return { id: browseId, name: 'Unknown', thumbnail: '', sections: [], sourceId: SOURCE_ID };

      const sections: ArtistSection[] = [];
      for (const section of channel.sections) {
        const sectionTitle = section.title || '';
        const items: MediaFeedItem[] = [];
        for (const item of section.items) {
          items.push({
            id: item.videoId || item.playlistId || item.title || '',
            title: item.title || '',
            subtitle: item.channelName || '',
            thumbnail: getBestThumbnail(item.thumbnails),
            type: item.playlistId ? 'playlist' : 'song',
            trackId: item.videoId || undefined,
            browseId: item.playlistId || undefined,
          });
        }
        if (items.length > 0) {
          const titleLower = sectionTitle.toLowerCase();
          let sectionType: ArtistSection['type'] = 'other';
          if (titleLower.includes('video')) sectionType = 'videos';
          else if (titleLower.includes('playlist')) sectionType = 'playlists';
          else if (titleLower.includes('single')) sectionType = 'singles';
          else if (titleLower.includes('album')) sectionType = 'albums';
          else if (titleLower.includes('song')) sectionType = 'songs';

          sections.push({ title: sectionTitle, type: sectionType, items });
        }
      }

      return {
        id: browseId,
        name: channel.channelMeta?.title || 'Unknown',
        description: channel.channelMeta?.description || undefined,
        thumbnail: getBestThumbnail(channel.channelMeta?.thumbnails),
        subscribers: channel.channelMeta?.subscriberCount || undefined,
        sections,
        sourceId: SOURCE_ID,
      };
    },

    // ── Suggestions ───────────────────────────────────────────

    async getSuggestions(contentId: string): Promise<MediaItem[]> {
      // Strategy 1: related videos via /next endpoint
      try {
        const related = await yt.getRelatedVideos(contentId);
        if (related) {
          const tracks: MediaItem[] = [];
          for (const section of related.sections) {
            for (const item of section.items) {
              if (!item.videoId || item.videoId === contentId) continue;
              tracks.push({
                id: item.videoId,
                sourceId: SOURCE_ID,
                type: 'track',
                title: item.title || 'Unknown',
                artist: item.channelName || 'Unknown',
                artwork: getBestThumbnail(item.thumbnails) || `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`,
                duration: parseDuration(item.lengthText),
                contentId: item.videoId,
              });
            }
          }
          if (tracks.length > 0) return tracks.slice(0, 20);
        }
      } catch { /* fall through to search */ }

      // Strategy 2: search fallback
      try {
        const info = await getCachedVideoInfo(contentId);
        let searchQuery = contentId;
        if (info?.title) {
          searchQuery = `${info.title} ${info.author || ''}`.trim();
        }
        const sr = await yt.search(searchQuery, { type: 'video' });
        if (sr) {
          return sr.items
            .filter((v) => v.videoId && v.videoId !== contentId)
            .slice(0, 20)
            .map((v): MediaItem => ({
              id: v.videoId!,
              sourceId: SOURCE_ID,
              type: 'track',
              title: v.title || 'Unknown',
              artist: v.channelName || 'Unknown',
              artwork: getBestThumbnail(v.thumbnails),
              duration: parseDuration(v.lengthText),
              contentId: v.videoId!,
            }));
        }
      } catch { /* give up */ }
      return [];
    },
  };

  return source;

  // ─── Internal Helpers ───────────────────────────────────────

  function parseDuration(text?: string): number {
    if (!text) return 0;
    const parts = text.split(':').map(Number);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return 0;
  }

  function getBestThumbnail(thumbnails?: Array<{ url: string; width?: number; height?: number }>): string {
    if (!Array.isArray(thumbnails) || thumbnails.length === 0) return '';
    let url = thumbnails[thumbnails.length - 1]?.url ?? '';
    // YouTube sometimes returns protocol-relative URLs (//yt3.ggpht.com/...)
    if (url.startsWith('//')) url = 'https:' + url;
    return url;
  }
}
