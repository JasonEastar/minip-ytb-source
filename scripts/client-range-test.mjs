import { ClientType, Innertube } from 'youtubei.js';

const videoId = process.argv[2] || 'mwHnDQQ-nMg';
const clients = ['IOS', 'ANDROID_VR', 'ANDROID', 'TVHTML5', 'TVHTML5_SIMPLY'];
const userAgents = {
  IOS: 'com.google.ios.youtube/20.11.6 (iPhone10,4; U; CPU iOS 16_7_7 like Mac OS X)',
  ANDROID_VR:
    'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
};

const mediaFetch = async (input, init) => {
  let headers = init?.headers;
  if (typeof init?.body === 'string') {
    try {
      const payload = JSON.parse(init.body);
      const clientName = payload?.context?.client?.clientName;
      const userAgent =
        clientName === 'ANDROID_VR'
          ? userAgents.ANDROID_VR
          : clientName === 'iOS'
            ? userAgents.IOS
            : undefined;
      if (userAgent) {
        const adjusted = new Headers(headers);
        adjusted.set('User-Agent', userAgent);
        headers = adjusted;
      }
    } catch {
      // Ignore non-JSON requests.
    }
  }
  return fetch(input, { ...init, headers });
};

const youtube = await Innertube.create({
  client_type: ClientType.WEB,
  enable_session_cache: false,
  fail_fast: false,
  generate_session_locally: false,
  retrieve_innertube_config: false,
  retrieve_player: false,
  fetch: mediaFetch,
});

const results = [];
for (const client of clients) {
  try {
    const info = await youtube.getBasicInfo(videoId, { client });
    const audio = (info.streaming_data?.adaptive_formats || [])
      .filter(
        (format) => format.has_audio && !format.has_video && format.mime_type.includes('audio/mp4')
      )
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
    const contentLength = audio?.content_length || 0;
    const headers = userAgents[client] ? { 'User-Agent': userAgents[client] } : {};
    const ranges = [];

    if (audio?.url && contentLength > 0) {
      for (const start of [0, Math.floor(contentLength / 2)]) {
        const response = await fetch(audio.url, {
          headers: { ...headers, Range: `bytes=${start}-${start + 1023}` },
        });
        await response.body?.cancel();
        ranges.push({
          start,
          status: response.status,
          contentRange: response.headers.get('content-range'),
        });
      }
    }

    let hlsStatus;
    if (info.streaming_data?.hls_manifest_url) {
      const response = await fetch(info.streaming_data.hls_manifest_url, { headers });
      hlsStatus = response.status;
      await response.body?.cancel();
    }

    results.push({
      client,
      playability: info.playability_status?.status,
      hls: Boolean(info.streaming_data?.hls_manifest_url),
      hlsStatus,
      serverAbr: Boolean(info.streaming_data?.server_abr_streaming_url),
      adaptiveFormats: info.streaming_data?.adaptive_formats.length || 0,
      audioItag: audio?.itag,
      directUrl: Boolean(audio?.url),
      contentLength,
      ranges,
    });
  } catch (error) {
    results.push({
      client,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

console.log(JSON.stringify({ videoId, results }, null, 2));
