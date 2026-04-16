import { describe, expect, test } from "vitest";

import {
  buildDaemonHttpUrl,
  buildDaemonWebSocketUrl,
  buildRelayWebSocketUrl,
  CURRENT_RELAY_PROTOCOL_VERSION,
  normalizeRelayProtocolVersion,
  normalizeDirectDaemonEndpoint,
} from "./daemon-endpoints.js";

describe("direct daemon endpoints", () => {
  test("keeps legacy host:port endpoints normalized", () => {
    expect(normalizeDirectDaemonEndpoint("localhost:6767")).toBe("localhost:6767");
    expect(buildDaemonWebSocketUrl("localhost:6767")).toBe("ws://localhost:6767/ws");
    expect(buildDaemonHttpUrl("localhost:6767")).toBe("http://localhost:6767/");
  });

  test("supports explicit https endpoints on non-443 ports", () => {
    expect(normalizeDirectDaemonEndpoint("https://daemon.example.com:8443")).toBe(
      "https://daemon.example.com:8443",
    );
    expect(buildDaemonWebSocketUrl("https://daemon.example.com:8443")).toBe(
      "wss://daemon.example.com:8443/ws",
    );
    expect(buildDaemonHttpUrl("https://daemon.example.com:8443")).toBe(
      "https://daemon.example.com:8443/",
    );
  });

  test("normalizes default ports when scheme is provided", () => {
    expect(normalizeDirectDaemonEndpoint("https://daemon.example.com")).toBe(
      "https://daemon.example.com:443",
    );
    expect(normalizeDirectDaemonEndpoint("http://daemon.example.com")).toBe(
      "http://daemon.example.com:80",
    );
  });

  test("rejects unsupported direct endpoint schemes and paths", () => {
    expect(() => normalizeDirectDaemonEndpoint("wss://daemon.example.com:8443")).toThrow(
      "Direct endpoint URL must use http:// or https://",
    );
    expect(() => normalizeDirectDaemonEndpoint("https://daemon.example.com:8443/ws")).toThrow(
      "Direct endpoint URL must not include a path, query, or hash",
    );
  });
});

describe("relay websocket URL versioning", () => {
  test("defaults relay URLs to v2", () => {
    const url = new URL(
      buildRelayWebSocketUrl({
        endpoint: "relay.paseo.sh:443",
        serverId: "srv_test",
        role: "client",
      }),
    );

    expect(url.searchParams.get("v")).toBe(CURRENT_RELAY_PROTOCOL_VERSION);
    expect(url.searchParams.has("connectionId")).toBe(false);
  });

  test("includes connectionId when provided (server data sockets)", () => {
    const url = new URL(
      buildRelayWebSocketUrl({
        endpoint: "relay.paseo.sh:443",
        serverId: "srv_test",
        role: "server",
        connectionId: "conn_abc123",
      }),
    );

    expect(url.searchParams.get("connectionId")).toBe("conn_abc123");
  });

  test("allows explicitly requesting v1 relay URLs", () => {
    const url = new URL(
      buildRelayWebSocketUrl({
        endpoint: "relay.paseo.sh:443",
        serverId: "srv_test",
        role: "server",
        version: "1",
      }),
    );

    expect(url.searchParams.get("v")).toBe("1");
  });

  test("normalizes numeric relay versions", () => {
    expect(normalizeRelayProtocolVersion(2)).toBe("2");
    expect(normalizeRelayProtocolVersion(1)).toBe("1");
  });

  test("rejects unsupported relay versions", () => {
    expect(() => normalizeRelayProtocolVersion("3")).toThrow('Relay version must be "1" or "2"');
  });
});
