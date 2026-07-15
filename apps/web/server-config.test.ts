import { describe, expect, it } from "vitest";

import { parseHttpsServerConfig } from "./server-config.mjs";

const validEnvironment = {
  APP_BASE_URL: "https://172.18.209.21:8443",
  AI_WORKLOG_HTTPS_BIND_HOST: "172.18.209.21",
  AI_WORKLOG_TLS_CERT_PATH: "/Users/example/.config/ai-worklog/tls/server.crt",
  AI_WORKLOG_TLS_KEY_PATH: "/Users/example/.config/ai-worklog/tls/server.key"
};

describe("HTTPS server configuration", () => {
  it("parses a fixed IPv4 HTTPS origin", () => {
    expect(parseHttpsServerConfig(validEnvironment)).toEqual({
      baseUrl: "https://172.18.209.21:8443",
      bindHost: "172.18.209.21",
      port: 8443,
      certPath: "/Users/example/.config/ai-worklog/tls/server.crt",
      keyPath: "/Users/example/.config/ai-worklog/tls/server.key"
    });
  });

  it.each([
    ["plain HTTP", { APP_BASE_URL: "http://172.18.209.21:8443" }],
    ["embedded username", { APP_BASE_URL: "https://owner@172.18.209.21:8443" }],
    ["embedded password", { APP_BASE_URL: "https://owner:secret@172.18.209.21:8443" }],
    ["non-root path", { APP_BASE_URL: "https://172.18.209.21:8443/app" }],
    ["query string", { APP_BASE_URL: "https://172.18.209.21:8443?debug=1" }],
    ["fragment", { APP_BASE_URL: "https://172.18.209.21:8443#debug" }],
    ["missing explicit port", { APP_BASE_URL: "https://172.18.209.21" }],
    ["hostname instead of IPv4", { APP_BASE_URL: "https://worklog.local:8443" }],
    ["loopback address", {
      APP_BASE_URL: "https://127.0.0.1:8443",
      AI_WORKLOG_HTTPS_BIND_HOST: "127.0.0.1"
    }],
    ["public address", {
      APP_BASE_URL: "https://8.8.8.8:8443",
      AI_WORKLOG_HTTPS_BIND_HOST: "8.8.8.8"
    }],
    ["wildcard address", {
      APP_BASE_URL: "https://0.0.0.0:8443",
      AI_WORKLOG_HTTPS_BIND_HOST: "0.0.0.0"
    }],
    ["different bind host", { AI_WORKLOG_HTTPS_BIND_HOST: "127.0.0.1" }],
    ["relative certificate", { AI_WORKLOG_TLS_CERT_PATH: "tls/server.crt" }],
    ["relative key", { AI_WORKLOG_TLS_KEY_PATH: "tls/server.key" }],
    ["same certificate and key", {
      AI_WORKLOG_TLS_CERT_PATH: "/tmp/server.pem",
      AI_WORKLOG_TLS_KEY_PATH: "/tmp/server.pem"
    }]
  ])("rejects %s", (_label, override) => {
    expect(() =>
      parseHttpsServerConfig({ ...validEnvironment, ...override })
    ).toThrow("Invalid HTTPS server configuration");
  });

  it.each([
    "APP_BASE_URL",
    "AI_WORKLOG_HTTPS_BIND_HOST",
    "AI_WORKLOG_TLS_CERT_PATH",
    "AI_WORKLOG_TLS_KEY_PATH"
  ])("rejects missing %s", (key) => {
    const environment = { ...validEnvironment } as Record<string, string>;
    delete environment[key];
    expect(() => parseHttpsServerConfig(environment)).toThrow(
      "Invalid HTTPS server configuration"
    );
  });
});
