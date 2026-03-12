import { useSyncExternalStore } from "react";
import {
  DaemonClient,
  type ConnectionState,
  type DaemonClientDiagnosticsEvent,
  type FetchAgentsOptions,
} from "@server/client/daemon-client";
import type { HostConnection, HostProfile } from "@/contexts/daemon-registry-context";
import {
  buildDaemonWebSocketUrl,
  buildRelayWebSocketUrl,
} from "@/utils/daemon-endpoints";
import { measureConnectionLatency } from "@/utils/test-daemon-connection";
import { getOrCreateClientId } from "@/utils/client-id";
import {
  selectBestConnection,
  type ConnectionCandidate,
  type ConnectionProbeState,
} from "@/utils/connection-selection";
import {
  buildLocalDaemonTransportUrl,
  createTauriLocalDaemonTransportFactory,
} from "@/utils/managed-tauri-daemon-transport";
import { createTauriWebSocketTransportFactory } from "@/utils/tauri-daemon-transport";
import { applyFetchedAgentDirectory } from "@/utils/agent-directory-sync";
import { useSessionStore, type Agent } from "@/stores/session-store";
import {
  recordDaemonClientDiagnostics,
  recordHostRuntimeCreateClient,
} from "@/runtime/perf-diagnostics/host-runtime-diagnostics";

export type HostRuntimeConnectionStatus =
  | "idle"
  | "connecting"
  | "online"
  | "offline"
  | "error";

export type ActiveConnection =
  | { type: "directTcp"; endpoint: string; display: string }
  | { type: "directSocket"; endpoint: string; display: "socket" }
  | { type: "directPipe"; endpoint: string; display: "pipe" }
  | { type: "relay"; endpoint: string; display: "relay" };

export type HostRuntimeAgentDirectoryStatus =
  | "idle"
  | "initial_loading"
  | "revalidating"
  | "ready"
  | "error_before_first_success"
  | "error_after_ready";

export type HostRuntimeSnapshot = {
  serverId: string;
  activeConnectionId: string | null;
  activeConnection: ActiveConnection | null;
  connectionStatus: HostRuntimeConnectionStatus;
  client: DaemonClient | null;
  lastError: string | null;
  lastOnlineAt: string | null;
  agentDirectoryStatus: HostRuntimeAgentDirectoryStatus;
  agentDirectoryError: string | null;
  hasEverLoadedAgentDirectory: boolean;
  probeByConnectionId: Map<string, ConnectionProbeState>;
  clientGeneration: number;
};

export function isHostRuntimeConnected(
  snapshot: HostRuntimeSnapshot | null
): boolean {
  return snapshot?.connectionStatus === "online";
}

