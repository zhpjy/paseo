export type HostPortParts = {
  host: string;
  port: number;
  isIpv6: boolean;
};

export type RelayRole = "server" | "client";
export type RelayProtocolVersion = "1" | "2";

export const CURRENT_RELAY_PROTOCOL_VERSION: RelayProtocolVersion = "2";

export function normalizeRelayProtocolVersion(
  value: unknown,
  fallback: RelayProtocolVersion = CURRENT_RELAY_PROTOCOL_VERSION,
): RelayProtocolVersion {
  if (value == null) {
    return fallback;
  }

  const normalized =
    typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
  if (!normalized) {
    return fallback;
  }
  if (normalized === "1" || normalized === "2") {
    return normalized;
  }
  throw new Error('Relay version must be "1" or "2"');
}

function parsePort(portStr: string, context: string): number {
  const port = Number(portStr);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${context}: port must be between 1 and 65535`);
  }
  return port;
}

export function parseHostPort(input: string): HostPortParts {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Host is required");
  }

  // IPv6: [::1]:6767
  if (trimmed.startsWith("[")) {
    const match = trimmed.match(/^\[([^\]]+)\]:(\d{1,5})$/);
    if (!match) {
      throw new Error("Invalid host:port (expected [::1]:6767)");
    }
    const host = match[1].trim();
    if (!host) throw new Error("Host is required");
    const port = parsePort(match[2], "Invalid host:port");
    return { host, port, isIpv6: true };
  }

  const match = trimmed.match(/^(.+):(\d{1,5})$/);
  if (!match) {
    throw new Error("Invalid host:port (expected localhost:6767)");
  }
  const host = match[1].trim();
  if (!host) throw new Error("Host is required");
  const port = parsePort(match[2], "Invalid host:port");
  return { host, port, isIpv6: false };
}

export function normalizeHostPort(input: string): string {
  const { host, port, isIpv6 } = parseHostPort(input);
  return isIpv6 ? `[${host}]:${port}` : `${host}:${port}`;
}

function normalizeLoopbackHost(input: { host: string; isIpv6: boolean }): string {
  if (input.host === "127.0.0.1" || (!input.isIpv6 && input.host === "0.0.0.0")) {
    return "localhost";
  }
  if (input.isIpv6 && (input.host === "::1" || input.host === "::")) {
    return "localhost";
  }
  return input.host;
}

function normalizeUrlHostname(hostname: string): { host: string; isIpv6: boolean } {
  const trimmed = hostname.trim();
  const unwrapped =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  return { host: unwrapped, isIpv6: unwrapped.includes(":") };
}

export function normalizeLoopbackToLocalhost(endpoint: string): string {
  const { host, port, isIpv6 } = parseHostPort(endpoint);
  const normalizedHost = normalizeLoopbackHost({ host, isIpv6 });
  return normalizedHost === host ? endpoint : `${normalizedHost}:${port}`;
}

type DirectDaemonEndpointParts = {
  endpoint: string;
  host: string;
  port: number;
  isIpv6: boolean;
  secure: boolean;
};

function parseDirectDaemonEndpoint(input: string): DirectDaemonEndpointParts {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Host is required");
  }

  if (trimmed.includes("://") && !trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
    throw new Error("Direct endpoint URL must use http:// or https://");
  }

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error("Invalid direct endpoint URL");
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Direct endpoint URL must use http:// or https://");
    }
    if ((parsed.pathname && parsed.pathname !== "/") || parsed.search || parsed.hash) {
      throw new Error("Direct endpoint URL must not include a path, query, or hash");
    }
    if (parsed.username || parsed.password) {
      throw new Error("Direct endpoint URL must not include credentials");
    }

    const { host, isIpv6 } = normalizeUrlHostname(parsed.hostname);
    if (!host) {
      throw new Error("Host is required");
    }
    const normalizedHost = normalizeLoopbackHost({ host, isIpv6 });
    const port = parsed.port
      ? parsePort(parsed.port, "Invalid direct endpoint URL")
      : parsed.protocol === "https:"
        ? 443
        : 80;
    const hostPart = normalizedHost.includes(":") ? `[${normalizedHost}]` : normalizedHost;
    return {
      endpoint: `${parsed.protocol}//${hostPart}:${port}`,
      host: normalizedHost,
      port,
      isIpv6: normalizedHost.includes(":"),
      secure: parsed.protocol === "https:",
    };
  }

  const normalizedHostPort = normalizeLoopbackToLocalhost(normalizeHostPort(trimmed));
  const { host, port, isIpv6 } = parseHostPort(normalizedHostPort);
  return {
    endpoint: normalizedHostPort,
    host,
    port,
    isIpv6,
    secure: shouldUseSecureWebSocket(port),
  };
}

