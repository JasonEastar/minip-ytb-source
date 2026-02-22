/**
 * Player result extension helpers
 * Migrated from PlayerResultExtensions.kt
 */

import type {
  PlayerResult,
  StreamingFormat,
  TextItem,
  MediaFormat,
  MediaSubtitle,
  MediaItemFormatInfo,
  FormatRange,
} from './types.js';
import { FORMAT_TYPE_DASH, FORMAT_TYPE_SABR, FORMAT_TYPE_REGULAR } from './types.js';
import { UrlQueryString } from './utils.js';

// ==================== TextItem helpers ====================

export function getText(item?: TextItem): string | undefined {
  if (!item) return undefined;
  if (item.simpleText) return item.simpleText;
  if (item.content) return item.content;
  if (item.runs) return item.runs.map((r) => r.text ?? '').join('');
  return item.accessibility?.accessibilityData?.label;
}

// ==================== PlayerResult helpers ====================

export function getVideoPlaybackUstreamerConfig(pr: PlayerResult): string | undefined {
  return pr.playerConfig?.mediaCommonConfig?.mediaUstreamerRequestConfig?.videoPlaybackUstreamerConfig;
}

export function getServerAbrStreamingUrl(pr: PlayerResult): string | undefined {
  return pr.streamingData?.serverAbrStreamingUrl;
}

export function getAdaptiveFormats(pr: PlayerResult): StreamingFormat[] | undefined {
  return pr.streamingData?.adaptiveFormats;
}

export function getLegacyFormats(pr: PlayerResult): StreamingFormat[] | undefined {
  return pr.streamingData?.formats;
}

export function getLoudnessDb(pr: PlayerResult): number {
  return pr.playerConfig?.audioConfig?.loudnessDb ?? 0;
}

export function getStoryboardSpec(pr: PlayerResult): string | undefined {
  const sb = pr.storyboards;
  return sb?.playerStoryboardSpecRenderer?.spec ?? sb?.playerLiveStoryboardSpecRenderer?.spec;
}

export function getTrailerVideoId(pr: PlayerResult): string | undefined {
  return pr.playabilityStatus?.errorScreen?.playerLegacyDesktopYpcTrailerRenderer?.trailerVideoId;
}

export function getPlayabilityStatus(pr: PlayerResult): string | undefined {
  return pr.playabilityStatus?.status;
}

export function getPlayabilityReason(pr: PlayerResult): string | undefined {
  return pr.playabilityStatus?.reason;
}

export function getPlayabilityDescription(pr: PlayerResult): string | undefined {
  return getText(pr.playabilityStatus?.errorScreen?.playerErrorMessageRenderer?.subreason);
}

export function isPlayableInEmbed(pr: PlayerResult): boolean {
  return pr.playabilityStatus?.playableInEmbed ?? false;
}

export function getStartTimestamp(pr: PlayerResult): string | undefined {
  return pr.microformat?.playerMicroformatRenderer?.liveBroadcastDetails?.startTimestamp;
}

export function getUploadDate(pr: PlayerResult): string | undefined {
  return pr.microformat?.playerMicroformatRenderer?.uploadDate;
}

export function getPaidContentText(pr: PlayerResult): string | undefined {
  return getText(pr.paidContentOverlay?.paidContentOverlayRenderer?.text);
}

export function getWatchTimeUrl(pr: PlayerResult): string | undefined {
  return pr.playbackTracking?.videostatsWatchtimeUrl?.baseUrl;
}

export function getCaptionTracks(pr: PlayerResult) {
  return pr.captions?.playerCaptionsTracklistRenderer?.captionTracks;
}

export function getTranslationLanguages(pr: PlayerResult) {
  return pr.captions?.playerCaptionsTracklistRenderer?.translationLanguages;
}

// ==================== StreamingFormat helpers ====================

export function formatHasRange(sf: StreamingFormat): boolean {
  return sf.indexRange != null || sf.initRange != null;
}

export function formatIsBroken(sf: StreamingFormat): boolean {
  return !sf.url && !sf.cipher && !sf.signatureCipher;
}

export function formatIsOtf(sf: StreamingFormat): boolean {
  return sf.type === 'FORMAT_STREAM_TYPE_OTF';
}

function rangeToString(r?: FormatRange): string | undefined {
  if (!r || r.start == null || r.end == null) return undefined;
  return `${r.start}-${r.end}`;
}

export function getFormatType(sf: StreamingFormat): number {
  if (formatHasRange(sf) && formatIsBroken(sf)) return FORMAT_TYPE_SABR;
  if (formatHasRange(sf)) return FORMAT_TYPE_DASH;
  return FORMAT_TYPE_REGULAR;
}

// ==================== Build MediaFormat from StreamingFormat ====================

