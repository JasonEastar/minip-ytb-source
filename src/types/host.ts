/**
 * Source Host — what the MiniP WebView runtime provides to the source bundle.
 *
 * The bundle cannot import from the app; every native capability comes
 * through this object. Keep it limited to what the runtime actually supplies
 * (see src/po-token-runtime.ts `createSourceHost`).
 */

export interface SourceHost {
  /** Current platform */
  platform: 'ios' | 'android';

  /** Fetch routed through the app's native transport. */
  fetch: typeof globalThis.fetch;

  /**
   * Write a cache file (e.g. a synthesized HLS playlist) and return a URI the
   * app can hand to its player.
   */
  writeCacheFile(filename: string, content: string): string;

  /** Browser-backed YouTube player evaluation and BotGuard attestation. */
  youtube?: {
    evaluatePlayerScript(request: {
      requestId: string;
      output: string;
    }): Promise<Record<string, unknown>>;
    generatePoToken(request: {
      requestId: string;
      interpreterUrl: string;
      program: string;
      globalName: string;
      contentBindings: string[];
    }): Promise<{
      tokens: Record<string, string>;
      expiresAt: number;
    }>;
  };

  /** Logging forwarded to the app. */
  log(...args: unknown[]): void;
}
