import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIndexedHlsPlaylist,
  coalesceHlsSegments,
  parseSidxSegments,
} from '../src/indexed-hls-playlist.ts';
import { ascii, box, buildSidx, u32 } from './helpers/sidx-box-builder.mjs';

const REFERENCES_44K = [
  { size: 1000, duration: 88200 }, // 2.0 s
  { size: 2000, duration: 110250 }, // 2.5 s
  { size: 3000, duration: 132300 }, // 3.0 s
];

// ─── parseSidxSegments ──────────────────────────────────────────────────────

test('parses a version 0 sidx into absolute segment offsets', () => {
  const sidx = buildSidx({ timescale: 44100, firstOffset: 16, references: REFERENCES_44K });
  const segments = parseSidxSegments(sidx.bytes, 4096);
  const firstMediaOffset = 4096 + sidx.size + 16;

  assert.deepEqual(segments, [
    { offset: firstMediaOffset, size: 1000, durationSeconds: 2 },
    { offset: firstMediaOffset + 1000, size: 2000, durationSeconds: 2.5 },
    { offset: firstMediaOffset + 3000, size: 3000, durationSeconds: 3 },
  ]);
});

test('parses a version 1 sidx with a 64-bit box size and first_offset above 2^32', () => {
  const firstOffset = 2 ** 32 + 8;
  const sidx = buildSidx({
    version: 1,
    largeSize: true,
    timescale: 1000,
    earliestPresentationTime: 2 ** 33,
    firstOffset,
    references: [{ size: 500, duration: 6000 }],
  });
  const segments = parseSidxSegments(sidx.bytes, 100);

  assert.deepEqual(segments, [{ offset: 100 + sidx.size + firstOffset, size: 500, durationSeconds: 6 }]);
});

test('skips leading non-sidx boxes', () => {
  const sidx = buildSidx({ timescale: 44100, firstOffset: 16, references: REFERENCES_44K });
  const leading = [...box('styp', ascii('msdhmsdhmsix')), ...box('free', [0, 0, 0, 0])];
  const data = new Uint8Array([...leading, ...sidx.bytes]);

  const direct = parseSidxSegments(sidx.bytes, 4096);
  const withLeading = parseSidxSegments(data, 4096 - leading.length);
  assert.deepEqual(withLeading, direct);
});

test('returns no segments for sidx references to other sidx boxes', () => {
  const sidx = buildSidx({
    timescale: 1000,
    references: [{ size: 100, duration: 1000, type: 1 }],
  });
  assert.deepEqual(parseSidxSegments(sidx.bytes, 0), []);
});

test('returns no segments for a zero timescale', () => {
  const sidx = buildSidx({ timescale: 0, references: [{ size: 100, duration: 1000 }] });
  assert.deepEqual(parseSidxSegments(sidx.bytes, 0), []);
});

test('returns no segments when reference_count exceeds the box payload', () => {
  const sidx = buildSidx({
    timescale: 1000,
    references: [{ size: 100, duration: 1000 }],
    referenceCount: 3,
  });
  assert.deepEqual(parseSidxSegments(sidx.bytes, 0), []);
});

test('returns no segments when the data holds no sidx box', () => {
  const data = new Uint8Array([...box('free', [1, 2, 3]), ...box('mdat', [9, 9])]);
  assert.deepEqual(parseSidxSegments(data, 0), []);
  assert.deepEqual(parseSidxSegments(new Uint8Array(0), 0), []);
});

test('returns no segments for a sidx box too short to hold its header', () => {
  // A complete 8-byte box header claiming a sidx with no payload at all.
  assert.deepEqual(parseSidxSegments(new Uint8Array(box('sidx')), 0), []);
  // Version 1 box cut right after the timescale field.
  const sidx = buildSidx({ version: 1, timescale: 1000, references: [{ size: 1, duration: 1 }] });
  const cut = sidx.bytes.subarray(0, 8 + 12);
  const header = new Uint8Array(cut);
  header.set(u32(cut.length), 0); // rewrite box size to the cut length
  assert.deepEqual(parseSidxSegments(header, 0), []);
});

test('stops at a truncated box header instead of reading past the buffer', () => {
  const sidx = buildSidx({ timescale: 44100, references: REFERENCES_44K });
  const truncated = sidx.bytes.subarray(0, sidx.size - 4);
  assert.deepEqual(parseSidxSegments(truncated, 0), []);
});

// ─── coalesceHlsSegments ────────────────────────────────────────────────────

test('coalesces consecutive segments until each group reaches six seconds', () => {
  const segments = [2, 2, 2.5, 1, 1].map((durationSeconds, index) => ({
    offset: index * 100,
    size: 100,
    durationSeconds,
  }));

  assert.deepEqual(coalesceHlsSegments(segments), [
    { offset: 0, size: 300, durationSeconds: 6.5 },
    { offset: 300, size: 200, durationSeconds: 2 },
  ]);
});

test('keeps a segment already longer than the target as is', () => {
  const segment = { offset: 10, size: 20, durationSeconds: 7 };
  assert.deepEqual(coalesceHlsSegments([segment]), [segment]);
  assert.deepEqual(coalesceHlsSegments([]), []);
});

// ─── buildIndexedHlsPlaylist ────────────────────────────────────────────────

test('builds a byte-range VOD playlist with the init segment map', () => {
  const mediaUrl = 'https://r1---sn.googlevideo.com/videoplayback?a="b"';
  const escaped = 'https://r1---sn.googlevideo.com/videoplayback?a=%22b%22';
  const playlist = buildIndexedHlsPlaylist({
    mediaUrl,
    initRange: { start: 0, end: 631 },
    segments: [
      { offset: 4732, size: 6000, durationSeconds: 6.5 },
      { offset: 10732, size: 1500, durationSeconds: 2 },
    ],
  });

  assert.equal(
    playlist,
    [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      '#EXT-X-TARGETDURATION:7',
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      `#EXT-X-MAP:URI="${escaped}",BYTERANGE="632@0"`,
      '#EXTINF:6.500000,',
      '#EXT-X-BYTERANGE:6000@4732',
      escaped,
      '#EXTINF:2.000000,',
      '#EXT-X-BYTERANGE:1500@10732',
      escaped,
      '#EXT-X-ENDLIST',
      '',
    ].join('\n')
  );
});

test('never emits a target duration below one second', () => {
  const playlist = buildIndexedHlsPlaylist({
    mediaUrl: 'https://example.invalid/a.m4a',
    initRange: { start: 0, end: 10 },
    segments: [{ offset: 11, size: 5, durationSeconds: 0.25 }],
  });
  assert.match(playlist, /^#EXT-X-TARGETDURATION:1$/m);
});
