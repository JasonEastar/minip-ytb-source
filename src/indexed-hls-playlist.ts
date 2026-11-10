/**
 * Indexed HLS playlist — pure helpers that turn a progressive MP4 audio
 * format into a byte-range HLS playlist AVPlayer can stream.
 *
 * No I/O here: `createIndexedHlsStream` in index.ts fetches the `sidx` bytes
 * and writes the playlist through the host.
 */

export const HLS_SEGMENT_TARGET_SECONDS = 6;

export type IndexedMediaSegment = {
  offset: number;
  size: number;
  durationSeconds: number;
};

export type ByteRange = { start: number; end: number };

function readUint64(view: DataView, offset: number): number {
  return view.getUint32(offset) * 2 ** 32 + view.getUint32(offset + 4);
}

/**
 * Parse the first `sidx` box (ISO/IEC 14496-12 §8.16.3) found in `data` and
 * return one segment per media reference. `absoluteDataOffset` is the byte
 * offset of `data[0]` inside the media file, so returned offsets are absolute.
 * Returns [] when no usable sidx is present.
 */
export function parseSidxSegments(
  data: Uint8Array,
  absoluteDataOffset: number
): IndexedMediaSegment[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let boxOffset = 0;

  while (boxOffset + 8 <= data.byteLength) {
    let boxSize = view.getUint32(boxOffset);
    const boxType = String.fromCharCode(
      data[boxOffset + 4],
      data[boxOffset + 5],
      data[boxOffset + 6],
      data[boxOffset + 7]
    );
    let headerSize = 8;
    if (boxSize === 1) {
      if (boxOffset + 16 > data.byteLength) break;
      boxSize = readUint64(view, boxOffset + 8);
      headerSize = 16;
    }
    if (boxSize < headerSize || boxOffset + boxSize > data.byteLength) break;

    if (boxType !== 'sidx') {
      boxOffset += boxSize;
      continue;
    }

    const fullBoxOffset = boxOffset + headerSize;
    const boxEnd = boxOffset + boxSize;
    if (fullBoxOffset + 12 > boxEnd) return [];
    const version = data[fullBoxOffset];
    const timescale = view.getUint32(fullBoxOffset + 8);
    if (timescale <= 0) return [];

    // version 0: 32-bit earliest_presentation_time + first_offset; else 64-bit.
    const timeFieldSize = version === 0 ? 4 : 8;
    let cursor = fullBoxOffset + 12 + timeFieldSize; // skip earliest_presentation_time
    if (cursor + timeFieldSize + 4 > boxEnd) return [];
    const firstOffset = version === 0 ? view.getUint32(cursor) : readUint64(view, cursor);
    cursor += timeFieldSize;
    cursor += 2; // reserved
    const referenceCount = view.getUint16(cursor);
    cursor += 2;

    let mediaOffset = absoluteDataOffset + boxEnd + firstOffset;
    const segments: IndexedMediaSegment[] = [];
    for (let index = 0; index < referenceCount; index++) {
      if (cursor + 12 > boxEnd) return [];
      const reference = view.getUint32(cursor);
      const referenceType = reference >>> 31;
      const size = reference & 0x7fffffff;
      const duration = view.getUint32(cursor + 4);
      cursor += 12;
      if (referenceType !== 0 || size <= 0 || duration <= 0) return [];

      segments.push({
        offset: mediaOffset,
        size,
        durationSeconds: duration / timescale,
      });
      mediaOffset += size;
    }
    return segments;
  }

  return [];
}

/** Merge consecutive segments until each group lasts at least the target. */
export function coalesceHlsSegments(segments: IndexedMediaSegment[]): IndexedMediaSegment[] {
  const grouped: IndexedMediaSegment[] = [];
  let current: IndexedMediaSegment | null = null;

  for (const segment of segments) {
    if (!current) {
      current = { ...segment };
    } else {
      current.size += segment.size;
      current.durationSeconds += segment.durationSeconds;
    }

    if (current.durationSeconds >= HLS_SEGMENT_TARGET_SECONDS) {
      grouped.push(current);
      current = null;
    }
  }
  if (current) grouped.push(current);
  return grouped;
}

/** Build a VOD byte-range playlist (one media URL, `EXT-X-MAP` init segment). */
export function buildIndexedHlsPlaylist(input: {
  mediaUrl: string;
  initRange: ByteRange;
  segments: IndexedMediaSegment[];
}): string {
  const { mediaUrl, initRange, segments } = input;
  const targetDuration = Math.max(
    1,
    Math.ceil(Math.max(...segments.map((segment) => segment.durationSeconds)))
  );
  const escapedMediaUrl = mediaUrl.replace(/"/g, '%22');
  const initLength = initRange.end - initRange.start + 1;
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    `#EXT-X-TARGETDURATION:${targetDuration}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXT-X-MAP:URI="${escapedMediaUrl}",BYTERANGE="${initLength}@${initRange.start}"`,
    ...segments.flatMap((segment) => [
      `#EXTINF:${segment.durationSeconds.toFixed(6)},`,
      `#EXT-X-BYTERANGE:${segment.size}@${segment.offset}`,
      escapedMediaUrl,
    ]),
    '#EXT-X-ENDLIST',
    '',
  ].join('\n');
}