export function isHostRuntimeDirectoryLoading(
  snapshot: HostRuntimeSnapshot | null
): boolean {
  if (!snapshot) {
    return true;
  }
  if (
    snapshot.agentDirectoryStatus === "initial_loading" ||
    snapshot.agentDirectoryStatus === "revalidating"
  ) {
    return true;
  }
  return (
    !snapshot.hasEverLoadedAgentDirectory &&
    (snapshot.connectionStatus === "connecting" ||
      snapshot.connectionStatus === "online")
  );
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toReasonCode(reason: string | null): string | null {
  if (!reason) {
    return null;
  }
  const normalized = reason.toLowerCase();
  if (normalized.includes("timed out")) {
    return "connect_timeout";
  }
  if (normalized.includes("disposed")) {
    return "disposed";
  }
  if (normalized.includes("client closed") || normalized.includes("client_closed")) {
    return "client_closed";
  }
  if (normalized.includes("transport")) {
    return "transport_error";
  }
  if (normalized.includes("failed to connect")) {
    return "connect_failed";
  }
  return "unknown";
}

function hashForLog(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return `h_${Math.abs(hash).toString(16)}`;
}

export type HostRuntimeControllerDeps = {
  createClient: (input: {
    host: HostProfile;
    connection: HostConnection;
    clientId: string;
    runtimeGeneration: number;
  }) => DaemonClient;
  measureLatency: (input: {
    host: HostProfile;
    connection: HostConnection;
  }) => Promise<number>;
  getClientId: () => Promise<string>;
};

export type HostRuntimeStartOptions = {
  autoProbe?: boolean;
};

const PROBE_TICK_MS = 2_000;
const PROBE_STEADY_MS = 10_000;
const PROBE_MAX_BACKOFF_MS = 30_000;
const ADAPTIVE_SWITCH_THRESHOLD_MS = 40;
const ADAPTIVE_SWITCH_CONSECUTIVE_PROBES = 3;
const DEFAULT_AGENT_DIRECTORY_PAGE_LIMIT = 200;
const AGENT_DIRECTORY_SESSION_RETRY_MS = 150;
const DEFAULT_AGENT_DIRECTORY_SORT: NonNullable<FetchAgentsOptions["sort"]> = [
  { key: "updated_at", direction: "desc" },
];

function readFetchAgentsHasMore(
  pageInfo: Awaited<ReturnType<DaemonClient["fetchAgents"]>>["pageInfo"]
): boolean {
  const page = pageInfo as {
    hasMore?: boolean;
    hasMoreAfter?: boolean;
  };
  if (typeof page.hasMore === "boolean") {
    return page.hasMore;
  }
  if (typeof page.hasMoreAfter === "boolean") {
    return page.hasMoreAfter;
  }
  return false;
}

function readFetchAgentsNextCursor(
  pageInfo: Awaited<ReturnType<DaemonClient["fetchAgents"]>>["pageInfo"]
): string | null {
  const page = pageInfo as {
    nextCursor?: string | null;
    afterCursor?: string | null;
  };
  if (typeof page.nextCursor === "string" && page.nextCursor.length > 0) {
    return page.nextCursor;
  }
  if (typeof page.afterCursor === "string" && page.afterCursor.length > 0) {
    return page.afterCursor;
  }
  return null;
}

function toActiveConnection(connection: HostConnection): ActiveConnection {
  if (connection.type === "directSocket") {
    return {
      type: "directSocket",
      endpoint: connection.path,
      display: "socket",
    };
  }
  if (connection.type === "directPipe") {
    return {
      type: "directPipe",
      endpoint: connection.path,
      display: "pipe",
    };
  }
  if (connection.type === "directTcp") {
    return {
      type: "directTcp",
      endpoint: connection.endpoint,
      display: connection.endpoint,
    };
  }
  return {
    type: "relay",
    endpoint: connection.relayEndpoint,
    display: "relay",
  };
}

type HostRuntimeConnectionMachineState =
  | { tag: "booting" }
  | {
      tag: "connecting";
      activeConnectionId: string;
      activeConnection: ActiveConnection;
    }
  | {
      tag: "online";
      activeConnectionId: string;
      activeConnection: ActiveConnection;
      lastOnlineAt: string;
    }
  | {
      tag: "offline";
      activeConnectionId: string | null;
      activeConnection: ActiveConnection | null;
    }
  | {
      tag: "error";
      activeConnectionId: string | null;
      activeConnection: ActiveConnection | null;
      message: string;
    };

type HostRuntimeConnectionMachineEvent =
  | { type: "select_connection"; connectionId: string; connection: ActiveConnection }
  | { type: "client_state"; state: ConnectionState; lastError: string | null }
  | { type: "connect_failed"; message: string }
  | { type: "no_connections" }
  | { type: "stopped" };

function nextConnectionMachineState(input: {
  state: HostRuntimeConnectionMachineState;
  event: HostRuntimeConnectionMachineEvent;
}): HostRuntimeConnectionMachineState {
  const { state, event } = input;

  if (event.type === "select_connection") {
    return {
      tag: "connecting",
      activeConnectionId: event.connectionId,
      activeConnection: event.connection,
    };
  }

  if (event.type === "connect_failed") {
    return {
      tag: "error",
      activeConnectionId:
        state.tag === "connecting" || state.tag === "online"
          ? state.activeConnectionId
          : state.tag === "offline" || state.tag === "error"
            ? state.activeConnectionId
            : null,
      activeConnection:
        state.tag === "connecting" || state.tag === "online"
          ? state.activeConnection
          : state.tag === "offline" || state.tag === "error"
            ? state.activeConnection
            : null,
      message: event.message,
    };
  }

  if (event.type === "no_connections" || event.type === "stopped") {
    return {
      tag: "offline",
      activeConnectionId: null,
      activeConnection: null,
    };
  }

  const previousActiveConnectionId =
    state.tag === "connecting" || state.tag === "online"
      ? state.activeConnectionId
      : state.tag === "offline" || state.tag === "error"
        ? state.activeConnectionId
        : null;
  const previousActiveConnection =
    state.tag === "connecting" || state.tag === "online"
      ? state.activeConnection
      : state.tag === "offline" || state.tag === "error"
        ? state.activeConnection
        : null;

  if (!previousActiveConnectionId || !previousActiveConnection) {
    return state.tag === "booting"
      ? state
      : {
          tag: "offline",
          activeConnectionId: null,
          activeConnection: null,
        };
  }

  if (event.state.status === "connected") {
    return {
      tag: "online",
      activeConnectionId: previousActiveConnectionId,
      activeConnection: previousActiveConnection,
      lastOnlineAt: new Date().toISOString(),
    };
  }

  if (event.state.status === "connecting" || event.state.status === "idle") {
    return {
      tag: "connecting",
      activeConnectionId: previousActiveConnectionId,
      activeConnection: previousActiveConnection,
    };
  }

  if (event.state.status === "disposed") {
    return {
      tag: "offline",
      activeConnectionId: previousActiveConnectionId,
      activeConnection: previousActiveConnection,
    };
  }

  const reason = event.state.reason ?? event.lastError ?? null;
  if (!reason || reason === "client_closed") {
    return {
      tag: "offline",
      activeConnectionId: previousActiveConnectionId,
      activeConnection: previousActiveConnection,
    };
  }

  return {
    tag: "error",
    activeConnectionId: previousActiveConnectionId,
    activeConnection: previousActiveConnection,
    message: reason,
  };
}

function toSnapshotConnectionPatch(
  state: HostRuntimeConnectionMachineState
): Pick<
  HostRuntimeSnapshot,
  "activeConnectionId" | "activeConnection" | "connectionStatus" | "lastError" | "lastOnlineAt"
> {
  if (state.tag === "booting") {
    return {
      activeConnectionId: null,
      activeConnection: null,
      connectionStatus: "connecting",
      lastError: null,
      lastOnlineAt: null,
    };
  }
  if (state.tag === "connecting") {
    return {
      activeConnectionId: state.activeConnectionId,
      activeConnection: state.activeConnection,
      connectionStatus: "connecting",
      lastError: null,
      lastOnlineAt: null,
    };
  }
  if (state.tag === "online") {
    return {
      activeConnectionId: state.activeConnectionId,
      activeConnection: state.activeConnection,
      connectionStatus: "online",
      lastError: null,
      lastOnlineAt: state.lastOnlineAt,
    };
  }
  if (state.tag === "offline") {
    return {
      activeConnectionId: state.activeConnectionId,
      activeConnection: state.activeConnection,
      connectionStatus: "offline",
      lastError: null,
      lastOnlineAt: null,
    };
  }
  return {
    activeConnectionId: state.activeConnectionId,
    activeConnection: state.activeConnection,
    connectionStatus: "error",
    lastError: state.message,
    lastOnlineAt: null,
  };
}

function buildConnectionCandidates(host: HostProfile): ConnectionCandidate[] {
  return host.connections.map((connection) => ({
    connectionId: connection.id,
    connection,
  }));
}

function findConnectionById(
  host: HostProfile,
  connectionId: string | null
): HostConnection | null {
  if (!connectionId) {
    return null;
  }
  return host.connections.find((connection) => connection.id === connectionId) ?? null;
}

function probeIntervalForConnection(
  firstSeenAt: number,
  isActiveOnline: boolean,
  now: number
): number {
  if (isActiveOnline) {
    return PROBE_STEADY_MS;
  }
  const age = now - firstSeenAt;
  if (age < 10_000) return 2_000;
  if (age < 30_000) return 5_000;
  if (age < 60_000) return PROBE_STEADY_MS;
  return PROBE_MAX_BACKOFF_MS;
}

function createDefaultDeps(): HostRuntimeControllerDeps {
  return {
    createClient: ({ host, connection, clientId, runtimeGeneration }) => {
      recordHostRuntimeCreateClient({
        serverId: host.serverId,
        connectionType: connection.type,
        endpoint:
          connection.type === "directTcp"
            ? connection.endpoint
            : connection.type === "directSocket" || connection.type === "directPipe"
              ? connection.path
            : connection.relayEndpoint,
      });
      const tauriTransportFactory = createTauriWebSocketTransportFactory();
      const localTransportFactory = createTauriLocalDaemonTransportFactory();
      const base = {
        suppressSendErrors: true,
        clientId,
        clientType: "mobile" as const,
        runtimeGeneration,
        onDiagnosticsEvent: (event: DaemonClientDiagnosticsEvent) =>
          recordDaemonClientDiagnostics(host.serverId, event),
      };
      if (connection.type === "directSocket" || connection.type === "directPipe") {
        return new DaemonClient({
          ...base,
          ...(localTransportFactory ? { transportFactory: localTransportFactory } : {}),
          url: buildLocalDaemonTransportUrl({
            transportType: connection.type === "directSocket" ? "socket" : "pipe",
            transportPath: connection.path,
          }),
        });
      }
      if (connection.type === "directTcp") {
        return new DaemonClient({
          ...base,
          ...(tauriTransportFactory
            ? { transportFactory: tauriTransportFactory }
            : {}),
          url: buildDaemonWebSocketUrl(connection.endpoint),
        });
      }
      return new DaemonClient({
        ...base,
        ...(tauriTransportFactory
          ? { transportFactory: tauriTransportFactory }
          : {}),
        url: buildRelayWebSocketUrl({
          endpoint: connection.relayEndpoint,
          serverId: host.serverId,
        }),
        e2ee: {
          enabled: true,
          daemonPublicKeyB64: connection.daemonPublicKeyB64,
        },
      });
    },
    measureLatency: ({ host, connection }) =>
      measureConnectionLatency(connection, { serverId: host.serverId }),
    getClientId: () => getOrCreateClientId(),
  };
}

export class HostRuntimeController {
  private host: HostProfile;
  private deps: HostRuntimeControllerDeps;
  private connectionMachineState: HostRuntimeConnectionMachineState;
  private snapshot: HostRuntimeSnapshot;
  private listeners = new Set<() => void>();
  private activeClient: DaemonClient | null = null;
  private unsubscribeClientStatus: (() => void) | null = null;
  private probeIntervalHandle: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private connectionFirstSeenAt = new Map<string, number>();
  private connectionLastProbedAt = new Map<string, number>();
  private switchCandidateConnectionId: string | null = null;
  private switchCandidateHitCount = 0;
  private clientIdPromise: Promise<string> | null = null;
  private clientIdHash: string | null = null;
  private switchRequestVersion = 0;
  private probeRequestVersion = 0;

  constructor(input: {
    host: HostProfile;
    deps?: HostRuntimeControllerDeps;
  }) {
    this.host = input.host;
    this.deps = input.deps ?? createDefaultDeps();
    this.connectionMachineState = {
      tag: "booting",
    };
    this.snapshot = {
      serverId: this.host.serverId,
      ...toSnapshotConnectionPatch(this.connectionMachineState),
      client: null,
      agentDirectoryStatus: "idle",
      agentDirectoryError: null,
      hasEverLoadedAgentDirectory: false,
      probeByConnectionId: new Map(),
      clientGeneration: 0,
    };
  }

  getSnapshot(): HostRuntimeSnapshot {
    return this.snapshot;
  }

  getClient(): DaemonClient | null {
    return this.snapshot.client;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async start(options?: HostRuntimeStartOptions): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    this.trackConnectionFirstSeen();
    await this.runProbeCycleNow();
    if (options?.autoProbe !== false) {
      this.probeIntervalHandle = setInterval(() => {
        void this.runProbeCycleNow();
      }, PROBE_TICK_MS);
    }
  }

  async stop(): Promise<void> {
    this.switchRequestVersion += 1;
    this.probeRequestVersion += 1;
    this.started = false;
    if (this.probeIntervalHandle) {
      clearInterval(this.probeIntervalHandle);
      this.probeIntervalHandle = null;
    }
    if (this.unsubscribeClientStatus) {
      this.unsubscribeClientStatus();
      this.unsubscribeClientStatus = null;
    }
    if (this.activeClient) {
      const prev = this.activeClient;
      this.activeClient = null;
      await prev.close().catch(() => undefined);
    }
    this.applyConnectionEvent({ type: "stopped" });
    this.updateSnapshot({
      ...toSnapshotConnectionPatch(this.connectionMachineState),
      client: null,
    });
  }

  async updateHost(host: HostProfile): Promise<void> {
    this.host = host;
    this.trackConnectionFirstSeen();
    await this.runProbeCycleNow();
  }

  ensureConnected(): void {
    this.activeClient?.ensureConnected();
  }

  markAgentDirectorySyncLoading(): void {
    const status = this.snapshot.hasEverLoadedAgentDirectory
      ? "revalidating"
      : "initial_loading";
    this.updateSnapshot({
      agentDirectoryStatus: status,
      agentDirectoryError: null,
    });
  }

  markAgentDirectorySyncReady(): void {
    this.updateSnapshot({
      agentDirectoryStatus: "ready",
      agentDirectoryError: null,
      hasEverLoadedAgentDirectory: true,
    });
  }

  markAgentDirectorySyncError(error: string): void {
    const hasEverLoadedAgentDirectory = this.snapshot.hasEverLoadedAgentDirectory;
    this.updateSnapshot({
      agentDirectoryStatus: hasEverLoadedAgentDirectory
        ? "error_after_ready"
        : "error_before_first_success",
      agentDirectoryError: error,
      hasEverLoadedAgentDirectory,
    });
  }

  markAgentDirectorySyncIdle(): void {
    this.updateSnapshot({
      agentDirectoryStatus: this.snapshot.hasEverLoadedAgentDirectory ? "ready" : "idle",
      agentDirectoryError: null,
    });
  }

  markStartupError(message: string): void {
    this.applyConnectionEvent({ type: "connect_failed", message });
    this.updateSnapshot({
      ...toSnapshotConnectionPatch(this.connectionMachineState),
    });
  }

  async runProbeCycleNow(): Promise<void> {
    const requestVersion = ++this.probeRequestVersion;
    if (this.host.connections.length === 0) {
      if (!this.isCurrentProbeRequest(requestVersion)) {
        return;
      }
      this.applyConnectionEvent({ type: "no_connections" });
      this.updateSnapshot({
        ...toSnapshotConnectionPatch(this.connectionMachineState),
        probeByConnectionId: new Map(),
      });
      return;
    }

    const now = performance.now();
    const isOnline = this.snapshot.connectionStatus === "online";
    const activeConnectionId = this.snapshot.activeConnectionId;

    const connectionsToProbe = this.host.connections.filter((connection) => {
      const lastProbed = this.connectionLastProbedAt.get(connection.id);
      if (lastProbed == null) {
        return true;
      }
      const firstSeen = this.connectionFirstSeenAt.get(connection.id) ?? now;
      const isActiveOnline = isOnline && connection.id === activeConnectionId;
      const interval = probeIntervalForConnection(firstSeen, isActiveOnline, now);
      return now - lastProbed >= interval;
    });

    if (connectionsToProbe.length === 0) {
      return;
    }

    const probeByConnectionId = new Map(this.snapshot.probeByConnectionId);
    await Promise.all(
      connectionsToProbe.map(async (connection) => {
        this.connectionLastProbedAt.set(connection.id, performance.now());
        try {
          const latencyMs = await this.deps.measureLatency({
            host: this.host,
            connection,
          });
          probeByConnectionId.set(connection.id, {
            status: "available",
            latencyMs,
          });
        } catch {
          probeByConnectionId.set(connection.id, {
            status: "unavailable",
            latencyMs: null,
          });
        }
      })
    );

    if (!this.isCurrentProbeRequest(requestVersion)) {
      return;
    }
    this.updateSnapshot({ probeByConnectionId });

    const currentActiveConnectionId = this.snapshot.activeConnectionId;
    const activeProbe = currentActiveConnectionId
      ? probeByConnectionId.get(currentActiveConnectionId)
      : null;

    if (!currentActiveConnectionId || !findConnectionById(this.host, currentActiveConnectionId)) {
      const nextConnectionId = selectBestConnection({
        candidates: buildConnectionCandidates(this.host),
        probeByConnectionId,
      });
      if (nextConnectionId) {
        await this.switchToConnection({
          connectionId: nextConnectionId,
          expectedProbeVersion: requestVersion,
        });
      }
      return;
    }

    if (activeProbe?.status === "unavailable") {
      const nextConnectionId = selectBestConnection({
        candidates: buildConnectionCandidates(this.host),
        probeByConnectionId,
      });
      if (nextConnectionId && nextConnectionId !== currentActiveConnectionId) {
        await this.switchToConnection({
          connectionId: nextConnectionId,
          expectedProbeVersion: requestVersion,
        });
      }
      this.switchCandidateConnectionId = null;
      this.switchCandidateHitCount = 0;
      return;
    }

    if (activeProbe && activeProbe.status === "available") {
      const available = Array.from(probeByConnectionId.entries())
        .filter(([, probe]) => probe.status === "available")
        .map(([connectionId, probe]) => ({
          connectionId,
          latencyMs: (probe as { status: "available"; latencyMs: number }).latencyMs,
        }))
        .sort((left, right) => left.latencyMs - right.latencyMs);

      const fastest = available[0] ?? null;
      if (!fastest || fastest.connectionId === currentActiveConnectionId) {
        this.switchCandidateConnectionId = null;
        this.switchCandidateHitCount = 0;
        return;
      }

      const activeLatency = activeProbe.latencyMs;
      const improvement = activeLatency - fastest.latencyMs;
      if (improvement < ADAPTIVE_SWITCH_THRESHOLD_MS) {
        this.switchCandidateConnectionId = null;
        this.switchCandidateHitCount = 0;
        return;
      }

      if (this.switchCandidateConnectionId === fastest.connectionId) {
        this.switchCandidateHitCount += 1;
      } else {
        this.switchCandidateConnectionId = fastest.connectionId;
        this.switchCandidateHitCount = 1;
      }

      if (
        this.switchCandidateHitCount >=
        ADAPTIVE_SWITCH_CONSECUTIVE_PROBES
      ) {
        this.switchCandidateConnectionId = null;
        this.switchCandidateHitCount = 0;
        await this.switchToConnection({
          connectionId: fastest.connectionId,
          expectedProbeVersion: requestVersion,
        });
      }
    }
  }

  private updateSnapshot(
    patch: Partial<Omit<HostRuntimeSnapshot, "serverId" | "clientGeneration">>
  ): void {
    const next: HostRuntimeSnapshot = {
      ...this.snapshot,
      ...patch,
      serverId: this.host.serverId,
    };
    this.snapshot = next;
    for (const listener of this.listeners) {
      listener();
    }
  }

  private applyConnectionEvent(event: HostRuntimeConnectionMachineEvent): void {
    const previousState = this.connectionMachineState;
    const nextState = nextConnectionMachineState({
      state: previousState,
      event,
    });
    this.connectionMachineState = nextState;
    this.logConnectionTransition({
      from: previousState.tag,
      to: nextState.tag,
      event,
    });
  }

  private logConnectionTransition(input: {
    from: HostRuntimeConnectionMachineState["tag"];
    to: HostRuntimeConnectionMachineState["tag"];
    event: HostRuntimeConnectionMachineEvent;
  }): void {
    const { event } = input;
    const reason =
      event.type === "connect_failed"
        ? event.message
        : event.type === "client_state"
          ? event.state.status === "disconnected"
            ? event.state.reason ?? event.lastError ?? null
            : null
          : null;
    const reasonCode =
      event.type === "connect_failed"
        ? "connect_failed"
        : toReasonCode(reason);
    console.info("[HostRuntimeTransition]", {
      serverId: this.host.serverId,
      clientIdHash: this.clientIdHash,
      from: input.from,
      to: input.to,
      event: event.type,
      connectionPath: this.snapshot.activeConnection?.type ?? null,
      generation: this.snapshot.clientGeneration,
      reasonCode,
      reason,
    });
  }

  private trackConnectionFirstSeen(): void {
    const now = performance.now();
    const currentIds = new Set(this.host.connections.map((c) => c.id));
    for (const id of this.connectionFirstSeenAt.keys()) {
      if (!currentIds.has(id)) {
        this.connectionFirstSeenAt.delete(id);
        this.connectionLastProbedAt.delete(id);
      }
    }
    for (const connection of this.host.connections) {
      if (!this.connectionFirstSeenAt.has(connection.id)) {
        this.connectionFirstSeenAt.set(connection.id, now);
      }
    }
  }

  private isCurrentSwitchRequest(version: number): boolean {
    return version === this.switchRequestVersion;
  }

  private isCurrentProbeRequest(version: number): boolean {
    return version === this.probeRequestVersion;
  }

  private canProceedForProbe(
    expectedProbeVersion: number | undefined
  ): boolean {
    if (expectedProbeVersion === undefined) {
      return true;
    }
    return this.isCurrentProbeRequest(expectedProbeVersion);
  }

  private async switchToConnection(input: {
    connectionId: string;
    expectedProbeVersion?: number;
  }): Promise<void> {
    if (!this.canProceedForProbe(input.expectedProbeVersion)) {
      return;
    }
    const { connectionId, expectedProbeVersion } = input;
    const connection = findConnectionById(this.host, connectionId);
    if (!connection) {
      return;
    }
    const requestVersion = ++this.switchRequestVersion;

    let clientId: string;
    try {
      clientId = await this.resolveClientId();
    } catch (error) {
      if (!this.isCurrentSwitchRequest(requestVersion)) {
        return;
      }
      const message = toErrorMessage(error);
      this.applyConnectionEvent({
        type: "connect_failed",
        message: `Failed to resolve client id: ${message}`,
      });
      this.updateSnapshot({
        ...toSnapshotConnectionPatch(this.connectionMachineState),
      });
      return;
    }

    if (!this.isCurrentSwitchRequest(requestVersion)) {
      return;
    }
    if (!this.canProceedForProbe(expectedProbeVersion)) {
      return;
    }

    if (this.unsubscribeClientStatus) {
      this.unsubscribeClientStatus();
      this.unsubscribeClientStatus = null;
    }
    if (this.activeClient) {
      const previousClient = this.activeClient;
      this.activeClient = null;
      await previousClient.close().catch(() => undefined);
    }
    if (!this.isCurrentSwitchRequest(requestVersion)) {
      return;
    }
    if (!this.canProceedForProbe(expectedProbeVersion)) {
      return;
    }

    const nextGeneration = this.snapshot.clientGeneration + 1;
    const client = this.deps.createClient({
      host: this.host,
      connection,
      clientId,
      runtimeGeneration: nextGeneration,
    });
    if (!this.isCurrentSwitchRequest(requestVersion)) {
      await client.close().catch(() => undefined);
      return;
    }
    if (!this.canProceedForProbe(expectedProbeVersion)) {
      await client.close().catch(() => undefined);
      return;
    }
    this.activeClient = client;
    this.applyConnectionEvent({
      type: "select_connection",
      connectionId: connection.id,
      connection: toActiveConnection(connection),
    });
    this.snapshot = {
      ...this.snapshot,
      serverId: this.host.serverId,
      ...toSnapshotConnectionPatch(this.connectionMachineState),
      client,
      clientGeneration: nextGeneration,
    };
    for (const listener of this.listeners) {
      listener();
    }

    this.unsubscribeClientStatus = client.subscribeConnectionStatus((state) => {
      if (
        !this.isCurrentSwitchRequest(requestVersion) ||
        this.activeClient !== client
      ) {
        return;
      }
      this.applyConnectionEvent({
        type: "client_state",
        state,
        lastError: client.lastError,
      });
      const patch: Partial<Omit<HostRuntimeSnapshot, "serverId" | "clientGeneration">> = {
        ...toSnapshotConnectionPatch(this.connectionMachineState),
      };

      if (!this.snapshot.hasEverLoadedAgentDirectory) {
        if (
          this.connectionMachineState.tag === "connecting" ||
          this.connectionMachineState.tag === "online"
        ) {
          patch.agentDirectoryStatus = "initial_loading";
          patch.agentDirectoryError = null;
        } else if (this.connectionMachineState.tag === "error") {
          patch.agentDirectoryStatus = "error_before_first_success";
          patch.agentDirectoryError = this.connectionMachineState.message;
        } else {
          patch.agentDirectoryStatus = "idle";
          patch.agentDirectoryError = null;
        }
      }

      this.updateSnapshot(patch);
    });

    try {
      await client.connect();
    } catch (error) {
      if (
        !this.isCurrentSwitchRequest(requestVersion) ||
        this.activeClient !== client
      ) {
        return;
      }
      const message = toErrorMessage(error);
      this.applyConnectionEvent({
        type: "connect_failed",
        message,
      });
      this.updateSnapshot({
        ...toSnapshotConnectionPatch(this.connectionMachineState),
      });
    }
  }

  private resolveClientId(): Promise<string> {
    if (!this.clientIdPromise) {
      this.clientIdPromise = this.deps.getClientId().then((value) => {
        this.clientIdHash = hashForLog(value);
        return value;
      });
    }
    return this.clientIdPromise;
  }
}

export class HostRuntimeStore {
  private controllers = new Map<string, HostRuntimeController>();
  private serverListeners = new Map<string, Set<() => void>>();
  private globalListeners = new Set<() => void>();
  private version = 0;
  private deps: HostRuntimeControllerDeps;
  private lastConnectionStatusByServer = new Map<string, HostRuntimeConnectionStatus>();
  private agentDirectoryBootstrapInFlight = new Map<string, Promise<void>>();
  private agentDirectorySessionRetryTimerByServer = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  constructor(input?: {
    deps?: HostRuntimeControllerDeps;
  }) {
    this.deps = input?.deps ?? createDefaultDeps();
  }

  syncHosts(hosts: HostProfile[]): void {
    const nextIds = new Set(hosts.map((host) => host.serverId));
    for (const [serverId, controller] of this.controllers) {
      if (nextIds.has(serverId)) {
        continue;
      }
      this.controllers.delete(serverId);
      this.lastConnectionStatusByServer.delete(serverId);
      this.agentDirectoryBootstrapInFlight.delete(serverId);
      this.clearAgentDirectorySessionRetry(serverId);
      void controller.stop();
      this.emit(serverId);
    }

    for (const host of hosts) {
      const existing = this.controllers.get(host.serverId);
      if (existing) {
        void existing.updateHost(host);
        continue;
      }
      const controller = new HostRuntimeController({
        host,
        deps: this.deps,
      });
      this.controllers.set(host.serverId, controller);
      this.lastConnectionStatusByServer.set(
        host.serverId,
        controller.getSnapshot().connectionStatus
      );
      controller.subscribe(() => {
        this.maybeAutoBootstrapAgentDirectory(host.serverId);
        this.emit(host.serverId);
      });
      void controller.start().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        controller.markStartupError(message);
      });
      this.emit(host.serverId);
    }
  }

  private maybeAutoBootstrapAgentDirectory(serverId: string): void {
    const controller = this.controllers.get(serverId);
    if (!controller) {
      this.lastConnectionStatusByServer.delete(serverId);
      this.agentDirectoryBootstrapInFlight.delete(serverId);
      return;
    }
    const snapshot = controller.getSnapshot();
    const previousStatus = this.lastConnectionStatusByServer.get(serverId);
    this.lastConnectionStatusByServer.set(serverId, snapshot.connectionStatus);
    const didTransitionOnline =
      snapshot.connectionStatus === "online" && previousStatus !== "online";
    if (didTransitionOnline) {
      useSessionStore.getState().bumpHistorySyncGeneration(serverId);
    }

    // Runtime owns directory bootstrap policy, including reconnect and delayed
    // session initialization races.
    if (snapshot.connectionStatus !== "online") {
      this.clearAgentDirectorySessionRetry(serverId);
      return;
    }
    if (!didTransitionOnline && snapshot.hasEverLoadedAgentDirectory) {
      this.clearAgentDirectorySessionRetry(serverId);
      return;
    }
    if (this.agentDirectoryBootstrapInFlight.has(serverId)) {
      return;
    }
    if (!useSessionStore.getState().sessions[serverId]) {
      this.scheduleAgentDirectorySessionRetry(serverId);
      return;
    }
    this.clearAgentDirectorySessionRetry(serverId);

    const bootstrap = Promise.resolve()
      .then(() =>
        this.refreshAgentDirectory({
          serverId,
          subscribe: { subscriptionId: `app:${serverId}` },
          page: { limit: DEFAULT_AGENT_DIRECTORY_PAGE_LIMIT },
        })
      )
      .then(() => undefined)
      .catch((error) => {
        console.error("[HostRuntime] agent directory bootstrap failed", {
          serverId,
          error: toErrorMessage(error),
        });
      })
      .finally(() => {
        const inFlight = this.agentDirectoryBootstrapInFlight.get(serverId);
        if (inFlight === bootstrap) {
          this.agentDirectoryBootstrapInFlight.delete(serverId);
        }
      });

    this.agentDirectoryBootstrapInFlight.set(serverId, bootstrap);
  }

  private scheduleAgentDirectorySessionRetry(serverId: string): void {
    if (this.agentDirectorySessionRetryTimerByServer.has(serverId)) {
      return;
    }
    const handle = setTimeout(() => {
      this.agentDirectorySessionRetryTimerByServer.delete(serverId);
      this.maybeAutoBootstrapAgentDirectory(serverId);
    }, AGENT_DIRECTORY_SESSION_RETRY_MS);
    this.agentDirectorySessionRetryTimerByServer.set(serverId, handle);
  }

  private clearAgentDirectorySessionRetry(serverId: string): void {
    const handle = this.agentDirectorySessionRetryTimerByServer.get(serverId);
    if (!handle) {
      return;
    }
    clearTimeout(handle);
    this.agentDirectorySessionRetryTimerByServer.delete(serverId);
  }

  getSnapshot(serverId: string): HostRuntimeSnapshot | null {
    return this.controllers.get(serverId)?.getSnapshot() ?? null;
  }

  getVersion(): number {
    return this.version;
  }

  getClient(serverId: string): DaemonClient | null {
    return this.controllers.get(serverId)?.getClient() ?? null;
  }

  subscribe(serverId: string, listener: () => void): () => void {
    const existing = this.serverListeners.get(serverId) ?? new Set<() => void>();
    existing.add(listener);
    this.serverListeners.set(serverId, existing);
    return () => {
      const set = this.serverListeners.get(serverId);
      if (!set) {
        return;
      }
      set.delete(listener);
      if (set.size === 0) {
        this.serverListeners.delete(serverId);
      }
    };
  }

  subscribeAll(listener: () => void): () => void {
    this.globalListeners.add(listener);
    return () => {
      this.globalListeners.delete(listener);
    };
  }

  ensureConnectedAll(): void {
    for (const controller of this.controllers.values()) {
      controller.ensureConnected();
    }
  }

  runProbeCycleNow(serverId?: string): Promise<void> {
    if (serverId) {
      return this.controllers.get(serverId)?.runProbeCycleNow() ?? Promise.resolve();
    }
    return Promise.all(
      Array.from(this.controllers.values(), (controller) =>
        controller.runProbeCycleNow()
      )
    ).then(() => undefined);
  }

  async refreshAgentDirectory(input: {
    serverId: string;
    filter?: FetchAgentsOptions["filter"];
    subscribe?: FetchAgentsOptions["subscribe"];
    page?: FetchAgentsOptions["page"];
  }): Promise<{
    agents: ReturnType<typeof applyFetchedAgentDirectory>["agents"];
    subscriptionId: string | null;
  }> {
    const controller = this.controllers.get(input.serverId);
    if (!controller) {
      throw new Error(`Unknown host runtime for serverId ${input.serverId}`);
    }
    const snapshot = controller.getSnapshot();
    const client = controller.getClient();
    if (!client || snapshot.connectionStatus !== "online") {
      throw new Error(`Host ${input.serverId} is not connected`);
    }

    controller.markAgentDirectorySyncLoading();
    try {
      const pageLimit = input.page?.limit ?? DEFAULT_AGENT_DIRECTORY_PAGE_LIMIT;
      let cursor = input.page?.cursor ?? null;
      let includeSubscribe = true;
      let subscriptionId: string | null = null;
      const allAgents = new Map<string, Agent>();

      while (true) {
        const payload = await client.fetchAgents({
          filter: input.filter ?? { includeArchived: true },
          sort: DEFAULT_AGENT_DIRECTORY_SORT,
          ...(includeSubscribe && input.subscribe ? { subscribe: input.subscribe } : {}),
          page: cursor ? { limit: pageLimit, cursor } : { limit: pageLimit },
        });

        const pageAgents = applyFetchedAgentDirectory({
          serverId: input.serverId,
          entries: payload.entries,
        }).agents;
        for (const [agentId, agent] of pageAgents) {
          allAgents.set(agentId, agent);
        }

        subscriptionId = subscriptionId ?? payload.subscriptionId ?? null;
        includeSubscribe = false;

        if (!readFetchAgentsHasMore(payload.pageInfo)) {
          break;
        }

        const nextCursor = readFetchAgentsNextCursor(payload.pageInfo);
        if (!nextCursor) {
          break;
        }
        cursor = nextCursor;
      }

      controller.markAgentDirectorySyncReady();
      return {
        agents: allAgents,
        subscriptionId,
      };
    } catch (error) {
      controller.markAgentDirectorySyncError(toErrorMessage(error));
      throw error;
    }
  }

  refreshAllAgentDirectories(input?: { serverIds?: string[] }): void {
    const targetServerIds = input?.serverIds
      ? new Set(input.serverIds)
      : null;
    for (const [serverId] of this.controllers) {
      if (targetServerIds && !targetServerIds.has(serverId)) {
        continue;
      }
      void this.refreshAgentDirectory({ serverId }).catch(() => undefined);
    }
  }

  markAgentDirectorySyncLoading(serverId: string): void {
    this.controllers.get(serverId)?.markAgentDirectorySyncLoading();
  }

  markAgentDirectorySyncReady(serverId: string): void {
    this.controllers.get(serverId)?.markAgentDirectorySyncReady();
  }

  markAgentDirectorySyncError(serverId: string, error: string): void {
    this.controllers.get(serverId)?.markAgentDirectorySyncError(error);
  }

  markAgentDirectorySyncIdle(serverId: string): void {
    this.controllers.get(serverId)?.markAgentDirectorySyncIdle();
  }

  private emit(serverId: string): void {
    this.version += 1;
    const listeners = this.serverListeners.get(serverId);
    if (!listeners) {
      for (const listener of this.globalListeners) {
        listener();
      }
      return;
    }
    for (const listener of listeners) {
      listener();
    }
    for (const listener of this.globalListeners) {
      listener();
    }
  }
}

