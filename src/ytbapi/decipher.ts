/**
 * YouTube signature deciphering and N-parameter transform.
 *
 * YouTube's player uses a dispatcher function (e.g., `jp`) that calls
 * operations from a helper object (e.g., `pI`) on the input string.
 *
 * The operations are classic string manipulations:
 *   - swap(arr, n): swap first char with char at position n%length
 *   - reverse(arr): reverse the array
 *   - splice(arr, n): remove first n characters
 *
 * This module extracts the helper object and the operation sequence
 * from the player JS, then rebuilds the decipher function.
 *
 * Approach inspired by LuanRT/YouTube.js and yt-dlp.
 */

import type { HttpAdapter } from './http.js';
import type { StreamingFormat } from './types.js';

// ==================== Types ====================

export interface PlayerCache {
  playerId: string;
  sigFunction: ((s: string) => string) | null;
  nFunction: ((n: string) => string) | null;
  signatureTimestamp: string | undefined;
}

let cachedPlayer: PlayerCache | null = null;

// ==================== Helpers ====================

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractBalancedBlock(code: string, startIdx: number): string | undefined {
  let depth = 1;
  let i = startIdx;
  while (i < code.length && depth > 0) {
    const ch = code[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    if ((ch === '"' || ch === "'" || ch === '`') && depth > 0) {
      const q = ch;
      i++;
      while (i < code.length) {
        if (code[i] === '\\') i++;
        else if (code[i] === q) break;
        i++;
      }
    }
    if (depth > 0) i++;
  }
  return depth === 0 ? code.substring(startIdx, i) : undefined;
}

// ==================== Main Extraction ====================

/**
 * Extract the decipher function from player JS.
 *
 * Strategy:
 * 1. Find the F string lookup table to resolve property names
 * 2. Find the dispatcher function (jp) and its body
 * 3. Extract the helper object (pI) with swap/reverse/splice methods
 * 4. Extract the operation sequence from the dispatcher body
 * 5. Build a standalone decipher function
 */
function extractPlayerFunctions(playerJs: string): {
  sigFunction: ((s: string) => string) | null;
  nFunction: ((n: string) => string) | null;
} {
  // ── Step 1: Parse F lookup table ──
  const fMatch = playerJs.match(/var\s+F\s*=\s*'([^']*)'\s*\.split\s*\(\s*";"\s*\)/);
  if (!fMatch) {
    console.warn('[ytbapi] Cannot find F string table, trying classic extraction');
    return tryClassicExtraction(playerJs);
  }
  const F = fMatch[1].split(';');

  // ── Step 2: Find the dispatcher function ──
  const sigUsage = playerJs.match(
    /\b([a-zA-Z0-9_$]+)\((\d+)\s*,\s*decodeURIComponent\([^)]*\.s\)\)/,
  );
  if (!sigUsage) {
    console.warn('[ytbapi] Cannot find sig dispatcher pattern');
    return tryClassicExtraction(playerJs);
  }

  const dispatcherName = sigUsage[1];
  const sigMode = parseInt(sigUsage[2]);

  // Find n-param mode
  let nMode = -1;
  const nPattern = new RegExp(
    `${escapeRegExp(dispatcherName)}\\((\\d+)\\s*,\\s*decodeURIComponent\\([a-zA-Z]\\)\\)`,
    'g',
  );
  for (const m of playerJs.matchAll(nPattern)) {
    const mode = parseInt(m[1]);
    if (mode !== sigMode) { nMode = mode; break; }
  }

  // Extract dispatcher body
  const escaped = escapeRegExp(dispatcherName);
  const dispDef = playerJs.match(
    new RegExp(`${escaped}\\s*=\\s*function\\s*\\(([^)]+)\\)\\s*\\{`),
  );
  if (!dispDef) {
    console.warn(`[ytbapi] Cannot find dispatcher "${dispatcherName}" definition`);
    return tryClassicExtraction(playerJs);
  }

  const dispBodyStart = dispDef.index! + dispDef[0].length;
  const dispBody = extractBalancedBlock(playerJs, dispBodyStart);
  if (!dispBody) {
    console.warn(`[ytbapi] Cannot extract dispatcher body`);
    return tryClassicExtraction(playerJs);
  }

  console.log(`[ytbapi] Found dispatcher "${dispatcherName}" (sig=${sigMode}, n=${nMode})`);

  // ── Step 3: Find the helper object ──
  // The decipher block starts with: var C=U[F[XX]](F[YY]) → U.split("")
  // Followed by helper calls: HELPER[F[AA]](C, NN)
  // We look specifically in the decipher block (after "var C=")
  const decipherBlock = dispBody.match(/var\s+C\s*=\s*[^;]+;([\s\S]*?)Z\s*=\s*C/);
  if (!decipherBlock) {
    console.warn('[ytbapi] Cannot find decipher block in dispatcher');
    return tryClassicExtraction(playerJs);
  }

  const decipherOps = decipherBlock[1];

  // Find helper object: HELPER[F[num]](C,num)
  const helperPattern = /([a-zA-Z_$][a-zA-Z0-9_$]*)\[F\[\d+\]\]\s*\(\s*C\s*,/;
  const helperMatch = decipherOps.match(helperPattern);

  if (!helperMatch) {
    console.warn('[ytbapi] Cannot find helper object reference in decipher block');
    return tryClassicExtraction(playerJs);
  }

  const helperName = helperMatch[1];
  const escapedHelper = escapeRegExp(helperName);

  // Extract helper object definition: var XX={...};
  const helperDef = playerJs.match(
    new RegExp(`var\\s+${escapedHelper}\\s*=\\s*\\{([\\s\\S]*?)\\};`),
  );
  if (!helperDef) {
    console.warn(`[ytbapi] Cannot find helper object "${helperName}" definition`);
    return tryClassicExtraction(playerJs);
  }

  console.log(`[ytbapi] Found helper object "${helperName}"`);

  // ── Step 4: Extract the operation sequence ──
  // Pattern: HELPER[F[num]](C,num)
  const opsPattern = new RegExp(
    `${escapedHelper}\\[F\\[(\\d+)\\]\\]\\(\\s*C\\s*,\\s*(\\d+)\\s*\\)`,
    'g',
  );
  const operations: { method: string; arg: number }[] = [];
  for (const m of decipherOps.matchAll(opsPattern)) {
    const fIndex = parseInt(m[1]);
    const method = F[fIndex];
    const arg = parseInt(m[2]);
    operations.push({ method, arg });
  }

  if (operations.length === 0) {
    console.warn('[ytbapi] No operations found in dispatcher');
    return tryClassicExtraction(playerJs);
  }

  console.log(`[ytbapi] Extracted ${operations.length} operations: ${operations.map(o => `${o.method}(${o.arg})`).join(', ')}`);

  // ── Step 5: Build the decipher function ──
  // Resolve F references in the helper object to actual string values
  let resolvedHelperDef = helperDef[1];
  // Replace F[N] references with actual values
  resolvedHelperDef = resolvedHelperDef.replace(/F\[(\d+)\]/g, (_match, idx) => {
    const val = F[parseInt(idx)];
    return JSON.stringify(val);
  });

  const code = `
var ${helperName} = {${resolvedHelperDef}};
function decipher(input) {
  var C = input.split("");
  ${operations.map(op => `${helperName}.${op.method}(C, ${op.arg});`).join('\n  ')}
  return C.join("");
}
return decipher(s);
`;

  let sigFunction: ((s: string) => string) | null = null;
  try {
    const fn = new Function('s', code);
    // Test
    const testResult = fn('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789');
    if (typeof testResult === 'string' && testResult.length > 0) {
      sigFunction = (s: string) => fn(s) as string;
      console.log('[ytbapi] ✅ Sig decipher function ready');
    }
  } catch (e: any) {
    console.error(`[ytbapi] Sig decipher compilation failed: ${e.message?.substring(0, 200)}`);
  }

  // N-transform uses the same operations, so we reuse the same function
  // Both sig (25) and n-param (24) go through the same code path in the dispatcher
  const nFunction = sigFunction;
  if (nFunction) {
    console.log('[ytbapi] ✅ N-transform function ready (same operations as sig)');
  }

  return { sigFunction, nFunction };
}

