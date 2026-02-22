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
 * Default HTTP adapter using the global `fetch` API.
 * Works in Node.js 18+, React Native, and modern browsers.
 */
export class FetchHttpAdapter implements HttpAdapter {
  async request(
    url: string,
    options: {
      method: 'GET' | 'POST' | 'HEAD';
      headers?: Record<string, string>;
      body?: string;
    },
  ): Promise<HttpResponse> {
    const response = await fetch(url, {
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
