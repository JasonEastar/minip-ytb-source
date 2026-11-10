/**
 * HTTP adapter interface – abstracts away the network layer
 * so this library works on both Node.js (using fetch/node-fetch)
 * and React Native (using the built-in fetch).
 *
 * Consumers can provide their own adapter via InnertubeService options.
 */

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  text(): Promise<string>;
  json(): Promise<any>;
}

export interface HttpAdapter {
  /**
   * Make an HTTP request.
   */
  request(
    url: string,
    options: {
      method: 'GET' | 'POST' | 'HEAD';
      headers?: Record<string, string>;
      body?: string;
    },
  ): Promise<HttpResponse>;
}

/**
 * HTTP adapter backed by a `fetch` implementation.
 * Defaults to the global `fetch`; the source passes `host.fetch` so every
 * request goes through the app's native transport.
 */
export class FetchHttpAdapter implements HttpAdapter {
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(fetchImpl: typeof globalThis.fetch = globalThis.fetch) {
    // Wrap so browser fetch is not invoked as a method of this adapter.
    this.fetchImpl = (input, init) => fetchImpl(input, init);
  }

  async request(
    url: string,
    options: {
      method: 'GET' | 'POST' | 'HEAD';
      headers?: Record<string, string>;
      body?: string;
    },
  ): Promise<HttpResponse> {
    const response = await this.fetchImpl(url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
    });

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key.toLowerCase()] = value;
    });

    return {
      status: response.status,
      headers: responseHeaders,
      text: () => response.text(),
      json: () => response.json(),
    };
  }
}
