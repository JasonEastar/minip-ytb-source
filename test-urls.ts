/**
 * Test: compare IOS vs ANDROID client URLs for download.
 * Usage: npx tsx test-urls.ts [videoId]
 */
import { InnertubeService } from './src/ytbapi/index.js';
import { writeFileSync } from 'fs';
import { execSync } from 'child_process';

const VIDEO_ID = process.argv[2] || 'dQw4w9WgXcQ';

async function testClient(yt: InnertubeService, client: string, videoId: string) {
  console.log(`\n--- ${client} client ---`);
  const info = await yt.getVideoInfo(videoId, client);
  if (!info) { console.log('❌ Failed to get info'); return; }

  const audioFormats = (info.adaptiveFormats ?? [])
    .filter((f: any) => f.url && f.mimeType?.startsWith('audio/'))
    .sort((a: any, b: any) => parseInt(b.bitrate || '0') - parseInt(a.bitrate || '0'));

  console.log(`Audio formats: ${audioFormats.length}`);
  for (const f of audioFormats) {
    console.log(`  itag=${f.itag} mime=${f.mimeType} bitrate=${f.bitrate} len=${f.contentLength}`);
  }

  if (audioFormats.length === 0) return;

  const best = audioFormats[0];
  const contentLength = parseInt(best.contentLength || '0');
  const ua = client === 'IOS'
    ? 'com.google.ios.youtube/20.11.6 (iPhone10,4; U; CPU iOS 16_7_7 like Mac OS X)'
    : 'com.google.android.youtube/19.29.37 (Linux; U; Android 14) gzip';

  // Try downloading
  try {
    const resp = await fetch(best.url!, {
      headers: { 'User-Agent': ua, 'Range': `bytes=0-${Math.min(contentLength - 1, 65535)}` },
    });
    console.log(`  Download test: HTTP ${resp.status}, Content-Type: ${resp.headers.get('content-type')}`);
    if (resp.status === 200 || resp.status === 206) {
      const buf = Buffer.from(await resp.arrayBuffer());
      const ftyp = buf.length >= 12 ? buf.subarray(4, 8).toString('ascii') : '??';
      const brand = buf.length >= 12 ? buf.subarray(8, 12).toString('ascii') : '??';
      console.log(`  ✅ Got ${buf.length} bytes, ftyp=${ftyp}, brand=${brand}`);

      // Full download
      const fullResp = await fetch(best.url!, {
        headers: { 'User-Agent': ua, 'Range': `bytes=0-${contentLength - 1}` },
      });
      if (fullResp.status === 200 || fullResp.status === 206) {
        const fullBuf = Buffer.from(await fullResp.arrayBuffer());
        const file = `/tmp/yt-${client.toLowerCase()}-${videoId}.m4a`;
        writeFileSync(file, fullBuf);
        console.log(`  Full download: ${fullBuf.length}/${contentLength} bytes → ${file}`);

        // ffprobe
        try {
          const out = execSync(`ffprobe -v error -show_format "${file}" 2>&1`, { timeout: 10000 }).toString();
          const fmt = out.match(/format_name=(.+)/)?.[1];
          const dur = out.match(/duration=(.+)/)?.[1];
          console.log(`  ffprobe: format=${fmt}, duration=${dur}`);
        } catch (e: any) {
          console.log(`  ffprobe error`);
        }

        // Decode test
        try {
          execSync(`ffmpeg -y -v error -i "${file}" -t 5 -f null /dev/null 2>&1`, { timeout: 15000 });
          console.log(`  ✅ PLAYABLE`);
        } catch {
          console.log(`  ❌ NOT playable`);
        }
      } else {
        console.log(`  ❌ Full download failed: HTTP ${fullResp.status}`);
      }
    } else {
      console.log(`  ❌ Download blocked`);
    }
  } catch (e) {
    console.log(`  ❌ Error:`, e);
  }
}

async function main() {
  const yt = new InnertubeService({ disableDecipher: true });
  console.log(`Testing video: ${VIDEO_ID}`);
  await testClient(yt, 'IOS', VIDEO_ID);
  await testClient(yt, 'ANDROID', VIDEO_ID);
}

main().catch(console.error);
