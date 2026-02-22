/**
 * DASH MPD (Media Presentation Description) builder.
 * Generates a valid MPEG-DASH MPD manifest from YouTube adaptive formats.
 *
 * Migrated from YouTubeMPDBuilder.java
 *
 * Usage:
 *   const info = await yt.getVideoInfo('videoId');
 *   const mpd = buildDashManifest(info);
 *   // mpd is an XML string that can be loaded by ExoPlayer, dash.js, shaka-player, etc.
 */

import type { MediaFormat, MediaItemFormatInfo, MediaSubtitle } from './types.js';

// ==================== Helper functions ====================

/** Extract codecs from mimeType like "video/mp4; codecs=\"avc1.640033\"" */
function extractCodecs(mimeType: string): string {
  const match = mimeType.match(/codecs="([^"]+)"/);
  return match?.[1] ?? '';
}

/** Extract base mime type (e.g., "video/mp4" from "video/mp4; codecs=\"avc1\"") */
function extractBaseMime(mimeType: string): string {
  return mimeType.split(';')[0].trim();
}

/** Detect if format is video */
function isVideo(format: MediaFormat): boolean {
  return format.width > 0 && format.height > 0;
}

/** Detect if format is audio */
function isAudio(format: MediaFormat): boolean {
  return !!format.mimeType?.startsWith('audio');
}

/** Check if format has valid DASH range info */
function isDashFormat(format: MediaFormat): boolean {
  if (!format.url) return false;
  // Has init/index range = DASH; no range = URL-based format
  return !!(format.initRange || format.indexRange);
}

/** Escape XML special characters */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ==================== XML Builder ====================

class XmlBuilder {
  private parts: string[] = [];
  private indent = 0;

  declaration(): this {
    this.parts.push('<?xml version="1.0" encoding="UTF-8"?>');
    return this;
  }

  open(tag: string, attrs?: Record<string, string | number | undefined>): this {
    let line = `${'  '.repeat(this.indent)}<${tag}`;
    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        if (value !== undefined && value !== null) {
          line += ` ${key}="${escapeXml(String(value))}"`;
        }
      }
    }
    line += '>';
    this.parts.push(line);
    this.indent++;
    return this;
  }

  selfClose(tag: string, attrs?: Record<string, string | number | undefined>): this {
    let line = `${'  '.repeat(this.indent)}<${tag}`;
    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        if (value !== undefined && value !== null) {
          line += ` ${key}="${escapeXml(String(value))}"`;
        }
      }
    }
    line += '/>';
    this.parts.push(line);
    return this;
  }

  /** Tag with text content on same line */
  textTag(tag: string, text: string, attrs?: Record<string, string | number | undefined>): this {
    let line = `${'  '.repeat(this.indent)}<${tag}`;
    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        if (value !== undefined && value !== null) {
          line += ` ${key}="${escapeXml(String(value))}"`;
        }
      }
    }
    line += `>${escapeXml(text)}</${tag}>`;
    this.parts.push(line);
    return this;
  }

  close(tag: string): this {
    this.indent--;
    this.parts.push(`${'  '.repeat(this.indent)}</${tag}>`);
    return this;
  }

  build(): string {
    return this.parts.join('\n');
  }
}

// ==================== Grouping ====================

interface FormatGroup {
  mimeType: string; // e.g., "video/mp4", "audio/webm"
  language?: string;
  formats: MediaFormat[];
}

/** Group adaptive formats by base mime type and language */
function groupFormats(formats: MediaFormat[]): FormatGroup[] {
  const map = new Map<string, FormatGroup>();

  for (const fmt of formats) {
    if (!fmt.mimeType || !fmt.url) continue;
    if (!isDashFormat(fmt)) continue;
    if (fmt.isOtf) continue; // skip OTF formats (not supported yet)

    const baseMime = extractBaseMime(fmt.mimeType);
    // For audio, also group by language if present
    const lang = isAudio(fmt) ? 'default' : undefined;
    const key = `${baseMime}__${lang ?? ''}`;

    let group = map.get(key);
    if (!group) {
      group = { mimeType: baseMime, language: lang, formats: [] };
      map.set(key, group);
    }
    group.formats.push(fmt);
  }

  return Array.from(map.values());
}

// ==================== Public API ====================

export interface DashManifestOptions {
  /** Limit to specific video codec (e.g., "avc1", "vp9", "av01") */
  videoCodec?: string;
  /** Limit to specific audio codec (e.g., "mp4a", "opus", "ec-3") */
  audioCodec?: string;
  /** Include subtitles in the manifest */
  includeSubtitles?: boolean;
}

/**
 * Build a DASH MPD manifest from YouTube video format info.
 *
 * @param info MediaItemFormatInfo from getVideoInfo()
 * @param options Optional codec/subtitle filtering
 * @returns XML string of the MPD manifest, or null if no DASH formats available
 *
 * @example
 * ```typescript
 * const info = await yt.getVideoInfo('dQw4w9WgXcQ');
 * const mpd = buildDashManifest(info);
 * // Use mpd as a data URI or serve it to a DASH player
 * ```
 */
