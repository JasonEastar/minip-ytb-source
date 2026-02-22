/**
 * InnerTube Context builder
 * Migrated from InnertubeContext.kt
 */

import type { SessionArgs, DeviceInfo } from './types.js';
import { CLIENTS } from './constants.js';

export interface InnertubeContext {
  client: InnertubeClient;
  user: InnertubeUser;
  request: InnertubeRequest;
}

export interface InnertubeClient {
  hl: string;
  gl: string;
  remoteHost?: string;
  screenDensityFloat: number;
  screenHeightPoints: number;
  screenPixelDensity: number;
  screenWidthPoints: number;
  visitorData?: string;
  clientName: string;
  clientVersion?: string;
  osName?: string;
  osVersion?: string;
  androidSdkVersion?: number;
  userAgent?: string;
  platform: string;
  clientFormFactor: string;
  userInterfaceTheme: string;
  timeZone?: string;
  originalUrl: string;
  deviceMake?: string;
  deviceModel?: string;
  browserName?: string;
  browserVersion?: string;
  utcOffsetMinutes: number;
  memoryTotalKbytes: string;
  rolloutToken?: string;
  deviceExperimentId?: string;
  mainAppWebInfo: {
    graftUrl: string;
    pwaInstallabilityStatus: string;
    webDisplayMode: string;
    isWebNativeShareAvailable: boolean;
  };
  configInfo?: {
    appInstallData: string;
    coldConfigData?: string;
    coldHashData?: string;
    hotHashData?: string;
  };
}

export interface InnertubeUser {
  enableSafetyMode: boolean;
  lockedSafetyMode: boolean;
}

export interface InnertubeRequest {
  useSsl: boolean;
  internalExperimentFlags: string[];
}

export function buildInnertubeContext(
  options: SessionArgs,
  deviceInfo: DeviceInfo,
): InnertubeContext {
  const clientName = options.clientName;
  const clientConfig = CLIENTS[clientName.toUpperCase()];

  const clientVersion =
    clientName === 'WEB'
      ? deviceInfo.clientVersion
      : clientConfig?.VERSION ?? deviceInfo.clientVersion;

  return {
    client: {
      hl: options.lang ?? deviceInfo.hl ?? 'en',
      gl: options.location ?? deviceInfo.gl ?? 'US',
      remoteHost: deviceInfo.remoteHost,
      screenDensityFloat: 1,
      screenHeightPoints: 1440,
      screenPixelDensity: 1,
      screenWidthPoints: 2560,
      visitorData: options.visitorData ?? deviceInfo.visitorData,
      clientName: clientName,
      clientVersion: clientVersion,
      osName: deviceInfo.osName,
      osVersion: deviceInfo.osVersion,
      userAgent: options.userAgent,
      platform: options.deviceCategory.toUpperCase(),
      clientFormFactor: 'UNKNOWN_FORM_FACTOR',
      userInterfaceTheme: 'USER_INTERFACE_THEME_LIGHT',
      timeZone: deviceInfo.timeZone ?? options.timeZone,
      originalUrl: 'https://www.youtube.com',
      deviceMake: deviceInfo.deviceMake,
      deviceModel: deviceInfo.deviceModel,
      browserName: deviceInfo.browserName,
      browserVersion: deviceInfo.browserVersion,
      utcOffsetMinutes: -Math.floor(new Date().getTimezoneOffset()),
      memoryTotalKbytes: '8000000',
      rolloutToken: deviceInfo.rolloutToken,
      deviceExperimentId: deviceInfo.deviceExperimentId,
      mainAppWebInfo: {
        graftUrl: 'https://www.youtube.com',
        pwaInstallabilityStatus: 'PWA_INSTALLABILITY_STATUS_UNKNOWN',
        webDisplayMode: 'WEB_DISPLAY_MODE_BROWSER',
        isWebNativeShareAvailable: true,
      },
      configInfo: deviceInfo.appInstallData
        ? { appInstallData: deviceInfo.appInstallData }
        : undefined,
    },
    user: {
      enableSafetyMode: options.enableSafetyMode,
      lockedSafetyMode: false,
    },
    request: {
      useSsl: true,
      internalExperimentFlags: [],
    },
  };
}
