/**
 * Test: download via range requests (simulating ParallelDownloader),
 * then verify the defragmented output.
 * 
 * Usage: npx tsx test-urls.ts [videoId]
 */
import { InnertubeService } from './src/ytbapi/index.js';
import { writeFileSync } from 'fs';
import { execSync } from 'child_process';

const VIDEO_ID = process.argv[2] || 'dQw4w9WgXcQ';
const IOS_UA = 'com.google.ios.youtube/20.11.6 (iPhone10,4; U; CPU iOS 16_7_7 like Mac OS X)';

async function main() {
  const yt = new InnertubeService({ disableDecipher: true });

  console.log(`\n=== Testing video: ${VIDEO_ID} ===\n`);

  const info = await yt.getVideoInfo(VIDEO_ID, 'IOS');
  if (!info) { console.error('❌ Failed to get video info'); process.exit(1); }
  console.log(`Title: ${info.title}`);

  const audioFormats = (info.adaptiveFormats ?? [])
    .filter((f: any) => f.url && f.mimeType?.startsWith('audio/'))
    .sort((a: any, b: any) => parseInt(b.bitrate || '0') - parseInt(a.bitrate || '0'));

  if (audioFormats.length === 0) { console.error('❌ No audio formats'); process.exit(1); }

  const best = audioFormats[0];
  const contentLength = parseInt(best.contentLength || '0');
  console.log(`Format: itag=${best.itag} mime=${best.mimeType} size=${contentLength}`);
  console.log(`formatType=${best.formatType} initRange=${best.initRange} indexRange=${best.indexRange}`);

  // Download using range requests (like ParallelDownloader does)
  const NUM_THREADS = 4;
  const chunkSize = Math.ceil(contentLength / NUM_THREADS);
  const chunks: Buffer[] = [];

  console.log(`\nDownloading in ${NUM_THREADS} chunks of ~${chunkSize} bytes...`);

  for (let i = 0; i < NUM_THREADS; i++) {
    const start = i * chunkSize;
    const end = Math.min((i + 1) * chunkSize - 1, contentLength - 1);

    const resp = await fetch(best.url, {
      headers: {
        'User-Agent': IOS_UA,
        'Range': `bytes=${start}-${end}`,
      },
    });

    if (resp.status !== 206) {
      console.error(`   ❌ Chunk ${i}: got status ${resp.status} (expected 206)`);
      continue;
    }

    const buf = Buffer.from(await resp.arrayBuffer());
    chunks.push(buf);
    console.log(`   Chunk ${i}: ${start}-${end} → ${buf.length} bytes (status ${resp.status})`);
  }

  // Merge chunks
  const merged = Buffer.concat(chunks);
  console.log(`\nMerged size: ${merged.length} (expected: ${contentLength})`);

  // Save raw download
  const rawFile = `/tmp/test-raw-${VIDEO_ID}.m4a`;
  writeFileSync(rawFile, merged);
  console.log(`Saved raw download: ${rawFile}`);

  // Analyze structure
  analyzeMP4(merged);

  // Try to probe with ffprobe
  try {
    const result = execSync(`ffprobe -v error -show_format -show_streams "${rawFile}" 2>&1`).toString();
    console.log(`\n[ffprobe] Raw file:\n${result.slice(0, 500)}`);
  } catch (e: any) {
    console.log(`\n[ffprobe] Raw file error: ${e.stdout?.toString().slice(0, 300) || e.message}`);
  }

  console.log('\n=== Done ===\n');
}

function analyzeMP4(data: Buffer) {
  console.log('\n[MP4 Box Analysis]');
  let pos = 0;
  let moofCount = 0;

  while (pos + 8 <= data.length) {
    const size = data.readUInt32BE(pos);
    const type = data.subarray(pos + 4, pos + 8).toString('ascii');

    if (size < 8 || pos + size > data.length) {
      console.log(`   ⚠️  Truncated/invalid box at offset ${pos}: size=${size} type=${type}`);
      break;
    }

    if (type === 'moof') moofCount++;

    // Only log the first few and last few
    if (moofCount <= 3 || type !== 'moof') {
      console.log(`   ${type} @ ${pos} (${size} bytes)`);
    } else if (moofCount === 4) {
      console.log(`   ... (more moof boxes)`);
    }

    pos += size;
  }

  if (moofCount > 0) {
    console.log(`   Total moof (fragments): ${moofCount}`);
    console.log(`   ⚠️  Fragmented MP4 — defragmentation needed`);
  } else {
    console.log(`   ✅ Regular MP4 — no defragmentation needed`);
  }
}

main().catch(console.error);