export function normalizeDirectDaemonEndpoint(input: string): string {
  return parseDirectDaemonEndpoint(input).endpoint;
}

export function deriveLabelFromEndpoint(endpoint: string): string {
  try {
    return parseDirectDaemonEndpoint(endpoint).host || "Unnamed Host";
  } catch {
    return "Unnamed Host";
  }
}

function shouldUseSecureWebSocket(port: number): boolean {
  return port === 443;
}

export function buildDaemonWebSocketUrl(endpoint: string): string {
  const { host, port, isIpv6, secure } = parseDirectDaemonEndpoint(endpoint);
  const protocol = secure ? "wss" : "ws";
  const hostPart = isIpv6 ? `[${host}]` : host;
  return new URL(`${protocol}://${hostPart}:${port}/ws`).toString();
}

export function buildDaemonHttpUrl(endpoint: string): string {
  const { host, port, isIpv6, secure } = parseDirectDaemonEndpoint(endpoint);
  const protocol = secure ? "https" : "http";
  const hostPart = isIpv6 ? `[${host}]` : host;
  return new URL(`${protocol}://${hostPart}:${port}/`).toString();
}

export function buildRelayWebSocketUrl(params: {
  endpoint: string;
  serverId: string;
  role: RelayRole;
  /**
   * Per-connection routing identifier used by the daemon to open server data sockets.
   * Clients should NOT provide this — the relay assigns a routing ID on connect.
   */
  connectionId?: string;
  version?: RelayProtocolVersion | 1 | 2;
}): string {
  const { host, port, isIpv6 } = parseHostPort(params.endpoint);
  const protocol = shouldUseSecureWebSocket(port) ? "wss" : "ws";
  const hostPart = isIpv6 ? `[${host}]` : host;
  const url = new URL(`${protocol}://${hostPart}:${port}/ws`);
  url.searchParams.set("serverId", params.serverId);
  url.searchParams.set("role", params.role);
  url.searchParams.set("v", normalizeRelayProtocolVersion(params.version));
  if (params.connectionId) {
    url.searchParams.set("connectionId", params.connectionId);
  }
  return url.toString();
}

export function extractHostPortFromWebSocketUrl(wsUrl: string): string {
  const parsed = new URL(wsUrl);
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error("Invalid WebSocket URL protocol");
  }
  if (parsed.pathname.replace(/\/+$/, "") !== "/ws") {
    throw new Error("Invalid WebSocket URL (expected /ws path)");
  }

  const host = parsed.hostname;
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === "wss:" ? 443 : 80;
  if (!host) {
    throw new Error("Invalid WebSocket URL (missing hostname)");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid WebSocket URL (invalid port)");
  }

  const isIpv6 = host.includes(":") && !host.startsWith("[") && !host.endsWith("]");
  return isIpv6 ? `[${host}]:${port}` : `${host}:${port}`;
}

export function isRelayClientWebSocketUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("role") === "client" && parsed.searchParams.has("serverId");
  } catch {
    return false;
  }
}
