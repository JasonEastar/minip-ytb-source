# @minip/source-youtube

YouTube source plugin for the MiniP music player. One static JS bundle; the app downloads and runs it. No server, no proxy: metadata and media bytes go straight between the device and Google.

## How it fits together

```
push to main -> GitHub Actions (typecheck, build, test) -> GitHub Release
                  assets: youtube.bundle.js, manifest.json (with bundleSha256), youtube-po-token.json
user adds manifest URL in MiniP -> app reads bundleUrl -> downloads bundle
  -> evaluates it in a hidden WebView -> calls search / getStreamUrl / getDownloadUrl / ...
```

- The app has no search, browse or URL-resolution logic. It installs sources from a manifest and calls the methods the bundle exports. It does ship the YouTube-specific WebView runtime built from `src/po-token-runtime.ts`.
- Fixing a YouTube-side break = push to `main`; a new release is built automatically. No app release needed, except for changes to `src/po-token-runtime.ts` (see below).

## What the source does

| Method | Behavior |
|---|---|
| `getStreamUrl` | Verified audio URL. iOS: YouTube HLS or synthesized byte-range HLS. Falls back through several clients, then PO token, then lightweight adapter |
| `getDownloadUrl` | Verified progressive audio URL + content length + `Range: bytes=0-` |
| `search`, `searchGrouped`, `getSearchSuggestions` | Videos and channels |
| `getHomeFeed`, `getCollection`, `getArtist`, `getSuggestions` | Home shelves, playlists, channel pages, related videos |

Not implemented: video playback, subtitles, watch progress.

## Project structure

```
├── manifest.json            source metadata read by the app
├── package.json
├── tsconfig.json
├── rollup.config.mjs        builds the bundle and the WebView runtime asset
├── .github/workflows/build.yml   CI: typecheck -> build -> GitHub Release
├── src/
│   ├── index.ts                 source implementation (createYouTubeSource)
│   ├── indexed-hls-playlist.ts  pure sidx parser + byte-range HLS playlist builder
│   ├── po-token-runtime.ts      app-side WebView runtime (BotGuard + bundle host); NOT in the bundle
│   ├── types/                   SDK contract (SourceHost, MediaSource, media types)
│   └── ytbapi/                  lightweight InnerTube client for browse/search
├── test/                    offline node:test suites (run by CI before release)
├── scripts/                 live-network tests (smoke, client range, local HLS)
└── dist/                    build output (gitignored): youtube.bundle.js, youtube-po-token.json
```

## Development

Requires Node >= 22.18 (type stripping for `.ts` imports in tests).

```bash
npm install
npm run typecheck      # tsc --noEmit
npm run build          # dist/youtube.bundle.js + dist/youtube-po-token.json
npm test               # offline: sidx/HLS unit tests + bundle contract test (needs a build)
npm run test:smoke     # build, then live test against YouTube (network required)
```

### Hear it work

```bash
npm run build
npm run play -- "son tung mtp"          # search, pick a result, download the audio, play it (macOS afplay)
npm run play -- "son tung mtp" 2        # pick result #2 without prompting
```

`scripts/play.mjs` hosts the bundle in Node the way an app would (`fetch`, `writeCacheFile`, player-script eval), then resolves `getDownloadUrl` and saves the `.m4a` under the OS temp dir. It has no PO-token host, so videos that need browser attestation fail here; the smoke test covers that path.

Other scripts (manual):

```bash
node scripts/hls-local-test.mjs [videoId] [out.m3u8]   # dump the synthesized HLS playlist
node scripts/client-range-test.mjs [videoId]           # compare InnerTube clients and range support
```

### Build outputs

| Output | Source | Destination |
|---|---|---|
| `youtube.bundle.js` | `src/index.ts` | `dist/` (CJS, minified, babel targets iOS 12 / Android 21, youtubei.js bundled inline) |
| `youtube-po-token.json` | `src/po-token-runtime.ts` | `dist/` (HTML page as a JSON string). Released alongside the bundle; the app copies it into its assets |

### Tests

