/**
 * YouTube InnerTube API Constants
 * Migrated from MediaServiceCore/youtubeapi
 */

// ==================== URLS ====================

export const URLS = {
  YT_BASE: 'https://www.youtube.com',
  YT_MUSIC_BASE: 'https://music.youtube.com',
  YT_SUGGESTIONS: 'https://suggestqueries-clients6.youtube.com',
  YT_UPLOAD: 'https://upload.youtube.com/',
  GOOGLE_SEARCH_BASE: 'https://www.google.com/',
  API: {
    BASE: 'https://youtubei.googleapis.com',
    PRODUCTION_1: 'https://www.youtube.com/youtubei/',
    PRODUCTION_2: 'https://youtubei.googleapis.com/youtubei/',
    STAGING: 'https://green-youtubei.sandbox.googleapis.com/youtubei/',
    RELEASE: 'https://release-youtubei.sandbox.googleapis.com/youtubei/',
    TEST: 'https://test-youtubei.sandbox.googleapis.com/youtubei/',
    CAMI: 'http://cami-youtubei.sandbox.googleapis.com/youtubei/',
    UYTFE: 'https://uytfe.sandbox.google.com/youtubei/',
  },
} as const;

// ==================== CLIENT DEFINITIONS ====================

export interface ClientConfig {
  NAME: string;
  VERSION: string;
  SDK_VERSION?: number;
  DEVICE_MODEL?: string;
  USER_AGENT?: string;
  OS_NAME?: string;
  OS_VERSION?: string;
  API_KEY?: string;
  API_VERSION: string;
  STATIC_VISITOR_ID?: string;
  SUGG_EXP_ID?: string;
}

export const CLIENTS: Record<string, ClientConfig> = {
  IOS: {
    NAME: 'iOS',
    VERSION: '20.11.6',
    USER_AGENT: 'com.google.ios.youtube/20.11.6 (iPhone10,4; U; CPU iOS 16_7_7 like Mac OS X)',
    DEVICE_MODEL: 'iPhone10,4',
    OS_NAME: 'iOS',
    OS_VERSION: '16.7.7.20H330',
    API_VERSION: 'v1',
  },
  WEB: {
    NAME: 'WEB',
    VERSION: '2.20260623.01.00',
    API_KEY: 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
    API_VERSION: 'v1',
    STATIC_VISITOR_ID: '6zpwvWUNAco',
    SUGG_EXP_ID: 'ytzpb5_e2,ytpo.bo.lqp.elu=1,ytpo.bo.lqp.ecsc=1,ytpo.bo.lqp.mcsc=3,ytpo.bo.lqp.mec=1,ytpo.bo.lqp.rw=0.8,ytpo.bo.lqp.fw=0.2,ytpo.bo.lqp.szp=1,ytpo.bo.lqp.mz=3,ytpo.bo.lqp.al=en_us,ytpo.bo.lqp.zrm=1,ytpo.bo.lqp.er=1,ytpo.bo.ro.erl=1,ytpo.bo.ro.mlus=3,ytpo.bo.ro.erls=3,ytpo.bo.qfo.mlus=3,ytzprp.ppp.e=1,ytzprp.ppp.st=772,ytzprp.ppp.p=5',
  },
  MWEB: {
    NAME: 'MWEB',
    VERSION: '2.20260205.04.01',
    API_VERSION: 'v1',
  },
  WEB_KIDS: {
    NAME: 'WEB_KIDS',
    VERSION: '2.20260205.00.00',
    API_VERSION: 'v1',
  },
  YTMUSIC: {
    NAME: 'WEB_REMIX',
    VERSION: '1.20250219.01.00',
    API_VERSION: 'v1',
  },
  ANDROID: {
    NAME: 'ANDROID',
    VERSION: '21.03.36',
    SDK_VERSION: 36,
    USER_AGENT: 'com.google.android.youtube/21.03.36(Linux; U; Android 16; en_US; SM-S908E Build/TP1A.220624.014) gzip',
    API_VERSION: 'v1',
  },
  YTSTUDIO_ANDROID: {
    NAME: 'ANDROID_CREATOR',
    VERSION: '22.43.101',
    API_VERSION: 'v1',
  },
  YTMUSIC_ANDROID: {
    NAME: 'ANDROID_MUSIC',
    VERSION: '5.34.51',
    API_VERSION: 'v1',
  },
  TV: {
    NAME: 'TVHTML5',
    VERSION: '7.20260311.12.00',
    USER_AGENT: 'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version',
    API_VERSION: 'v1',
  },
  TV_SIMPLY: {
    NAME: 'TVHTML5_SIMPLY',
    VERSION: '1.0',
    API_VERSION: 'v1',
  },
  TV_EMBEDDED: {
    NAME: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
    VERSION: '2.0',
    API_VERSION: 'v1',
  },
  WEB_EMBEDDED: {
    NAME: 'WEB_EMBEDDED_PLAYER',
    VERSION: '1.20260206.01.00',
    API_KEY: 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
    API_VERSION: 'v1',
    STATIC_VISITOR_ID: '6zpwvWUNAco',
  },
  WEB_CREATOR: {
    NAME: 'WEB_CREATOR',
    VERSION: '1.20241203.01.00',
    API_KEY: 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
    API_VERSION: 'v1',
    STATIC_VISITOR_ID: '6zpwvWUNAco',
  },
};

/**
 * Maps client NAME -> numeric ID used in X-Youtube-Client-Name header
 */
export const CLIENT_NAME_IDS: Record<string, string> = {
  'iOS': '5',
  'WEB': '1',
  'MWEB': '2',
  'WEB_KIDS': '76',
  'WEB_REMIX': '67',
  'ANDROID': '3',
  'ANDROID_CREATOR': '14',
  'ANDROID_MUSIC': '21',
  'TVHTML5': '7',
  'TVHTML5_SIMPLY': '74',
  'TVHTML5_SIMPLY_EMBEDDED_PLAYER': '85',
  'WEB_EMBEDDED_PLAYER': '56',
  'WEB_CREATOR': '62',
};

export const SUPPORTED_CLIENTS = [
  'IOS', 'WEB', 'MWEB', 'YTKIDS', 'YTMUSIC',
  'ANDROID', 'YTSTUDIO_ANDROID', 'YTMUSIC_ANDROID',
  'TV', 'TV_SIMPLY', 'TV_EMBEDDED', 'WEB_EMBEDDED', 'WEB_CREATOR',
];