/**
 * Classic fallback for older players using split/join pattern.
 */
function tryClassicExtraction(playerJs: string): {
  sigFunction: ((s: string) => string) | null;
  nFunction: ((n: string) => string) | null;
} {
  console.log('[ytbapi] Trying classic split/join extraction...');

  let sigFunction: ((s: string) => string) | null = null;

  // Pattern: XX=function(a){a=a.split("");YY.ZZ(a,N);...;return a.join("")}
  const funcMatch = playerJs.match(
    /([a-zA-Z0-9_$]{2,})=function\(([a-zA-Z])\)\{\2=\2\.split\(""\);([^}]+)return \2\.join\(""\)\}/,
  );

  if (funcMatch) {
    const argName = funcMatch[2];
    const body = funcMatch[3];

    const helperRef = body.match(/([a-zA-Z0-9_$]+)\.[a-zA-Z0-9_$]+\(/);
    if (helperRef) {
      const helperName = helperRef[1];
      const escapedHelper = escapeRegExp(helperName);
      const helperDef = playerJs.match(
        new RegExp(`var\\s+${escapedHelper}\\s*=\\s*\\{([\\s\\S]*?)\\};`),
      );

      if (helperDef) {
        const code = `
          var ${helperName} = {${helperDef[1]}};
          function decipher(${argName}) {
            ${argName} = ${argName}.split("");
            ${body}
            return ${argName}.join("");
          }
          return decipher(s);
        `;
        try {
          const fn = new Function('s', code);
          fn('test_signature');
          sigFunction = (s: string) => fn(s) as string;
          console.log('[ytbapi] ✅ Classic sig decipher extracted');
        } catch (e: any) {
          console.warn(`[ytbapi] Classic extraction failed: ${e.message?.substring(0, 100)}`);
        }
      }
    }
  }

  return { sigFunction, nFunction: null };
}