export function buildDashManifest(
  info: MediaItemFormatInfo,
  options?: DashManifestOptions,
): string | null {
  const adaptiveFormats = info.adaptiveFormats ?? [];

  // Filter to DASH-capable formats only
  let dashFormats = adaptiveFormats.filter(f => f.url && isDashFormat(f) && !f.isOtf);

  if (dashFormats.length === 0) return null;

  // Apply codec filters
  if (options?.videoCodec) {
    const vc = options.videoCodec;
    dashFormats = dashFormats.filter(f => !isVideo(f) || extractCodecs(f.mimeType ?? '').startsWith(vc));
  }
  if (options?.audioCodec) {
    const ac = options.audioCodec;
    dashFormats = dashFormats.filter(f => !isAudio(f) || extractCodecs(f.mimeType ?? '').startsWith(ac));
  }

  if (dashFormats.length === 0) return null;

  const durationSec = parseInt(info.lengthSeconds ?? '0', 10) || 0;
  const isLive = info.isLive || info.isLiveContent;

  const xml = new XmlBuilder();
  xml.declaration();

  // ── MPD root ──
  const mpdAttrs: Record<string, string> = {
    'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
    'xmlns': 'urn:mpeg:DASH:schema:MPD:2011',
    'xmlns:yt': 'http://youtube.com/yt/2012/10/10',
    'xsi:schemaLocation': 'urn:mpeg:DASH:schema:MPD:2011 DASH-MPD.xsd',
    'minBufferTime': 'PT1.500S',
    'profiles': 'urn:mpeg:dash:profile:isoff-on-demand:2011',
  };

  if (isLive) {
    mpdAttrs.type = 'dynamic';
    mpdAttrs.minimumUpdatePeriod = 'P100Y';
  } else {
    mpdAttrs.type = 'static';
    mpdAttrs.mediaPresentationDuration = `PT${durationSec}S`;
  }

  xml.open('MPD', mpdAttrs);

  // ── Period ──
  const periodAttrs: Record<string, string> = {};
  if (isLive) {
    periodAttrs.start = 'PT0S';
  } else {
    periodAttrs.duration = `PT${durationSec}S`;
  }
  xml.open('Period', periodAttrs);

  // ── Group formats and write AdaptationSets ──
  const groups = groupFormats(dashFormats);
  let adaptationSetId = 0;

  for (const group of groups) {
    xml.open('AdaptationSet', {
      id: String(adaptationSetId++),
      mimeType: group.mimeType,
      subsegmentAlignment: 'true',
      ...(group.language ? { lang: group.language } : {}),
    });

    // Role
    xml.selfClose('Role', {
      schemeIdUri: 'urn:mpeg:DASH:role:2011',
      value: 'main',
    });

    // ── Representations ──
    for (const fmt of group.formats) {
      const codecs = extractCodecs(fmt.mimeType ?? '');
      const repAttrs: Record<string, string | number> = {
        id: fmt.isDrc ? `${fmt.itag}-drc` : fmt.itag,
        codecs,
        startWithSAP: '1',
        bandwidth: fmt.bitrate,
      };

      if (isVideo(fmt)) {
        repAttrs.width = fmt.width;
        repAttrs.height = fmt.height;
        repAttrs.maxPlayoutRate = '1';
        if (fmt.fps) repAttrs.frameRate = fmt.fps;
      } else if (isAudio(fmt)) {
        if (fmt.audioSampleRate) repAttrs.audioSamplingRate = fmt.audioSampleRate;
      }

      xml.open('Representation', repAttrs);

      // BaseURL
      if (fmt.url) {
        xml.textTag('BaseURL', fmt.url, fmt.contentLength ? { 'yt:contentLength': fmt.contentLength } : undefined);
      }

      // SegmentBase with init/index ranges
      if (fmt.indexRange && fmt.indexRange !== '0-0') {
        xml.open('SegmentBase', {
          indexRange: fmt.indexRange,
          indexRangeExact: 'true',
        });

        if (fmt.initRange) {
          xml.selfClose('Initialization', { range: fmt.initRange });
        }

        xml.close('SegmentBase');
      }

      xml.close('Representation');
    }

    xml.close('AdaptationSet');
  }

  // ── Subtitles ──
  if (options?.includeSubtitles !== false && info.subtitles && info.subtitles.length > 0) {
    for (const sub of info.subtitles) {
      if (!sub.baseUrl) continue;

      xml.open('AdaptationSet', {
        id: String(adaptationSetId++),
        mimeType: sub.mimeType || 'text/vtt',
        lang: sub.name || sub.languageCode || 'und',
      });

      xml.selfClose('Role', {
        schemeIdUri: 'urn:mpeg:DASH:role:2011',
        value: 'subtitle',
      });

      xml.open('Representation', {
        id: String(adaptationSetId),
        bandwidth: '268',
        codecs: sub.codecs || 'wvtt',
      });

      xml.textTag('BaseURL', sub.baseUrl);

      xml.close('Representation');
      xml.close('AdaptationSet');
    }
  }

  xml.close('Period');
  xml.close('MPD');

  return xml.build();
}

/**
 * Build a DASH MPD manifest and return it as a data URI.
 * Useful for feeding directly into ExoPlayer, dash.js, or shaka-player.
 */
export function buildDashManifestDataUri(
  info: MediaItemFormatInfo,
  options?: DashManifestOptions,
): string | null {
  const mpd = buildDashManifest(info, options);
  if (!mpd) return null;

  // Base64-encode for data URI
  if (typeof btoa === 'function') {
    return `data:application/dash+xml;base64,${btoa(mpd)}`;
  }

  // Node.js fallback
  const NodeBuffer = (globalThis as any).Buffer;
  if (NodeBuffer) {
    return `data:application/dash+xml;base64,${NodeBuffer.from(mpd).toString('base64')}`;
  }

  // Last resort: percent-encode
  return `data:application/dash+xml,${encodeURIComponent(mpd)}`;
}
