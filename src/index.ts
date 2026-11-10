/**
 * YouTube Source — Standalone Bundle Entry Point
 *
 * This file is the entry point for building the YouTube source as a
 * standalone JS bundle. It uses ONLY the SourceHost APIs (no @/ imports).
 *
 * Build: rollup bundles this + youtubei.js + the browse adapter into a single
 * JS file.
 *
 * Bundle format:
 *   module.exports = function createSource(host) { ... return source; }
 */

import { ClientType, Innertube, Platform } from 'youtubei.js/react-native';
import { FetchHttpAdapter, InnertubeService } from './ytbapi';
import { id, name, version, capabilities } from '../manifest.json';
import {
  buildIndexedHlsPlaylist,
  coalesceHlsSegments,
  parseSidxSegments,
} from './indexed-hls-playlist';
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

const SOURCE_ID = id;
const VIDEO_INFO_CACHE_MS = 4 * 60 * 1000;
const MEDIA_PROBE_TIMEOUT_MS = 10 * 1000;
const DOWNLOAD_RANGE_HEADER = 'bytes=0-';
const IOS_USER_AGENT =
  'com.google.ios.youtube/20.11.6 (iPhone10,4; U; CPU iOS 16_7_7 like Mac OS X)';
const ANDROID_VR_USER_AGENT =
  'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip';
const VISIONOS_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
const WEB_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
type MediaClient = 'VISIONOS' | 'YTKIDS' | 'ANDROID_VR' | 'IOS';
type OfficialVideoInfo = Awaited<ReturnType<Innertube['getBasicInfo']>>;
type OfficialFormat = NonNullable<OfficialVideoInfo['streaming_data']>['adaptive_formats'][number];
type VerifiedDirectAudio = {
  client: MediaClient | 'YTMUSIC';
  format: OfficialFormat;
  headers: Record<string, string>;
};
type CachedPoToken = { token: string; expiresAt: number };

// VisionOS currently returns complete token-free URLs for regular videos,
// while the Kids client does the same for made-for-kids videos such as Baby
// Shark. Keep the older mobile clients as fallbacks because availability is
// content-dependent.
const MEDIA_CLIENTS: readonly MediaClient[] = ['VISIONOS', 'YTKIDS', 'ANDROID_VR', 'IOS'];
const MEDIA_USER_AGENTS: Record<MediaClient, string> = {
  VISIONOS: VISIONOS_USER_AGENT,
  YTKIDS: WEB_USER_AGENT,
  ANDROID_VR: ANDROID_VR_USER_AGENT,
  IOS: IOS_USER_AGENT,
};

// ─── Factory ────────────────────────────────────────────────────

