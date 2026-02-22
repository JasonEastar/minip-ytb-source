/**
 * Utility functions
 * Migrated from Utils.kt
 */

/**
 * Finds a string between two delimiters.
 */
export function getStringBetweenStrings(
  data: string,
  startString: string,
  endString: string,
): string | null {
  const regex = new RegExp(
    escapeStringRegexp(startString) + '(.*?)' + escapeStringRegexp(endString),
    's',
  );
  const match = data.match(regex);
  return match ? match[1] : null;
}

/**
 * Escapes a string to be used in a regex.
 */
export function escapeStringRegexp(input: string): string {
  return input.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&').replace(/-/g, '\\x2d');
}

/**
 * Generates a random string of the given length using URL-safe characters.
 */
export function generateRandomString(length: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return result;
}

/**
 * Simple URL query string parser/builder (platform-agnostic, no `URL` dependency).
 */
export class UrlQueryString {
  private base: string;
  private params: Map<string, string>;

  constructor(url: string) {
    const idx = url.indexOf('?');
    if (idx === -1) {
      this.base = url;
      this.params = new Map();
    } else {
      this.base = url.substring(0, idx);
      this.params = new Map();
      const qs = url.substring(idx + 1);
      for (const part of qs.split('&')) {
        const eqIdx = part.indexOf('=');
        if (eqIdx === -1) {
          this.params.set(decodeURIComponent(part), '');
        } else {
          this.params.set(
            decodeURIComponent(part.substring(0, eqIdx)),
            decodeURIComponent(part.substring(eqIdx + 1)),
          );
        }
      }
    }
  }

  get(key: string): string | undefined {
    return this.params.get(key);
  }

  set(key: string, value: string): void {
    this.params.set(key, value);
  }

  delete(key: string): void {
    this.params.delete(key);
  }

  toString(): string {
    const pairs: string[] = [];
    this.params.forEach((value, key) => {
      pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    });
    return pairs.length > 0 ? `${this.base}?${pairs.join('&')}` : this.base;
  }
}