- `npm test` (offline, < 1 s): `test/indexed-hls-playlist.test.mjs` feeds spec-built `sidx` boxes to the parser and checks the playlist text byte for byte; `test/bundle-contract.test.mjs` evaluates `dist/youtube.bundle.js` exactly like the WebView runtime does (same `new Function` wrapper, no network) and asserts the export shape, required methods, methods implied by capabilities, metadata equal to `manifest.json`, size under the runtime cap, no external `require`.
- `npm run test:smoke` (live): loads the bundle with a stubbed host and checks download URL + ranged request (206), search, stream URL, two regression video IDs, per-client User-Agents, fresh-URL HLS retry, and that no PO token was needed. Results depend on live YouTube behavior and your IP. CI does not run it; run it before pushing.

## Release and versioning

Every push to `main` runs `.github/workflows/build.yml`:

1. Tag `vYYYY.MM.DD-<run number>`, version `YYYY.MM.DD.<run number>`.
2. Patch `manifest.json` (`version`, `bundleUrl`) inside the runner only.
3. `npm run typecheck`, `npm run build`, `npm test` (a failing test stops the release).
4. Add `bundleSha256` (SHA-256 of `youtube.bundle.js`) to the manifest.
5. Create a GitHub Release with `youtube.bundle.js`, `manifest.json`, `youtube-po-token.json`, marked latest.

`manifest.json` is the single source of truth for `id`, `name`, `version`, `capabilities`: `src/index.ts` imports them, so the bundle always reports the values of the manifest it was built with. The committed manifest keeps `1.4.2` and a `releases/latest` `bundleUrl` (fork owners: change the repository in `bundleUrl`). `bundleSha256` exists only in released manifests; the app does not verify it yet, so today it is informational.

## Host contract and runtime

The source exports a factory that receives a `SourceHost` from the app:

```typescript
export default function createYouTubeSource(host: SourceHost): MediaSource { /* ... */ }
```

Constraints:
- No `@/` imports. The bundle is standalone; native capability comes only through `host` (the browse client is wired to `host.fetch` too).
- `SourceHost` is exactly what the WebView runtime provides: `platform`, `fetch`, `writeCacheFile`, `youtube?`, `log`.
- Method arguments and results cross a JSON `postMessage` bridge: return plain data.
- Protected Google Video URLs use the optional `host.youtube.generatePoToken` (BotGuard in the hidden WebView). Hosts without it keep the token-free mobile-client paths.

Trust model: the app executes whatever the manifest's `bundleUrl` serves. The released manifest carries `bundleSha256`, but until the app checks it there is no integrity verification.

## Creating Your Own Source

Use `src/types/` as the SDK.

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
    async getStreamUrl(contentId) { /* { url, headers?, expiresAt?, isHLS? } */ },
    async getDownloadUrl(contentId) { /* { url, contentLength, headers? } */ },
    async search(query) { /* MediaItem[] */ },
  };
}
```

Required: `id`, `name`, `version`, `capabilities`, `initialize`, `dispose`, `getStreamUrl`, `getDownloadUrl`. Optional: `search`, `searchGrouped`, `getSearchSuggestions`, `getHomeFeed`, `getCollection`, `getArtist`, `getSuggestions`, `getSubtitles`, `reportProgress`, `getWatchProgress`.

Notes:
- `src/types/index.ts` does not re-export every type (for example `SearchResults`, `ArtistInfo`); import those from `src/types/media`.
- Build to a single CommonJS file (`module.exports = factory` or `.default`).
- Publish a `manifest.json` with `id`, `name`, `version`, `bundleUrl`, `capabilities`; keep capabilities identical to the source object.
- Verify URLs before returning them. More rules: `docs/code-standards.md`.

## Documentation

Detailed docs live in `docs/` (note: `/docs/*` is currently gitignored, so these files are not in the repository):

- [Project overview & PDR](docs/project-overview-pdr.md)
- [System architecture](docs/system-architecture.md): plugin contract, release pipeline, WebView bridge, playback cascade, PO token, risks
- [Codebase summary](docs/codebase-summary.md)
- [Code standards](docs/code-standards.md)

## Risks in brief

Remote code execution by design (trust = release URL owner), dependence on undocumented YouTube behavior, and platform-policy/ToS exposure that follows from runtime behavior. See `docs/system-architecture.md` section 9.
