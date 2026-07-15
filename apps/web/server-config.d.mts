export interface HttpsServerEnvironment {
  APP_BASE_URL?: string;
  AI_WORKLOG_HTTPS_BIND_HOST?: string;
  AI_WORKLOG_TLS_CERT_PATH?: string;
  AI_WORKLOG_TLS_KEY_PATH?: string;
  [key: string]: string | undefined;
}

export interface HttpsServerConfig {
  baseUrl: string;
  bindHost: string;
  port: number;
  certPath: string;
  keyPath: string;
}

export function parseHttpsServerConfig(
  environment: HttpsServerEnvironment
): HttpsServerConfig;