let singletonHostRuntimeStore: HostRuntimeStore | null = null;
const HOST_RUNTIME_STORE_GLOBAL_KEY = "__paseoHostRuntimeStore";

type HostRuntimeGlobal = typeof globalThis & {
  [HOST_RUNTIME_STORE_GLOBAL_KEY]?: HostRuntimeStore;
};

export function getHostRuntimeStore(): HostRuntimeStore {
  if (singletonHostRuntimeStore) {
    return singletonHostRuntimeStore;
  }

  const runtimeGlobal = globalThis as HostRuntimeGlobal;
  if (runtimeGlobal[HOST_RUNTIME_STORE_GLOBAL_KEY]) {
    singletonHostRuntimeStore = runtimeGlobal[HOST_RUNTIME_STORE_GLOBAL_KEY] ?? null;
    if (singletonHostRuntimeStore) {
      return singletonHostRuntimeStore;
    }
  }

  singletonHostRuntimeStore = new HostRuntimeStore();
  runtimeGlobal[HOST_RUNTIME_STORE_GLOBAL_KEY] = singletonHostRuntimeStore;
  return singletonHostRuntimeStore;
}

export function useHostRuntimeSnapshot(
  serverId: string
): HostRuntimeSnapshot | null {
  const store = getHostRuntimeStore();
  return useSyncExternalStore(
    (onStoreChange) => store.subscribe(serverId, onStoreChange),
    () => store.getSnapshot(serverId),
    () => store.getSnapshot(serverId)
  );
}

export function useHostRuntimeSession(serverId: string): {
  snapshot: HostRuntimeSnapshot | null;
  client: DaemonClient | null;
  isConnected: boolean;
} {
  const snapshot = useHostRuntimeSnapshot(serverId);
  return {
    snapshot,
    client: snapshot?.client ?? null,
    isConnected: isHostRuntimeConnected(snapshot),
  };
}
