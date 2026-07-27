# @minip/source-youtube

YouTube Music source plugin for the Minip music player.

## Project Structure

```
├── package.json          # Project metadata & scripts
├── tsconfig.json         # TypeScript configuration
├── manifest.json         # Source metadata for the app
├── src/
│   ├── index.ts          # Source implementation
│   ├── types/            # SDK type definitions
│   └── ytbapi/           # Lightweight browse/search adapter
├── scripts/
│   └── smoke-test.mjs    # Live bundle/media/range test
└── dist/                 # Build output (gitignored)
    └── youtube.bundle.js
```

## Development

### Setup

```bash
cd sources/youtube
npm install
```

### Type-check

```bash
npm run typecheck
```

### Build

```bash
# Single build (minified)
npm run build
```

### Live smoke test

```bash
npm run test:smoke
```

### Output

The build produces `dist/youtube.bundle.js` — a single standalone JavaScript
file that includes all dependencies (YouTube.js is bundled inline).

The smoke test builds that exact bundle, resolves a known video's download and
stream metadata, verifies a non-zero HTTP range request for resume support, and
checks search output.

## Deployment

1. Build the bundle: `npm run build`
2. Upload `dist/youtube.bundle.js` to any CDN or static hosting
3. Update `manifest.json` with the correct `bundleUrl`
4. Users install the source by providing the manifest URL in the app

## How It Works

The source exports a factory function that receives a `SourceHost` object
from the app at runtime:

```typescript
export default function createYouTubeSource(host: SourceHost): MediaSource {
  // Use host.fetch, host.storage, host.log, etc.
  // Return a MediaSource with audio, video, search, feed, suggestions
}
```

**Key constraints:**
- No `@/` imports — the bundle is sandboxed
- All native capabilities come through `SourceHost`
- The `src/types/` directory serves as the SDK contract

## Creating Your Own Source

Use the `src/types/` directory as your SDK:

```typescript
import type { SourceHost, MediaSource } from './src/types';

export default function createMySource(host: SourceHost): MediaSource {
  return {
    id: 'my-source',
    name: 'My Source',
    version: '1.0.0',
    capabilities: {
      audio: true,
      video: false,
      search: true,
      feed: false,
      suggestions: false,
      playlists: false,
      movies: false,
      subtitles: false,
    },
    async initialize() { /* setup */ },
    async dispose() { /* cleanup */ },
    async getStreamUrl(contentId) { /* resolve a playback URL */ },
    async getDownloadUrl(contentId) { /* direct download URL + size */ },
    async search(query) { /* return MediaItem[] */ },
  };
}
```