export function toMediaFormat(sf: StreamingFormat): MediaFormat {
  return {
    formatType: getFormatType(sf),
    url: sf.url,
    mimeType: sf.mimeType,
    itag: sf.itag && sf.itag !== 0 ? String(sf.itag) : '',
    isDrc: sf.isDrc ?? false,
    contentLength: sf.contentLength,
    bitrate: sf.bitrate && sf.bitrate !== 0 ? String(sf.bitrate) : '',
    projectionType: sf.projectionType,
    width: sf.width ?? -1,
    height: sf.height ?? -1,
    initRange: rangeToString(sf.initRange),
    indexRange: rangeToString(sf.indexRange),
    fps: sf.fps && sf.fps !== 0 ? String(sf.fps) : '',
    lastModified: sf.lastModified,
    qualityLabel: sf.qualityLabel,
    format: sf.type,
    isOtf: formatIsOtf(sf),
    targetDurationSec: sf.targetDurationSec ?? -1,
    maxDvrDurationSec: sf.maxDvrDurationSec ?? -1,
    approxDurationMs: sf.approxDurationMs ? parseInt(sf.approxDurationMs, 10) : -1,
    audioQuality: sf.audioQuality,
    audioSampleRate: sf.audioSampleRate,
    audioChannels: sf.audioChannels,
  };
}

// ==================== Build MediaSubtitle ====================

const TYPE_ASR = 'asr';

export function toMediaSubtitle(ct: NonNullable<ReturnType<typeof getCaptionTracks>>[number]): MediaSubtitle {
  const name = getText(ct.name);
  const isAuto = ct.kind === TYPE_ASR;
  return {
    baseUrl: ct.baseUrl,
    languageCode: ct.languageCode,
    name: isAuto && name ? `${name}*` : name,
    isTranslatable: ct.isTranslatable,
    isAutogenerated: isAuto,
    mimeType: 'application/ttml+xml',
    codecs: '',
  };
}

// ==================== Build MediaItemFormatInfo ====================

const STATUS_OK = 'OK';
const STATUS_UNPLAYABLE = 'UNPLAYABLE';
const STATUS_ERROR = 'ERROR';
const STATUS_LOGIN_REQUIRED = 'LOGIN_REQUIRED';
const STATUS_AGE_CHECK_REQUIRED = 'AGE_CHECK_REQUIRED';
const STATUS_CONTENT_CHECK_REQUIRED = 'CONTENT_CHECK_REQUIRED';

export function buildFormatInfo(playerResult: PlayerResult): MediaItemFormatInfo {
  const adaptiveFormats = getAdaptiveFormats(playerResult)?.map(toMediaFormat);
  const urlFormats = getLegacyFormats(playerResult)?.map(toMediaFormat);
  const captionTracks = getCaptionTracks(playerResult);
  const subtitles = captionTracks?.map(toMediaSubtitle);

  const vd = playerResult.videoDetails;
  const status = getPlayabilityStatus(playerResult);
  const loudnessDb = getLoudnessDb(playerResult);

  const isUnplayable =
    status === STATUS_UNPLAYABLE ||
    status === STATUS_ERROR ||
    status === STATUS_LOGIN_REQUIRED ||
    status === STATUS_AGE_CHECK_REQUIRED ||
    status === STATUS_CONTENT_CHECK_REQUIRED;

  // Volume normalization (from Kotlin)
  let volumeLevel = 0.5;
  if (loudnessDb !== 0) {
    let normalLevel = Math.pow(10, loudnessDb / 20);
    if (normalLevel > 1.95) normalLevel = 1.5;
    volumeLevel = (2.0 - normalLevel) / 2;
  }

  // Parse tracking params from watchtime URL
  let eventId: string | undefined;
  let visitorMonitoringData: string | undefined;
  let ofParam: string | undefined;

  const watchTimeUrl = getWatchTimeUrl(playerResult);
  if (watchTimeUrl) {
    const qs = new UrlQueryString(watchTimeUrl);
    eventId = qs.get('ei');
    visitorMonitoringData = qs.get('vm');
    ofParam = qs.get('of');
  }

  return {
    videoId: vd?.videoId,
    title: vd?.title,
    author: vd?.author,
    channelId: vd?.channelId,
    viewCount: vd?.viewCount,
    description: vd?.shortDescription,
    lengthSeconds: vd?.lengthSeconds,
    isLive: vd?.isLive ?? false,
    isLiveContent: vd?.isLiveContent ?? false,
    isUnplayable,
    playabilityReason: getPlayabilityReason(playerResult),
    adaptiveFormats,
    urlFormats,
    subtitles,
    hlsManifestUrl: playerResult.streamingData?.hlsManifestUrl,
    dashManifestUrl: playerResult.streamingData?.dashManifestUrl,
    serverAbrStreamingUrl: playerResult.streamingData?.serverAbrStreamingUrl,
    storyboardSpec: getStoryboardSpec(playerResult),
    loudnessDb,
    volumeLevel,
    startTimestamp: getStartTimestamp(playerResult),
    uploadDate: getUploadDate(playerResult),
    eventId,
    visitorMonitoringData,
    ofParam,
    thumbnails: vd?.thumbnail?.thumbnails,
  };
}