// ==================== Public API ====================

/**
 * Load and cache player functions for deciphering.
 */
export async function loadPlayerFunctions(
  http: HttpAdapter,
  playerUrl: string,
  playerId: string,
): Promise<PlayerCache> {
  if (cachedPlayer && cachedPlayer.playerId === playerId) {
    return cachedPlayer;
  }

  console.log(`[ytbapi] Loading player JS for deciphering (${playerId})...`);

  const resp = await http.request(playerUrl, {
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    },
  });
  const playerJs = await resp.text();

  const sigTsMatch = playerJs.match(/signatureTimestamp[=:](\d+)/);
  const signatureTimestamp = sigTsMatch?.[1];

  const { sigFunction, nFunction } = extractPlayerFunctions(playerJs);

  cachedPlayer = { playerId, sigFunction, nFunction, signatureTimestamp };
  return cachedPlayer;
}

/**
 * Decipher a single streaming format URL.
 */
export function decipherFormat(
  format: StreamingFormat,
  playerCache: PlayerCache,
): StreamingFormat {
  const result = { ...format };

  // Step 1: Handle signatureCipher / cipher
  if (!result.url && (result.signatureCipher || result.cipher)) {
    const cipherStr = result.signatureCipher || result.cipher;
    if (cipherStr) {
      const params = new URLSearchParams(cipherStr);
      const url = params.get('url');
      const s = params.get('s');
      const sp = params.get('sp') || 'sig';

      if (url && s && playerCache.sigFunction) {
        try {
          const decipheredSig = playerCache.sigFunction(s);
          result.url = `${url}&${sp}=${encodeURIComponent(decipheredSig)}`;
        } catch (e: any) {
          console.error(`[ytbapi] Sig decipher failed for itag ${format.itag}:`, e.message?.substring(0, 100));
          result.url = url;
        }
      } else if (url) {
        result.url = url;
      }
      result.signatureCipher = undefined;
      result.cipher = undefined;
    }
  }

  // Step 2: Transform n-parameter (throttle bypass)
  if (result.url && playerCache.nFunction) {
    try {
      const urlObj = new URL(result.url);
      const nParam = urlObj.searchParams.get('n');
      if (nParam) {
        const transformed = playerCache.nFunction(nParam);
        if (transformed && transformed !== nParam && !transformed.startsWith('enhanced_except_')) {
          urlObj.searchParams.set('n', transformed);
          result.url = urlObj.toString();
        }
      }
    } catch {
      // skip
    }
  }

  return result;
}

/**
 * Decipher all formats at once.
 */
export function decipherAllFormats(
  formats: StreamingFormat[],
  playerCache: PlayerCache,
): StreamingFormat[] {
  return formats.map(f => decipherFormat(f, playerCache));
}

/**
 * Invalidate cached player functions.
 */
export function invalidatePlayerCache(): void {
  cachedPlayer = null;
}
