#!/usr/bin/env node
/**
 * Listen test — runs the built bundle like a host would, on this machine:
 * search YouTube, pick a result, resolve the download URL, save the audio
 * and play it with macOS `afplay` (on other OSes it prints the file path).
 *
 *   npm run build
 *   node scripts/play.mjs "son tung mtp"            # interactive pick
 *   node scripts/play.mjs "son tung mtp" 2          # pick result #2
 *   node scripts/play.mjs "son tung mtp" 2 --seconds 10
 *
 * No PO-token host is wired in here, so videos that need browser attestation
 * fail with "No verified direct audio URL"; the smoke test covers that path.
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const require = createRequire(import.meta.url);
const BUNDLE = new URL('../dist/youtube.bundle.js', import.meta.url);
const OUT_DIR = join(tmpdir(), 'minip-play');

const args = process.argv.slice(2);
const secondsFlag = args.indexOf('--seconds');
const playSeconds = secondsFlag >= 0 ? Number(args.splice(secondsFlag, 2)[1]) : 0;
const [query, pickArg] = args;

if (!query) {
  console.error('usage: node scripts/play.mjs "<search query>" [result number] [--seconds N]');
  process.exit(2);
}
if (!existsSync(BUNDLE)) {
  console.error('dist/youtube.bundle.js missing: run `npm run build` first');
  process.exit(2);
}

// youtubei.js/react-native expects an MMKV-like class on the global.
globalThis.mmkvStorage = class {
  constructor() {
    this.store = new Map();
  }
  getBuffer(key) {
    return this.store.get(key);
  }
  set(key, value) {
    this.store.set(key, value);
  }
  delete(key) {
    this.store.delete(key);
  }
};

const factory = require('../dist/youtube.bundle.js');
const source = factory({
  platform: 'ios',
  fetch: (input, init) => globalThis.fetch(input, init),
  writeCacheFile: (filename, content) => {
    mkdirSync(OUT_DIR, { recursive: true });
    const path = join(OUT_DIR, filename);
    writeFile(path, content);
    return path;
  },
  youtube: {
    evaluatePlayerScript: async ({ output }) => new Function(output)(),
  },
  log: (...parts) => console.log('  [source]', ...parts),
});

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = String(seconds % 60).padStart(2, '0');
  return `${m}:${s}`;
}

async function pickResult(items) {
  if (pickArg) return items[Number(pickArg) - 1];
  if (!stdin.isTTY) return items[0];
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(`Pick 1-${items.length} [1]: `);
    return items[(Number(answer) || 1) - 1];
  } finally {
    rl.close();
  }
}

async function downloadAudio(item) {
  const info = await source.getDownloadUrl(item.contentId);
  const response = await fetch(info.url, { headers: info.headers });
  if (!response.ok) throw new Error(`Download HTTP ${response.status}`);

  const total = info.contentLength || Number(response.headers.get('content-length')) || 0;
  const chunks = [];
  let received = 0;
  for await (const chunk of response.body) {
    chunks.push(chunk);
    received += chunk.length;
    if (total && stdout.isTTY) stdout.write(`\r  downloading ${Math.round((received / total) * 100)}%`);
  }
  if (stdout.isTTY) stdout.write('\n');

  mkdirSync(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, `${item.contentId}.m4a`);
  await writeFile(path, Buffer.concat(chunks));
  return { path, bytes: received };
}

function play(path) {
  if (process.platform !== 'darwin') {
    console.log(`Saved to ${path} (afplay is macOS only; open it with any player)`);
    return Promise.resolve();
  }
  const afplayArgs = playSeconds > 0 ? ['-t', String(playSeconds), path] : [path];
  console.log(`Playing with afplay${playSeconds ? ` for ${playSeconds}s` : ''} (Ctrl+C to stop)`);
  return new Promise((resolve, reject) => {
    const child = spawn('afplay', afplayArgs, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`afplay exit ${code}`))));
  });
}

const startedAt = Date.now();
try {
  await source.initialize();

  const items = (await source.search(query)).slice(0, 10);
  if (items.length === 0) throw new Error(`No results for "${query}"`);
  items.forEach((item, index) => {
    console.log(
      `${String(index + 1).padStart(2)}. ${item.title} — ${item.artist} (${formatDuration(item.duration)})`
    );
  });

  const item = await pickResult(items);
  if (!item) throw new Error('Invalid pick');
  console.log(`\nResolving "${item.title}" (${item.contentId})`);

  const { path, bytes } = await downloadAudio(item);
  console.log(`Saved ${(bytes / 1024 / 1024).toFixed(2)} MB to ${path} in ${Date.now() - startedAt} ms`);
  await play(path);
} finally {
  await source.dispose();
}