export default function createYouTubeSource(host: SourceHost): MediaSource {
  let yt: InnertubeService;
  let mediaYt: Innertube | null = null;

  // ── Video Info Cache ────────────────────────────────────────

  type VideoInfoCache = { contentId: string; info: any; cachedAt: number };
  let _videoInfoCache: VideoInfoCache | null = null;
  const _officialVideoInfoCache = new Map<
    MediaClient,
    {
      contentId: string;
      info: OfficialVideoInfo;
      cachedAt: number;
    }
  >();
  const _poTokenCache = new Map<string, CachedPoToken>();

  async function getCachedVideoInfo(contentId: string): Promise<any> {
    if (
      _videoInfoCache?.contentId === contentId &&
      Date.now() - _videoInfoCache.cachedAt < VIDEO_INFO_CACHE_MS
    ) {
      return _videoInfoCache.info;
    }
    // IOS client gives direct URLs — no deciphering needed
    const info = await yt.getVideoInfo(contentId, 'IOS');
    if (info) {
      _videoInfoCache = { contentId, info, cachedAt: Date.now() };
    }
    return info;
  }

  async function getOfficialVideoInfo(
    contentId: string,
    client: MediaClient,
    useCache: boolean
  ): Promise<OfficialVideoInfo> {
    if (!mediaYt) {
      throw new Error('YouTube.js media client is unavailable');
    }
    const cached = _officialVideoInfoCache.get(client);
    if (
      useCache &&
      cached?.contentId === contentId &&
      Date.now() - cached.cachedAt < VIDEO_INFO_CACHE_MS
    ) {
      return cached.info;
    }

    const info = await mediaYt.getBasicInfo(contentId, { client });
    if (useCache) {
      _officialVideoInfoCache.set(client, { contentId, info, cachedAt: Date.now() });
    }
    return info;
  }

  const mediaFetch: typeof globalThis.fetch = async (input, init) => {
    let headers = init?.headers;
    if (typeof init?.body === 'string') {
      try {
        const payload = JSON.parse(init.body);
        const clientName = payload?.context?.client?.clientName;
        const userAgent =
          clientName === 'ANDROID_VR'
            ? ANDROID_VR_USER_AGENT
            : clientName === 'iOS'
              ? IOS_USER_AGENT
              : clientName === 'VISIONOS'
                ? VISIONOS_USER_AGENT
                : clientName === 'WEB' || clientName === 'WEB_REMIX' || clientName === 'WEB_KIDS'
                  ? WEB_USER_AGENT
                  : undefined;
        if (userAgent) {
          const adjustedHeaders = new Headers(headers);
          adjustedHeaders.set('User-Agent', userAgent);
          headers = adjustedHeaders;
        }
      } catch {
        // Non-JSON requests pass through unchanged.
      }
    }
    return host.fetch(input, { ...init, headers });
  };

  function selectAudioFormats(info: OfficialVideoInfo): OfficialFormat[] {
    return (info.streaming_data?.adaptive_formats ?? [])
      .filter((format) => format.has_audio && !format.has_video)
      .sort((a, b) => {
        // Cache files use an m4a extension, so prefer AAC/MP4 over Opus/WebM.
        const aIsMp4 = a.mime_type.includes('audio/mp4') ? 1 : 0;
        const bIsMp4 = b.mime_type.includes('audio/mp4') ? 1 : 0;
        if (aIsMp4 !== bIsMp4) return bIsMp4 - aIsMp4;
        return (b.bitrate || 0) - (a.bitrate || 0);
      });
  }

  function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  function createRequestId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  }

  async function probeProtectedMediaInBrowser(url: string, offset: number): Promise<boolean> {
    if (!host.youtube?.evaluatePlayerScript) return false;

    try {
      const range = `bytes=${offset}-${offset}`;
      const result = await host.youtube.evaluatePlayerScript({
        requestId: createRequestId(),
        output: `return fetch(${JSON.stringify(url)}, { headers: { Range: ${JSON.stringify(
          range
        )} } }).then(async function(response) {
          if (response.body && response.body.cancel) await response.body.cancel();
          return { status: response.status };
        });`,
      });
      return result.status === 206;
    } catch {
      return false;
    }
  }

  async function getContentPoToken(contentId: string, forceNew = false): Promise<string> {
    const cached = _poTokenCache.get(contentId);
    if (!forceNew && cached && cached.expiresAt > Date.now()) return cached.token;

    if (!mediaYt) throw new Error('YouTube.js media client is unavailable');
    if (!host.youtube?.generatePoToken) {
      throw new Error('This MiniP version does not provide YouTube browser attestation');
    }

    const response = await mediaYt.getAttestationChallenge('ENGAGEMENT_TYPE_UNBOUND');
    const challenge = response.bg_challenge;
    const interpreterUrl =
      challenge?.interpreter_url?.private_do_not_access_or_else_trusted_resource_url_wrapped_value;
    if (!challenge || !interpreterUrl) {
      throw new Error('YouTube did not return a usable BotGuard challenge');
    }

    const result = await host.youtube.generatePoToken({
      requestId: createRequestId(),
      interpreterUrl: interpreterUrl.startsWith('//') ? `https:${interpreterUrl}` : interpreterUrl,
      program: challenge.program,
      globalName: challenge.global_name,
      contentBindings: [contentId],
    });
    const token = result.tokens[contentId];
    if (!token) throw new Error('YouTube attestation did not mint a content token');

    _poTokenCache.set(contentId, { token, expiresAt: result.expiresAt });
    return token;
  }

  async function resolveProtectedWebAudio(
    contentId: string,
    forceToken = false
  ): Promise<VerifiedDirectAudio> {
    if (!mediaYt) throw new Error('YouTube.js media client is unavailable');

    const token = await getContentPoToken(contentId, forceToken);
    // Send the content-bound token with the player request as well as the
    // eventual media URL. Newer YouTube clients can withhold protected
    // formats unless serviceIntegrityDimensions is present on /player.
    const info = await mediaYt.getBasicInfo(contentId, {
      client: 'YTMUSIC',
      po_token: token,
    });
    const formats = (info.streaming_data?.adaptive_formats ?? [])
      .filter((format) => format.has_audio && !format.has_video)
      .sort((a, b) => {
        const aIsMp4 = a.mime_type.includes('audio/mp4') ? 1 : 0;
        const bIsMp4 = b.mime_type.includes('audio/mp4') ? 1 : 0;
        if (aIsMp4 !== bIsMp4) return bIsMp4 - aIsMp4;
        return (b.bitrate || 0) - (a.bitrate || 0);
      });
    if (formats.length === 0) {
      const reason =
        info.playability_status?.reason || info.playability_status?.status || 'no audio formats';
      throw new Error(`YTMUSIC player did not return audio formats (${reason})`);
    }
    const failures: string[] = [];

    for (const format of formats) {
      try {
        if (!mediaYt.session.player) throw new Error('YouTube player script is unavailable');
        const decipheredUrl = await format.decipher(mediaYt.session.player);
        const separator = decipheredUrl.includes('?') ? '&' : '?';
        const url = `${decipheredUrl}${separator}pot=${encodeURIComponent(token)}`;
        const contentLength = format.content_length ?? 0;
        const probeOffsets = [0];
        if (contentLength > 2) {
          probeOffsets.push(Math.floor(contentLength / 2), contentLength - 1);
        }

        let verified = true;
        for (const offset of probeOffsets) {
          const probe = await host.fetch(url, {
            headers: {
              Range: `bytes=${offset}-${offset}`,
              'User-Agent': WEB_USER_AGENT,
            },
          });
          const ok = probe.status === 206 || (await probeProtectedMediaInBrowser(url, offset));
          await probe.body?.cancel();
          if (!ok) {
            failures.push(`itag ${format.itag} offset ${offset}: HTTP ${probe.status}`);
            verified = false;
            break;
          }
        }
        if (!verified) continue;

        return {
          client: 'YTMUSIC',
          format: { ...format, url } as OfficialFormat,
          headers: { 'User-Agent': WEB_USER_AGENT },
        };
      } catch (error) {
        failures.push(`itag ${format.itag}: ${errorMessage(error)}`);
      }
    }

    throw new Error(`No verified PO-token audio URL (${failures.join('; ')})`);
  }

  async function probeMediaUrl(
    url: string,
    headers: Record<string, string>,
    useRange: boolean
  ): Promise<{ ok: boolean; status?: number; error?: string }> {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeout = setTimeout(() => controller?.abort(), MEDIA_PROBE_TIMEOUT_MS);

    try {
      const response = await host.fetch(url, {
        headers: {
          ...headers,
          ...(useRange ? { Range: 'bytes=0-0' } : {}),
        },
        ...(controller ? { signal: controller.signal } : {}),
      });
      return {
        ok: response.status === 200 || response.status === 206,
        status: response.status,
      };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function resolveVerifiedDirectAudio(
    contentId: string,
    useCache: boolean
  ): Promise<VerifiedDirectAudio> {
    if (!mediaYt) throw new Error('YouTube.js media client is unavailable');
    const player = mediaYt.session.player;
    const failures: string[] = [];

    // Try complete token-free clients before falling back to browser
    // attestation. Client availability varies by video and audience setting.
    for (const client of MEDIA_CLIENTS) {
      try {
        const info = await getOfficialVideoInfo(contentId, client, useCache);
        const formats = selectAudioFormats(info);
        if (formats.length === 0) {
          const reason =
            info.playability_status?.reason || info.playability_status?.status || 'no direct audio';
          failures.push(`${client}: ${reason}`);
          continue;
        }

        const headers = { 'User-Agent': MEDIA_USER_AGENTS[client] };
        for (const format of formats) {
          let mediaUrl = format.url;
          if (!mediaUrl) {
            try {
              if (!player) throw new Error('YouTube player script is unavailable');
              mediaUrl = await format.decipher(player);
            } catch (error) {
              failures.push(`${client} itag ${format.itag}: ${errorMessage(error)}`);
              continue;
            }
          }

          const probe = await probeMediaUrl(mediaUrl, headers, true);
          if (probe.ok) {
            const qualificationRanges = ['bytes=0-'];
            const contentLength = format.content_length ?? 0;
            if (contentLength > 2) {
              const middle = Math.floor(contentLength / 2);
              qualificationRanges.push(
                `bytes=${middle}-${middle}`,
                `bytes=${contentLength - 1}-${contentLength - 1}`
              );
            }

            let qualified = true;
            for (const range of qualificationRanges) {
              const rangeProbe = await host.fetch(mediaUrl, {
                headers: { ...headers, Range: range },
              });
              const rangeOk = rangeProbe.status === 206;
              await rangeProbe.body?.cancel();
              if (!rangeOk) {
                failures.push(`${client} itag ${format.itag} ${range}: HTTP ${rangeProbe.status}`);
                qualified = false;
                break;
              }
            }
            if (qualified) {
              return {
                client,
                format: { ...format, url: mediaUrl } as OfficialFormat,
                headers,
              };
            }
            continue;
          }

          failures.push(
            `${client} itag ${format.itag}: ${
              probe.status ? `HTTP ${probe.status}` : probe.error || 'request failed'
            }`
          );
        }
      } catch (error) {
        failures.push(`${client}: ${errorMessage(error)}`);
      }
    }

    throw new Error(`No verified direct audio URL (${failures.join('; ')})`);
  }

  async function createIndexedHlsStream(
    contentId: string,
    resolved: VerifiedDirectAudio
  ): Promise<AudioPlaybackInfo | null> {
    const { format, headers } = resolved;
    const mediaUrl = format.url;
    const initRange = format.init_range;
    const indexRange = format.index_range;
    if (
      !mediaUrl ||
      !format.mime_type.includes('audio/mp4') ||
      !initRange ||
      !indexRange ||
      indexRange.end < indexRange.start
    ) {
      return null;
    }

    const response = await host.fetch(mediaUrl, {
      headers: {
        ...headers,
        Range: `bytes=${indexRange.start}-${indexRange.end}`,
      },
    });
    if (response.status !== 206) {
      await response.body?.cancel();
      return null;
    }

    const indexBytes = new Uint8Array(await response.arrayBuffer());
    const indexedSegments = parseSidxSegments(indexBytes, indexRange.start);
    if (indexedSegments.length === 0) return null;
    const segments = coalesceHlsSegments(indexedSegments);

    // Some freshly-issued Google Video URLs only allow early or sequential
    // reads: their init/index ranges work, but a later AVPlayer HLS segment
    // receives 403. Qualify the middle and tail before exposing the playlist;
    // getStreamUrl can then request another freshly-signed URL.
    for (const segment of [
      segments[Math.floor(segments.length / 2)],
      segments[segments.length - 1],
    ]) {
      if (!segment) return null;
      const probe = await host.fetch(mediaUrl, {
        headers: {
          ...headers,
          Range: `bytes=${segment.offset}-${segment.offset}`,
        },
      });
      const ok = probe.status === 206;
      await probe.body?.cancel();
      if (!ok) return null;
    }

    const manifest = buildIndexedHlsPlaylist({ mediaUrl, initRange, segments });

    return {
      url: host.writeCacheFile(`youtube-${contentId}-${Date.now()}.m3u8`, manifest),
      headers,
      isHLS: true,
    };
  }

  // ── Source Implementation ───────────────────────────────────

  const source: MediaSource = {
    // Metadata comes from manifest.json so the bundle and the manifest it was
    // released with can never disagree (CI patches the manifest before build).
    id,
    name,
    version,
    capabilities,

    async initialize(): Promise<void> {
      yt = new InnertubeService({ httpAdapter: new FetchHttpAdapter(host.fetch) });

      try {
        // The React Native entry intentionally ships without an evaluator.
        // MiniP already executes installed source bundles in a JavaScript VM,
        // so use that VM for the small player function YouTube.js extracts.
        Platform.shim.eval = async (data) =>
          host.youtube?.evaluatePlayerScript
            ? host.youtube.evaluatePlayerScript({
                requestId: createRequestId(),
                output: data.output,
              })
            : new Function(data.output)();
        mediaYt = await Innertube.create({
          // A WEB base session keeps generic endpoints (notably search)
          // compatible with YouTube.js' parser. Media requests explicitly
          // override this with IOS/ANDROID_VR below to obtain direct URLs.
          client_type: ClientType.WEB,
          // Never revive locally generated visitor data from an older source
          // version; each source lifecycle starts with server-issued data.
          enable_session_cache: false,
          fail_fast: false,
          // Fetch YouTube's current visitor/session data. Locally generated
          // visitor IDs are intermittently challenged by Android VR, which
          // removes its otherwise token-free direct formats.
          generate_session_locally: false,
          retrieve_innertube_config: false,
          // Protected Web/YTMUSIC formats are ciphered and need the current
          // player script. Mobile fast-path formats remain direct URLs.
          retrieve_player: true,
          // Keep transport headers aligned when a request switches clients;
          // YouTube can otherwise suppress or reject their playback formats.
          fetch: mediaFetch,
        });
      } catch (error) {
        // Browse/search can still operate through the lightweight adapter. The
        // playback methods below also retain a fallback for older installs.
        host.log('YouTube.js media client initialization failed:', error);
        mediaYt = null;
      }
    },

    async dispose(): Promise<void> {
      yt.invalidateSession();
      mediaYt = null;
      _officialVideoInfoCache.clear();
      _poTokenCache.clear();
    },

    // ── Playback ──────────────────────────────────────────────

    async getStreamUrl(contentId: string): Promise<AudioPlaybackInfo> {
      // Stream uncached iOS playback through YouTube's segmented HLS delivery.
      // Downloads use getDownloadUrl() below and remain progressive MP4, so the
      // player can swap to the completed local file without making AVPlayer
      // seek through a large remote MP4.
      if (host.platform === 'ios') {
        try {
          const info = await getOfficialVideoInfo(contentId, 'IOS', true);
          const hlsUrl = info.streaming_data?.hls_manifest_url;
          const headers = { 'User-Agent': IOS_USER_AGENT };
          if (hlsUrl) {
            const probe = await probeMediaUrl(hlsUrl, headers, false);
            if (probe.ok) {
              host.log('Using verified YouTube.js HLS stream for', contentId);
              return {
                url: hlsUrl,
                headers,
                isHLS: true,
              };
            }
            host.log(`YouTube.js HLS probe failed: HTTP ${probe.status || 'network error'}`);
          }
        } catch (error) {
          host.log('YouTube.js HLS lookup failed, trying direct audio:', error);
        }
      }

      try {
        let resolved = await resolveVerifiedDirectAudio(contentId, true);
        if (host.platform === 'ios') {
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const indexedHls = await createIndexedHlsStream(contentId, resolved);
              if (indexedHls) {
                host.log(`Using indexed ${resolved.client} HLS stream for`, contentId);
                return indexedHls;
              }
            } catch (error) {
              host.log('Indexed HLS qualification failed:', error);
            }

            if (attempt < 2) {
              try {
                resolved = await resolveVerifiedDirectAudio(contentId, false);
                host.log(`Retrying indexed HLS with fresh ${resolved.client} URL for`, contentId);
              } catch (error) {
                host.log('Fresh URL lookup failed; using the verified direct audio URL:', error);
                break;
              }
            }
          }
          host.log('Indexed HLS ranges unavailable, using direct audio for', contentId);
        }

        host.log(
          `Using verified ${resolved.client} direct audio for`,
          contentId,
          `(${resolved.format.mime_type})`
        );
        return { url: resolved.format.url!, headers: resolved.headers };
      } catch (error) {
        host.log('YouTube.js direct stream lookup failed:', error);
      }

      if (host.youtube?.generatePoToken) {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const resolved = await resolveProtectedWebAudio(contentId, attempt > 0);
            if (host.platform === 'ios') {
              const indexedHls = await createIndexedHlsStream(contentId, resolved);
              if (indexedHls) {
                host.log('Using PO-token YTMUSIC indexed HLS stream for', contentId);
                return indexedHls;
              }
            }

            host.log('Using PO-token YTMUSIC direct audio for', contentId);
            return { url: resolved.format.url!, headers: resolved.headers };
          } catch (error) {
            _poTokenCache.delete(contentId);
            host.log(`PO-token stream attempt ${attempt + 1} failed:`, error);
          }
        }
      }

      const fallbackInfo = await getCachedVideoInfo(contentId);
      if (!fallbackInfo) throw new Error('Failed to get video info for ' + contentId);
      const fallbackHeaders = { 'User-Agent': IOS_USER_AGENT };

      if (host.platform === 'ios' && fallbackInfo.hlsManifestUrl) {
        const probe = await probeMediaUrl(fallbackInfo.hlsManifestUrl, fallbackHeaders, false);
        if (probe.ok) {
          host.log('Using verified adapter HLS stream for', contentId);
          return {
            url: fallbackInfo.hlsManifestUrl,
            headers: fallbackHeaders,
            isHLS: true,
          };
        }
      }

      const fallbackFormats = (fallbackInfo.adaptiveFormats ?? [])
        .filter((format: any) => format.url && format.mimeType?.startsWith('audio/'))
        .sort((a: any, b: any) => parseInt(b.bitrate || '0') - parseInt(a.bitrate || '0'));
      for (const format of fallbackFormats) {
        const probe = await probeMediaUrl(format.url, fallbackHeaders, true);
        if (probe.ok) {
          host.log('Using verified adapter direct audio for', contentId);
          return { url: format.url, headers: fallbackHeaders };
        }
      }
      throw new Error(`YouTube blocked every playback URL for ${contentId}`);
    },

    async getDownloadUrl(contentId: string): Promise<DownloadInfo> {
      // Do not use the stream cache here: every retry needs a freshly-signed
      // URL while the native downloader keeps the existing .part bytes.
      let officialError: unknown;
      try {
        const resolved = await resolveVerifiedDirectAudio(contentId, false);
        host.log(`Using verified ${resolved.client} download URL for`, contentId);
        return {
          url: resolved.format.url!,
          contentLength: resolved.format.content_length ?? 0,
          // Google Video can reject an unbounded native request even after a
          // ranged probe succeeds. Resume requests replace this value with
          // their saved byte offset.
          headers: { ...resolved.headers, Range: DOWNLOAD_RANGE_HEADER },
        };
      } catch (error) {
        officialError = error;
        host.log('YouTube.js download lookup failed, using adapter fallback:', error);
      }

      if (host.youtube?.generatePoToken) {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const resolved = await resolveProtectedWebAudio(contentId, attempt > 0);
            host.log('Using PO-token YTMUSIC download URL for', contentId);
            return {
              url: resolved.format.url!,
              contentLength: resolved.format.content_length ?? 0,
              headers: { ...resolved.headers, Range: DOWNLOAD_RANGE_HEADER },
            };
          } catch (error) {
            _poTokenCache.delete(contentId);
            officialError = error;
            host.log(`PO-token download attempt ${attempt + 1} failed:`, error);
          }
        }
      }

      const fallbackInfo = await yt.getVideoInfo(contentId, 'IOS');
      if (!fallbackInfo) throw new Error('Failed to get video info for ' + contentId);
      const fallbackFormats = (fallbackInfo.adaptiveFormats ?? [])
        .filter((format: any) => format.url && format.mimeType?.startsWith('audio/mp4'))
        .sort((a: any, b: any) => parseInt(b.bitrate || '0') - parseInt(a.bitrate || '0'));
      for (const format of fallbackFormats) {
        const url = format.url;
        if (!url) continue;
        const headers = {
          'User-Agent': IOS_USER_AGENT,
          Range: DOWNLOAD_RANGE_HEADER,
        };
        const probe = await probeMediaUrl(url, headers, true);
        if (probe.ok) {
          return {
            url,
            contentLength: parseInt(format.contentLength || '0'),
            headers,
          };
        }
      }
      throw new Error(
        `YouTube blocked every download URL: ${errorMessage(
          officialError || 'no direct audio format'
        )}`
      );
    },

    // ── Search ────────────────────────────────────────────────

    async search(query: string): Promise<MediaItem[]> {
      const results = await yt.search(query, { type: 'video' });
      if (!results) return [];

      return results.items
        .filter((v) => v.videoId)
        .map(
          (v): MediaItem => ({
            id: v.videoId!,
            sourceId: SOURCE_ID,
            type: 'track',
            title: v.title || 'Unknown',
            artist: v.channelName || 'Unknown',
            artwork: getBestThumbnail(v.thumbnails),
            duration: parseDuration(v.lengthText),
            contentId: v.videoId!,
          })
        );
    },

    async getSearchSuggestions(query: string): Promise<string[]> {
      try {
        const suggestions = await yt.getSearchSuggestions(query);
        return suggestions.map((s) => s.text);
      } catch {
        return [];
      }
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
            artwork:
              getBestThumbnail(item.thumbnails) ||
              `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`,
            duration: parseDuration(item.lengthText),
            contentId: item.videoId,
          });
        }
      }

      return {
        title: playlist.channelMeta?.title || 'Playlist',
        subtitle: '',
        thumbnail: getBestThumbnail(playlist.channelMeta?.thumbnails) || items[0]?.artwork || '',
        items,
        collectionType: 'playlist',
      };
    },

    // ── Artist / Channel ──────────────────────────────────────

    async getArtist(browseId: string): Promise<ArtistInfo> {
      // A channel's Home tab is curated and often has no video shelf at all.
      // Load the real Videos and Playlists tabs alongside it so every regular
      // YouTube upload can be exposed as a playable audio track.
      const [channel, channelVideos, channelPlaylists] = await Promise.all([
        yt.getChannelHome(browseId).catch((error) => {
          host.log('Channel home lookup failed:', error);
          return null;
        }),
        yt.getChannelVideos(browseId).catch((error) => {
          host.log('Channel videos lookup failed:', error);
          return null;
        }),
        yt.getChannelPlaylists(browseId).catch((error) => {
          host.log('Channel playlists lookup failed:', error);
          return null;
        }),
      ]);
      const channelMetadata = channel ?? channelVideos ?? channelPlaylists;
      if (!channelMetadata)
        return { id: browseId, name: 'Unknown', thumbnail: '', sections: [], sourceId: SOURCE_ID };
      const channelMeta =
        channel?.channelMeta ?? channelVideos?.channelMeta ?? channelPlaylists?.channelMeta;

      const sections: ArtistSection[] = [];
      const videoItems: MediaFeedItem[] = [];
      const seenVideoIds = new Set<string>();
      const seenPlaylistIds = new Set<string>();

      const appendVideos = (response: Awaited<ReturnType<typeof yt.getChannelVideos>>) => {
        if (!response) return;
        for (const section of response.sections) {
          for (const item of section.items) {
            if (!item.videoId || seenVideoIds.has(item.videoId)) continue;
            seenVideoIds.add(item.videoId);
            videoItems.push({
              id: item.videoId,
              title: item.title || '',
              subtitle: item.channelName || channelMeta?.title || '',
              thumbnail:
                getBestThumbnail(item.thumbnails) ||
                `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`,
              type: 'song',
              trackId: item.videoId,
            });
          }
        }
      };

      appendVideos(channelVideos);

      // Pull a couple of continuation pages so artist pages are not limited
      // to the small first grid returned by YouTube.
      let continuationToken = channelVideos?.continuationToken;
      for (let page = 0; page < 2 && continuationToken; page += 1) {
        try {
          const continuation = await yt.continueResults(continuationToken);
          appendVideos(continuation);
          continuationToken = continuation?.continuationToken;
        } catch (error) {
          host.log('Channel videos continuation failed:', error);
          break;
        }
      }

      const supplementarySections = [
        ...(channel?.sections ?? []),
        ...(channelPlaylists?.sections ?? []),
      ];
      for (const section of supplementarySections) {
        const sectionTitle = section.title || '';
        const items: MediaFeedItem[] = [];
        for (const item of section.items) {
          // Prefer the video whenever an endpoint contains both a video and
          // contextual playlist ID. The app plays videos as audio tracks.
          if (item.videoId) {
            if (seenVideoIds.has(item.videoId)) continue;
            seenVideoIds.add(item.videoId);
            videoItems.push({
              id: item.videoId,
              title: item.title || '',
              subtitle: item.channelName || channelMeta?.title || '',
              thumbnail:
                getBestThumbnail(item.thumbnails) ||
                `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`,
              type: 'song',
              trackId: item.videoId,
            });
          } else if (item.playlistId && !seenPlaylistIds.has(item.playlistId)) {
            seenPlaylistIds.add(item.playlistId);
            items.push({
              id: item.playlistId,
              title: item.title || '',
              subtitle: item.channelName || '',
              thumbnail: getBestThumbnail(item.thumbnails),
              type: 'playlist',
              browseId: item.playlistId,
              itemCount: item.videoCount,
            });
          }
        }
        if (items.length > 0) {
          const titleLower = sectionTitle.toLowerCase();
          let sectionType: ArtistSection['type'] = 'playlists';
          if (titleLower.includes('playlist')) sectionType = 'playlists';
          else if (titleLower.includes('single')) sectionType = 'singles';
          else if (titleLower.includes('album')) sectionType = 'albums';

          sections.push({ title: sectionTitle || 'Playlists', type: sectionType, items });
        }
      }

      if (videoItems.length > 0) {
        sections.unshift({ title: 'Videos', type: 'videos', items: videoItems });
      }

      return {
        id: browseId,
        name: channelMeta?.title || 'Unknown',
        description: channelMeta?.description || undefined,
        thumbnail: getBestThumbnail(channelMeta?.thumbnails),
        subscribers: channelMeta?.subscriberCount || undefined,
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
                artwork:
                  getBestThumbnail(item.thumbnails) ||
                  `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`,
                duration: parseDuration(item.lengthText),
                contentId: item.videoId,
              });
            }
          }
          if (tracks.length > 0) return tracks.slice(0, 20);
        }
      } catch {
        /* fall through to search */
      }

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
            .map(
              (v): MediaItem => ({
                id: v.videoId!,
                sourceId: SOURCE_ID,
                type: 'track',
                title: v.title || 'Unknown',
                artist: v.channelName || 'Unknown',
                artwork: getBestThumbnail(v.thumbnails),
                duration: parseDuration(v.lengthText),
                contentId: v.videoId!,
              })
            );
        }
      } catch {
        /* give up */
      }
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

  function getBestThumbnail(
    thumbnails?: { url: string; width?: number; height?: number }[]
  ): string {
    if (!Array.isArray(thumbnails) || thumbnails.length === 0) return '';
    let url = thumbnails[thumbnails.length - 1]?.url ?? '';
    // YouTube sometimes returns protocol-relative URLs (//yt3.ggpht.com/...)
    if (url.startsWith('//')) url = 'https:' + url;
    return url;
  }
}
