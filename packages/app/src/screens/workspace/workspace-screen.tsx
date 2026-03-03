import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  BackHandler,
  Platform,
  Pressable,
  Text,
  View,
} from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import * as Clipboard from "expo-clipboard";
import {
  Bot,
  ChevronDown,
  FileText,
  Folder,
  GitBranch,
  MoreVertical,
  PanelRight,
  Plus,
  Pencil,
  SquareTerminal,
  Terminal,
} from "lucide-react-native";
import { GestureDetector } from "react-native-gesture-handler";
import { StyleSheet, UnistylesRuntime, useUnistyles } from "react-native-unistyles";
import { SidebarMenuToggle } from "@/components/headers/menu-header";
import { HeaderToggleButton } from "@/components/headers/header-toggle-button";
import { ScreenHeader } from "@/components/headers/screen-header";
import { Combobox } from "@/components/ui/combobox";
import { ClaudeIcon } from "@/components/icons/claude-icon";
import { CodexIcon } from "@/components/icons/codex-icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ExplorerSidebar } from "@/components/explorer-sidebar";
import { FilePane } from "@/components/file-pane";
import { TerminalPane } from "@/components/terminal-pane";
import { ExplorerSidebarAnimationProvider } from "@/contexts/explorer-sidebar-animation-context";
import { useToast } from "@/contexts/toast-context";
import { useExplorerOpenGesture } from "@/hooks/use-explorer-open-gesture";
import { usePanelStore, type ExplorerCheckoutContext } from "@/stores/panel-store";
import { useSessionStore, type Agent } from "@/stores/session-store";
import {
  buildWorkspaceTabPersistenceKey,
  useWorkspaceTabsStore,
  type WorkspaceTabTarget,
  type WorkspaceTab,
} from "@/stores/workspace-tabs-store";
import {
  buildHostAgentDetailRoute,
  buildHostWorkspaceRoute,
  buildHostWorkspaceAgentRoute,
  buildHostWorkspaceFileRoute,
  buildHostWorkspaceTabRoute,
  buildHostWorkspaceTerminalRoute,
  decodeWorkspaceIdFromPathSegment,
} from "@/utils/host-routes";
import { useHostRuntimeSession } from "@/runtime/host-runtime";
import {
  checkoutStatusQueryKey,
  type CheckoutStatusPayload,
} from "@/hooks/use-checkout-status-query";
import { AgentReadyScreen } from "@/screens/agent/agent-ready-screen";
import type { ListTerminalsResponse } from "@server/shared/messages";
import { upsertTerminalListEntry } from "@/utils/terminal-list";
import { confirmDialog } from "@/utils/confirm-dialog";
import { deriveSidebarStateBucket } from "@/utils/sidebar-agent-state";
import { getStatusDotColor } from "@/utils/status-dot-color";
import { useArchiveAgent } from "@/hooks/use-archive-agent";
import { buildProviderCommand } from "@/utils/provider-command-templates";
import { generateDraftId } from "@/stores/draft-keys";
import { WorkspaceDraftAgentTab } from "@/screens/workspace/workspace-draft-agent-tab";
import { WorkspaceDesktopTabsRow } from "@/screens/workspace/workspace-desktop-tabs-row";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import {
  deriveProjectDisplayName,
  deriveProjectKey,
  deriveProjectName,
  deriveRemoteProjectKey,
} from "@/utils/agent-grouping";

const TERMINALS_QUERY_STALE_TIME = 5_000;
const DROPDOWN_WIDTH = 220;
const NEW_TAB_AGENT_OPTION_ID = "__new_tab_agent__";
const NEW_TAB_TERMINAL_OPTION_ID = "__new_tab_terminal__";
const EMPTY_OPEN_FILE_PATHS: string[] = [];
const EMPTY_WORKSPACE_TABS: WorkspaceTab[] = [];

type TabAvailability = "available" | "invalid" | "unknown";

type RouteTabTarget = WorkspaceTabTarget | null;

type WorkspaceScreenProps = {
  serverId: string;
  workspaceId: string;
  routeTab: RouteTabTarget;
  routeTabId?: string | null;
};

function applyWorkspaceTabOrder(input: {
  tabs: WorkspaceTabDescriptor[];
  keys: string[];
}): WorkspaceTabDescriptor[] {
  if (input.keys.length === 0) {
    return input.tabs;
  }

  const byKey = new Map<string, WorkspaceTabDescriptor>();
  for (const tab of input.tabs) {
    byKey.set(tab.key, tab);
  }

  const used = new Set<string>();
  const next: WorkspaceTabDescriptor[] = [];

  for (const key of input.keys) {
    const tab = byKey.get(key);
    if (!tab) {
      continue;
    }
    used.add(key);
    next.push(tab);
  }

  for (const tab of input.tabs) {
    if (used.has(tab.key)) {
      continue;
    }
    next.push(tab);
  }

  return next;
}

function trimNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function deriveWorkspaceName(workspaceId: string): string {
  const normalized = workspaceId.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  return last ?? workspaceId;
}

function deriveWorkspaceProjectDisplayName(input: {
  workspaceId: string;
  checkout: CheckoutStatusPayload | null;
}): string {
  const projectKey =
    deriveRemoteProjectKey(input.checkout?.remoteUrl ?? null) ??
    deriveProjectKey(input.workspaceId);
  const projectName = deriveProjectName(projectKey);
  return deriveProjectDisplayName({ projectKey, projectName });
}

function formatProviderLabel(provider: Agent["provider"]): string {
  if (provider === "claude") {
    return "Claude";
  }
  if (provider === "codex") {
    return "Codex";
  }
  if (!provider) {
    return "Agent";
  }
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function normalizeWorkspaceTab(
  value: WorkspaceTabTarget | null | undefined
): WorkspaceTabTarget | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  if (value.kind === "draft") {
    const draftId = trimNonEmpty(decodeSegment(value.draftId));
    if (!draftId) {
      return null;
    }
    return { kind: "draft", draftId };
  }
  if (value.kind === "agent") {
    const agentId = trimNonEmpty(decodeSegment(value.agentId));
    if (!agentId) {
      return null;
    }
    return { kind: "agent", agentId };
  }
  if (value.kind === "terminal") {
    const terminalId = trimNonEmpty(decodeSegment(value.terminalId));
    if (!terminalId) {
      return null;
    }
    return { kind: "terminal", terminalId };
  }
  if (value.kind === "file") {
    const path = trimNonEmpty(value.path);
    if (!path) {
      return null;
    }
    return { kind: "file", path: path.replace(/\\/g, "/") };
  }
  return null;
}

function tabEquals(left: WorkspaceTabTarget | null, right: WorkspaceTabTarget | null): boolean {
  if (!left || !right) {
    return left === right;
  }
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "draft" && right.kind === "draft") {
    return left.draftId === right.draftId;
  }
  if (left.kind === "agent" && right.kind === "agent") {
    return left.agentId === right.agentId;
  }
  if (left.kind === "terminal" && right.kind === "terminal") {
    return left.terminalId === right.terminalId;
  }
  if (left.kind === "file" && right.kind === "file") {
    return left.path === right.path;
  }
  return false;
}

function buildTabRoute(input: {
  serverId: string;
  workspaceId: string;
  tab: WorkspaceTabTarget;
}): string {
  if (input.tab.kind === "draft") {
    return buildHostWorkspaceTabRoute(
      input.serverId,
      input.workspaceId,
      input.tab.draftId
    );
  }
  if (input.tab.kind === "agent") {
    return buildHostWorkspaceAgentRoute(
      input.serverId,
      input.workspaceId,
      input.tab.agentId
    );
  }
  if (input.tab.kind === "file") {
    return buildHostWorkspaceFileRoute(
      input.serverId,
      input.workspaceId,
      input.tab.path
    );
  }
  return buildHostWorkspaceTerminalRoute(
    input.serverId,
    input.workspaceId,
    input.tab.terminalId
  );
}

function resolveTabAvailability(input: {
  tab: WorkspaceTabTarget;
  agentsHydrated: boolean;
  terminalsHydrated: boolean;
  agentsById: Map<string, Agent>;
  terminalIds: Set<string>;
}): TabAvailability {
  if (input.tab.kind === "draft") {
    return "available";
  }
  if (input.tab.kind === "agent") {
    if (!input.agentsHydrated) {
      return "unknown";
    }
    return input.agentsById.has(input.tab.agentId) ? "available" : "invalid";
  }
  if (input.tab.kind === "file") {
    return "available";
  }
  if (!input.terminalsHydrated) {
    return "unknown";
  }
  return input.terminalIds.has(input.tab.terminalId) ? "available" : "invalid";
}

function sortAgentsByCreatedAtDescending(agents: Agent[]): Agent[] {
  return [...agents].sort((left, right) => {
    const createdAtDelta =
      right.createdAt.getTime() - left.createdAt.getTime();
    if (createdAtDelta !== 0) {
      return createdAtDelta;
    }
    return right.lastActivityAt.getTime() - left.lastActivityAt.getTime();
  });
}

function toWorkspaceTabTarget(
  tab: WorkspaceTabDescriptor
): WorkspaceTabTarget {
  if (tab.kind === "draft") {
    return { kind: "draft", draftId: tab.draftId };
  }
  if (tab.kind === "agent") {
    return { kind: "agent", agentId: tab.agentId };
  }
  if (tab.kind === "file") {
    return { kind: "file", path: tab.filePath };
  }
  return { kind: "terminal", terminalId: tab.terminalId };
}

export function WorkspaceScreen({
  serverId,
  workspaceId,
  routeTab,
  routeTabId,
}: WorkspaceScreenProps) {
  return (
    <ExplorerSidebarAnimationProvider>
      <WorkspaceScreenContent
        serverId={serverId}
        workspaceId={workspaceId}
        routeTab={routeTab}
        routeTabId={routeTabId}
      />
    </ExplorerSidebarAnimationProvider>
  );
}

function WorkspaceScreenContent({
  serverId,
  workspaceId,
  routeTab,
  routeTabId,
}: WorkspaceScreenProps) {
  const { theme } = useUnistyles();
  const toast = useToast();
  const router = useRouter();
  const isMobile =
    UnistylesRuntime.breakpoint === "xs" || UnistylesRuntime.breakpoint === "sm";

  const normalizedServerId = trimNonEmpty(decodeSegment(serverId)) ?? "";
  const normalizedWorkspaceId = decodeWorkspaceIdFromPathSegment(workspaceId) ?? "";

  const queryClient = useQueryClient();
  const { client, isConnected } = useHostRuntimeSession(normalizedServerId);

  const sessionAgents = useSessionStore(
    (state) => state.sessions[normalizedServerId]?.agents
  );
  const workspaceAgents = useMemo(() => {
    if (!sessionAgents || !normalizedWorkspaceId) {
      return [] as Agent[];
    }

    const collected: Agent[] = [];
    for (const agent of sessionAgents.values()) {
      if (agent.archivedAt) {
        continue;
      }
      if ((trimNonEmpty(agent.cwd) ?? "") !== normalizedWorkspaceId) {
        continue;
      }
      collected.push(agent);
    }

    return sortAgentsByCreatedAtDescending(collected);
  }, [normalizedWorkspaceId, sessionAgents]);

  const terminalsQueryKey = useMemo(
    () => ["terminals", normalizedServerId, normalizedWorkspaceId] as const,
    [normalizedServerId, normalizedWorkspaceId]
  );
  type ListTerminalsPayload = ListTerminalsResponse["payload"];
  const terminalsQuery = useQuery({
    queryKey: terminalsQueryKey,
    enabled:
      Boolean(client && isConnected) &&
      normalizedWorkspaceId.length > 0 &&
      normalizedWorkspaceId.startsWith("/"),
    queryFn: async () => {
      if (!client) {
        throw new Error("Host is not connected");
      }
      return await client.listTerminals(normalizedWorkspaceId);
    },
    staleTime: TERMINALS_QUERY_STALE_TIME,
  });
  const terminals = terminalsQuery.data?.terminals ?? [];
  const createTerminalMutation = useMutation({
    mutationFn: async () => {
      if (!client) {
        throw new Error("Host is not connected");
      }
      return await client.createTerminal(normalizedWorkspaceId);
    },
    onSuccess: (payload) => {
      const createdTerminal = payload.terminal;
      if (createdTerminal) {
        queryClient.setQueryData<ListTerminalsPayload>(
          terminalsQueryKey,
          (current) => {
            const nextTerminals = upsertTerminalListEntry({
              terminals: current?.terminals ?? [],
              terminal: createdTerminal,
            });
            return {
              cwd: current?.cwd ?? normalizedWorkspaceId,
              terminals: nextTerminals,
              requestId: current?.requestId ?? `terminal-create-${createdTerminal.id}`,
            };
          }
        );
      }

      void queryClient.invalidateQueries({ queryKey: terminalsQueryKey });
      if (createdTerminal) {
        const tabId = useWorkspaceTabsStore
          .getState()
          .openOrFocusTab({
            serverId: normalizedServerId,
            workspaceId: normalizedWorkspaceId,
            target: { kind: "terminal", terminalId: createdTerminal.id },
          });
        if (tabId) {
          router.replace(
            buildHostWorkspaceTabRoute(
              normalizedServerId,
              normalizedWorkspaceId,
              tabId
            ) as any
          );
        }
      }
    },
  });
  const killTerminalMutation = useMutation({
    mutationFn: async (terminalId: string) => {
      if (!client) {
        throw new Error("Host is not connected");
      }
      const payload = await client.killTerminal(terminalId);
      if (!payload.success) {
        throw new Error("Unable to close terminal");
      }
      return payload;
    },
  });
  const { archiveAgent, isArchivingAgent } = useArchiveAgent();

  useEffect(() => {
    if (!client || !isConnected || !normalizedWorkspaceId.startsWith("/")) {
      return;
    }

    const unsubscribeChanged = client.on("terminals_changed", (message) => {
      if (message.type !== "terminals_changed") {
        return;
      }
      if (message.payload.cwd !== normalizedWorkspaceId) {
        return;
      }

      queryClient.setQueryData<ListTerminalsPayload>(terminalsQueryKey, (current) => ({
        cwd: message.payload.cwd,
        terminals: message.payload.terminals,
        requestId: current?.requestId ?? `terminals-changed-${Date.now()}`,
      }));
    });

    const unsubscribeStreamExit = client.on("terminal_stream_exit", (message) => {
      if (message.type !== "terminal_stream_exit") {
        return;
      }
    });

    client.subscribeTerminals({ cwd: normalizedWorkspaceId });

    return () => {
      unsubscribeChanged();
      unsubscribeStreamExit();
      client.unsubscribeTerminals({ cwd: normalizedWorkspaceId });
    };
  }, [client, isConnected, normalizedWorkspaceId, queryClient, terminalsQueryKey]);

  const checkoutQuery = useQuery({
    queryKey: checkoutStatusQueryKey(normalizedServerId, normalizedWorkspaceId),
    enabled:
      Boolean(client && isConnected) &&
      normalizedWorkspaceId.length > 0 &&
      normalizedWorkspaceId.startsWith("/"),
    queryFn: async () => {
      if (!client) {
        throw new Error("Host is not connected");
      }
      return (await client.getCheckoutStatus(
        normalizedWorkspaceId
      )) as CheckoutStatusPayload;
    },
    staleTime: 15_000,
  });

  const workspaceName = useMemo(
    () => deriveWorkspaceName(normalizedWorkspaceId),
    [normalizedWorkspaceId]
  );
  const headerProjectName = useMemo(
    () =>
      deriveWorkspaceProjectDisplayName({
        workspaceId: normalizedWorkspaceId,
        checkout: checkoutQuery.data ?? null,
      }),
    [checkoutQuery.data, normalizedWorkspaceId]
  );

  const isGitCheckout = checkoutQuery.data?.isGit ?? false;
  const areWorkspaceAgentsHydrated = useSessionStore(
    (state) => state.sessions[normalizedServerId]?.hasHydratedAgents ?? false
  );
  const areWorkspaceTerminalsHydrated = terminalsQuery.isSuccess;

  const mobileView = usePanelStore((state) => state.mobileView);
  const desktopFileExplorerOpen = usePanelStore(
    (state) => state.desktop.fileExplorerOpen
  );
  const toggleFileExplorer = usePanelStore((state) => state.toggleFileExplorer);
  const openFileExplorer = usePanelStore((state) => state.openFileExplorer);
  const activateExplorerTabForCheckout = usePanelStore(
    (state) => state.activateExplorerTabForCheckout
  );
  const closeToAgent = usePanelStore((state) => state.closeToAgent);
  const setActiveExplorerCheckout = usePanelStore(
    (state) => state.setActiveExplorerCheckout
  );

  const isExplorerOpen = isMobile
    ? mobileView === "file-explorer"
    : desktopFileExplorerOpen;

  const activeExplorerCheckout = useMemo<ExplorerCheckoutContext | null>(() => {
    if (!normalizedServerId || !normalizedWorkspaceId.startsWith("/")) {
      return null;
    }
    return {
      serverId: normalizedServerId,
      cwd: normalizedWorkspaceId,
      isGit: isGitCheckout,
    };
  }, [isGitCheckout, normalizedServerId, normalizedWorkspaceId]);

  useEffect(() => {
    setActiveExplorerCheckout(activeExplorerCheckout);
  }, [activeExplorerCheckout, setActiveExplorerCheckout]);

  const openExplorerForWorkspace = useCallback(() => {
    if (!activeExplorerCheckout) {
      return;
    }
    activateExplorerTabForCheckout(activeExplorerCheckout);
    openFileExplorer();
  }, [
    activateExplorerTabForCheckout,
    activeExplorerCheckout,
    openFileExplorer,
  ]);

  const handleToggleExplorer = useCallback(() => {
    if (isExplorerOpen) {
      toggleFileExplorer();
      return;
    }
    openExplorerForWorkspace();
  }, [isExplorerOpen, openExplorerForWorkspace, toggleFileExplorer]);

  const explorerOpenGesture = useExplorerOpenGesture({
    enabled: isMobile && mobileView === "agent",
    onOpen: openExplorerForWorkspace,
  });

  useEffect(() => {
    if (Platform.OS === "web" || !isExplorerOpen) {
      return;
    }

    const handler = BackHandler.addEventListener("hardwareBackPress", () => {
      if (isExplorerOpen) {
        closeToAgent();
        return true;
      }
      return false;
    });

    return () => handler.remove();
  }, [closeToAgent, isExplorerOpen]);

  const agentsById = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const agent of workspaceAgents) {
      map.set(agent.id, agent);
    }
    return map;
  }, [workspaceAgents]);

  const terminalIds = useMemo(() => {
    const set = new Set<string>();
    for (const terminal of terminals) {
      set.add(terminal.id);
    }
    return set;
  }, [terminals]);

  const requestedTab = useMemo(
    () => normalizeWorkspaceTab(routeTab),
    [routeTab]
  );

  const persistenceKey = useMemo(
    () =>
      buildWorkspaceTabPersistenceKey({
        serverId: normalizedServerId,
        workspaceId: normalizedWorkspaceId,
      }),
    [normalizedServerId, normalizedWorkspaceId]
  );

  const openTabs = useWorkspaceTabsStore((state) =>
    persistenceKey
      ? state.openTabsByWorkspace[persistenceKey] ?? EMPTY_WORKSPACE_TABS
      : EMPTY_WORKSPACE_TABS
  );
  const openTabIdSet = useMemo(() => new Set(openTabs.map((tab) => tab.tabId)), [openTabs]);
  const focusedTabId = useWorkspaceTabsStore((state) =>
    persistenceKey ? state.focusedTabIdByWorkspace[persistenceKey] ?? "" : ""
  );
  const openDraftTab = useWorkspaceTabsStore((state) => state.openDraftTab);
  const seedWorkspaceTabs = useWorkspaceTabsStore((state) => state.seedWorkspaceTabs);
  const openOrFocusTab = useWorkspaceTabsStore((state) => state.openOrFocusTab);
  const focusTab = useWorkspaceTabsStore((state) => state.focusTab);
  const closeWorkspaceTab = useWorkspaceTabsStore((state) => state.closeTab);
  const reorderWorkspaceTabs = useWorkspaceTabsStore((state) => state.reorderTabs);
  const replaceWorkspaceTabTarget = useWorkspaceTabsStore((state) => state.replaceTabTarget);

  useEffect(() => {
    if (!normalizedServerId || !normalizedWorkspaceId) {
      return;
    }
    if (openTabs.length > 0) {
      return;
    }
    if (!areWorkspaceAgentsHydrated || !areWorkspaceTerminalsHydrated) {
      return;
    }
    const targets: WorkspaceTabTarget[] = [];
    for (const agent of workspaceAgents) {
      targets.push({ kind: "agent", agentId: agent.id });
    }
    for (const terminal of terminals) {
      targets.push({ kind: "terminal", terminalId: terminal.id });
    }
    seedWorkspaceTabs({
      serverId: normalizedServerId,
      workspaceId: normalizedWorkspaceId,
      targets,
      focusedTabId: focusedTabId || null,
    });
  }, [
    areWorkspaceAgentsHydrated,
    areWorkspaceTerminalsHydrated,
    focusedTabId,
    normalizedServerId,
    normalizedWorkspaceId,
    openTabs.length,
    seedWorkspaceTabs,
    terminals,
    workspaceAgents,
  ]);

  useEffect(() => {
    const normalized = typeof routeTabId === "string" ? routeTabId.trim() : "";
    if (!normalized || !persistenceKey) {
      return;
    }
    const alreadyOpen = openTabs.some((tab) => tab.tabId === normalized);
    if (alreadyOpen) {
      focusTab({ serverId: normalizedServerId, workspaceId: normalizedWorkspaceId, tabId: normalized });
      return;
    }

    // If the canonical tab route is opened without local state (fresh load / reconnect),
    // reconstruct the tab target from the tabId prefix.
    if (normalized.startsWith("agent_")) {
      const agentId = normalized.slice("agent_".length).trim();
      if (agentId) {
        const tabId = openOrFocusTab({
          serverId: normalizedServerId,
          workspaceId: normalizedWorkspaceId,
          target: { kind: "agent", agentId },
        });
        if (tabId) {
          focusTab({
            serverId: normalizedServerId,
            workspaceId: normalizedWorkspaceId,
            tabId,
          });
        }
      }
      return;
    }
    if (normalized.startsWith("terminal_")) {
      const terminalId = normalized.slice("terminal_".length).trim();
      if (terminalId) {
        const tabId = openOrFocusTab({
          serverId: normalizedServerId,
          workspaceId: normalizedWorkspaceId,
          target: { kind: "terminal", terminalId },
        });
        if (tabId) {
          focusTab({
            serverId: normalizedServerId,
            workspaceId: normalizedWorkspaceId,
            tabId,
          });
        }
      }
      return;
    }
    if (normalized.startsWith("draft_")) {
      const tabId = openDraftTab({
        serverId: normalizedServerId,
        workspaceId: normalizedWorkspaceId,
        draftId: normalized,
      });
      if (tabId) {
        focusTab({
          serverId: normalizedServerId,
          workspaceId: normalizedWorkspaceId,
          tabId,
        });
      }
    }
  }, [
    focusTab,
    openDraftTab,
    openOrFocusTab,
    openTabs,
    persistenceKey,
    normalizedServerId,
    normalizedWorkspaceId,
    routeTabId,
  ]);

  useEffect(() => {
    if (!requestedTab || !persistenceKey) {
      return;
    }
    const tabId = openOrFocusTab({
      serverId: normalizedServerId,
      workspaceId: normalizedWorkspaceId,
      target: requestedTab,
    });
    if (tabId) {
      focusTab({
        serverId: normalizedServerId,
        workspaceId: normalizedWorkspaceId,
        tabId,
      });
    }
  }, [
    focusTab,
    normalizedServerId,
    normalizedWorkspaceId,
    openOrFocusTab,
    persistenceKey,
    requestedTab,
  ]);

  const activeTabId = useMemo(() => {
    const fromRoute =
      typeof routeTabId === "string" ? trimNonEmpty(routeTabId.trim()) : null;
    if (fromRoute && openTabIdSet.has(fromRoute)) {
      return fromRoute;
    }
    const fromFocus = trimNonEmpty(focusedTabId);
    if (fromFocus && openTabIdSet.has(fromFocus)) {
      return fromFocus;
    }
    return openTabs[0]?.tabId ?? null;
  }, [focusedTabId, openTabIdSet, openTabs, routeTabId]);

  useEffect(() => {
    if (!persistenceKey) {
      return;
    }

    const invalidTabIds = openTabs
      .filter((tab) => {
        const availability = resolveTabAvailability({
          tab: tab.target,
          agentsHydrated: areWorkspaceAgentsHydrated,
          terminalsHydrated: areWorkspaceTerminalsHydrated,
          agentsById,
          terminalIds,
        });
        return availability === "invalid";
      })
      .map((tab) => tab.tabId);

    if (invalidTabIds.length === 0) {
      return;
    }

    for (const tabId of invalidTabIds) {
      closeWorkspaceTab({
        serverId: normalizedServerId,
        workspaceId: normalizedWorkspaceId,
        tabId,
      });
    }
  }, [
    agentsById,
    areWorkspaceAgentsHydrated,
    areWorkspaceTerminalsHydrated,
    closeWorkspaceTab,
    normalizedServerId,
    normalizedWorkspaceId,
    openTabs,
    persistenceKey,
    terminalIds,
  ]);

  useEffect(() => {
    if (!activeTabId || !persistenceKey) {
      return;
    }
    focusTab({ serverId: normalizedServerId, workspaceId: normalizedWorkspaceId, tabId: activeTabId });
  }, [activeTabId, focusTab, normalizedServerId, normalizedWorkspaceId, persistenceKey]);

  const lastCanonicalTabIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeTabId || !normalizedServerId || !normalizedWorkspaceId) {
      return;
    }
    if (routeTabId && routeTabId.trim() === activeTabId) {
      lastCanonicalTabIdRef.current = activeTabId;
      return;
    }
    if (lastCanonicalTabIdRef.current === activeTabId) {
      return;
    }
    lastCanonicalTabIdRef.current = activeTabId;
    router.replace(
      buildHostWorkspaceTabRoute(normalizedServerId, normalizedWorkspaceId, activeTabId) as any
    );
  }, [activeTabId, normalizedServerId, normalizedWorkspaceId, router, routeTabId]);

  const activeTab = useMemo(() => openTabs.find((tab) => tab.tabId === activeTabId) ?? null, [
    activeTabId,
    openTabs,
  ]);
  const activeTabAvailability = useMemo(() => {
    if (!activeTab) {
      return "unknown" as TabAvailability;
    }
    return resolveTabAvailability({
      tab: activeTab.target,
      agentsHydrated: areWorkspaceAgentsHydrated,
      terminalsHydrated: areWorkspaceTerminalsHydrated,
      agentsById,
      terminalIds,
    });
  }, [
    activeTab,
    agentsById,
    areWorkspaceAgentsHydrated,
    areWorkspaceTerminalsHydrated,
    terminalIds,
  ]);

  const tabs = useMemo<WorkspaceTabDescriptor[]>(() => {
    const next: WorkspaceTabDescriptor[] = [];
    for (const tab of openTabs) {
      const target = tab.target;
      if (target.kind === "draft") {
        next.push({
          key: tab.tabId,
          tabId: tab.tabId,
          kind: "draft",
          draftId: target.draftId,
          label: "New agent",
          subtitle: "Draft",
        });
        continue;
      }
      if (target.kind === "agent") {
        const agent = sessionAgents?.get(target.agentId) ?? null;
        const provider = agent?.provider ?? "claude";
        next.push({
          key: tab.tabId,
          tabId: tab.tabId,
          kind: "agent",
          agentId: target.agentId,
          provider,
          label: agent?.title?.trim() || "Agent",
          subtitle: `${formatProviderLabel(provider)} agent`,
        });
        continue;
      }
      if (target.kind === "terminal") {
        const terminal = terminals.find((t) => t.id === target.terminalId) ?? null;
        next.push({
          key: tab.tabId,
          tabId: tab.tabId,
          kind: "terminal",
          terminalId: target.terminalId,
          label: terminal?.name ?? "Terminal",
          subtitle: "Terminal",
        });
        continue;
      }
      const filePath = target.path;
      const fileName = filePath.split("/").filter(Boolean).pop() ?? filePath;
      next.push({
        key: tab.tabId,
        tabId: tab.tabId,
        kind: "file",
        filePath,
        label: fileName,
        subtitle: filePath,
      });
    }
    return next;
  }, [openTabs, sessionAgents, terminals]);

  const handleReorderTabs = useCallback(
    (nextTabs: WorkspaceTabDescriptor[]) => {
      reorderWorkspaceTabs({
        serverId: normalizedServerId,
        workspaceId: normalizedWorkspaceId,
        tabIds: nextTabs.map((tab) => tab.tabId),
      });
    },
    [normalizedServerId, normalizedWorkspaceId, reorderWorkspaceTabs]
  );

  const navigateToTabId = useCallback(
    (tabId: string) => {
      if (!tabId || !normalizedServerId || !normalizedWorkspaceId) {
        return;
      }
      router.replace(
        buildHostWorkspaceTabRoute(normalizedServerId, normalizedWorkspaceId, tabId) as any
      );
    },
    [normalizedServerId, normalizedWorkspaceId, router]
  );

  const handleOpenFileFromExplorer = useCallback(
    (filePath: string) => {
      if (isMobile) {
        closeToAgent();
      }
      const tabId = openOrFocusTab({
        serverId: normalizedServerId,
        workspaceId: normalizedWorkspaceId,
        target: { kind: "file", path: filePath },
      });
      if (tabId) {
        navigateToTabId(tabId);
      }
    },
    [closeToAgent, isMobile, navigateToTabId, normalizedServerId, normalizedWorkspaceId, openOrFocusTab]
  );

  const [isTabSwitcherOpen, setIsTabSwitcherOpen] = useState(false);
  const [isNewTerminalHovered, setIsNewTerminalHovered] = useState(false);
  const [hoveredTabKey, setHoveredTabKey] = useState<string | null>(null);
  const [hoveredCloseTabKey, setHoveredCloseTabKey] = useState<string | null>(
    null
  );
  const tabSwitcherAnchorRef = useRef<View>(null);

  const tabByKey = useMemo(() => {
    const map = new Map<string, WorkspaceTabDescriptor>();
    for (const tab of tabs) {
      map.set(tab.key, tab);
    }
    return map;
  }, [tabs]);

  const activeTabKey = activeTabId ?? "";

  const tabSwitcherOptions = useMemo(
    () =>
      tabs.map((tab) => ({
        id: tab.key,
        label: tab.label,
        description: tab.subtitle,
      })),
    [tabs]
  );

  const activeAgent = useMemo(() => {
    if (activeTab?.target.kind !== "agent") {
      return null;
    }
    return sessionAgents?.get(activeTab.target.agentId) ?? null;
  }, [activeTab, sessionAgents]);

  const activeTabLabel = useMemo(() => {
    const active = tabs.find((tab) => tab.key === activeTabKey);
    return active?.label ?? "Select tab";
  }, [activeTabKey, tabs]);

  const handleCreateDraftTab = useCallback(() => {
    if (!normalizedServerId || !normalizedWorkspaceId) {
      return;
    }
    const draftId = generateDraftId();
    const tabId = openDraftTab({
      serverId: normalizedServerId,
      workspaceId: normalizedWorkspaceId,
      draftId,
    });
    if (tabId) {
      navigateToTabId(tabId);
    }
  }, [navigateToTabId, normalizedServerId, normalizedWorkspaceId, openDraftTab]);

  const handleCreateTerminal = useCallback(() => {
    if (createTerminalMutation.isPending) {
      return;
    }
    if (!normalizedWorkspaceId.startsWith("/")) {
      return;
    }
    createTerminalMutation.mutate();
  }, [createTerminalMutation, normalizedWorkspaceId]);

  const handleSelectSwitcherTab = useCallback(
    (key: string) => {
      setIsTabSwitcherOpen(false);
      navigateToTabId(key);
    },
    [navigateToTabId]
  );

  const handleSelectNewTabOption = useCallback(
    (key: typeof NEW_TAB_AGENT_OPTION_ID | typeof NEW_TAB_TERMINAL_OPTION_ID) => {
      if (key === NEW_TAB_AGENT_OPTION_ID) {
        handleCreateDraftTab();
        return;
      }
      if (key === NEW_TAB_TERMINAL_OPTION_ID) {
        handleCreateTerminal();
      }
    },
    [handleCreateDraftTab, handleCreateTerminal]
  );

  const handleCloseTerminalTab = useCallback(
    async (input: { tabId: string; terminalId: string }) => {
      const { tabId, terminalId } = input;
      if (
        killTerminalMutation.isPending &&
        killTerminalMutation.variables === terminalId
      ) {
        return;
      }

      const confirmed = await confirmDialog({
        title: "Close terminal?",
        message: "Any running process in this terminal will be stopped immediately.",
        confirmLabel: "Close",
        cancelLabel: "Cancel",
        destructive: true,
      });
      if (!confirmed) {
        return;
      }

      killTerminalMutation.mutate(terminalId, {
        onSuccess: () => {
          setHoveredTabKey((current) => (current === tabId ? null : current));
          setHoveredCloseTabKey((current) => (current === tabId ? null : current));

          queryClient.setQueryData<ListTerminalsPayload>(
            terminalsQueryKey,
            (current) => {
              if (!current) {
                return current;
              }
              return {
                ...current,
                terminals: current.terminals.filter(
                  (terminal) => terminal.id !== terminalId
                ),
              };
            }
          );

          closeWorkspaceTab({
            serverId: normalizedServerId,
            workspaceId: normalizedWorkspaceId,
            tabId,
          });
        },
      });
    },
    [
      closeWorkspaceTab,
      killTerminalMutation,
      normalizedServerId,
      normalizedWorkspaceId,
      queryClient,
      terminalsQueryKey,
    ]
  );

  const handleCloseAgentTab = useCallback(
    async (input: { tabId: string; agentId: string }) => {
      const { tabId, agentId } = input;
      if (
        !normalizedServerId ||
        isArchivingAgent({ serverId: normalizedServerId, agentId })
      ) {
        return;
      }

      const confirmed = await confirmDialog({
        title: "Archive agent?",
        message: "This closes the tab and archives the agent.",
        confirmLabel: "Archive",
        cancelLabel: "Cancel",
        destructive: true,
      });
      if (!confirmed) {
        return;
      }

      await archiveAgent({ serverId: normalizedServerId, agentId });
      setHoveredTabKey((current) => (current === tabId ? null : current));
      setHoveredCloseTabKey((current) => (current === tabId ? null : current));
      closeWorkspaceTab({
        serverId: normalizedServerId,
        workspaceId: normalizedWorkspaceId,
        tabId,
      });
    },
    [
      archiveAgent,
      closeWorkspaceTab,
      isArchivingAgent,
      normalizedServerId,
      normalizedWorkspaceId,
    ]
  );

  const handleCloseDraftOrFileTab = useCallback(
    (tabId: string) => {
      setHoveredTabKey((current) => (current === tabId ? null : current));
      setHoveredCloseTabKey((current) => (current === tabId ? null : current));
      closeWorkspaceTab({
        serverId: normalizedServerId,
        workspaceId: normalizedWorkspaceId,
        tabId,
      });
    },
    [closeWorkspaceTab, normalizedServerId, normalizedWorkspaceId]
  );

  const handleCloseTabById = useCallback(
    async (tabId: string) => {
      const tab = tabByKey.get(tabId);
      if (!tab) {
        return;
      }
      if (tab.kind === "terminal") {
        await handleCloseTerminalTab({ tabId, terminalId: tab.terminalId });
        return;
      }
      if (tab.kind === "agent") {
        await handleCloseAgentTab({ tabId, agentId: tab.agentId });
        return;
      }
      handleCloseDraftOrFileTab(tabId);
    },
    [handleCloseAgentTab, handleCloseDraftOrFileTab, handleCloseTerminalTab, tabByKey]
  );

  const handleCopyAgentId = useCallback(
    async (agentId: string) => {
      if (!agentId) return;
      try {
        await Clipboard.setStringAsync(agentId);
        toast.copied("Agent ID");
      } catch {
        toast.error("Copy failed");
      }
    },
    [toast]
  );

  const handleCopyResumeCommand = useCallback(
    async (agentId: string) => {
      if (!agentId) return;
      const agent = sessionAgents?.get(agentId) ?? null;
      const providerSessionId =
        agent?.runtimeInfo?.sessionId ?? agent?.persistence?.sessionId ?? null;
      if (!agent || !providerSessionId) {
        toast.error("Resume ID not available");
        return;
      }

      const command =
        buildProviderCommand({
          provider: agent.provider,
          id: "resume",
          sessionId: providerSessionId,
        }) ?? null;
      if (!command) {
        toast.error("Resume command not available");
        return;
      }
      try {
        await Clipboard.setStringAsync(command);
        toast.copied("resume command");
      } catch {
        toast.error("Copy failed");
      }
    },
    [sessionAgents, toast]
  );

  const handleCloseTabsToRight = useCallback(
    async (tabKey: string) => {
      const startIndex = tabs.findIndex((tab) => tab.tabId === tabKey);
      if (startIndex < 0) {
        return;
      }
      const toClose = tabs.slice(startIndex + 1);
      if (toClose.length === 0) {
        return;
      }

      const agentTabs: Array<{ tabId: string; agentId: string }> = [];
      const terminalTabs: Array<{ tabId: string; terminalId: string }> = [];
      const otherTabs: Array<{ tabId: string }> = [];
      for (const tab of toClose) {
        if (tab.kind === "agent") {
          agentTabs.push({ tabId: tab.tabId, agentId: tab.agentId });
        } else if (tab.kind === "terminal") {
          terminalTabs.push({ tabId: tab.tabId, terminalId: tab.terminalId });
        } else {
          otherTabs.push({ tabId: tab.tabId });
        }
      }

      const confirmed = await confirmDialog({
        title: "Close tabs to the right?",
        message:
          agentTabs.length > 0 && terminalTabs.length > 0 && otherTabs.length > 0
            ? `This will archive ${agentTabs.length} agent(s), close ${terminalTabs.length} terminal(s), and close ${otherTabs.length} tab(s). Any running process in a closed terminal will be stopped immediately.`
            : agentTabs.length > 0 && terminalTabs.length > 0
              ? `This will archive ${agentTabs.length} agent(s) and close ${terminalTabs.length} terminal(s). Any running process in a closed terminal will be stopped immediately.`
              : terminalTabs.length > 0 && otherTabs.length > 0
                ? `This will close ${terminalTabs.length} terminal(s) and close ${otherTabs.length} tab(s). Any running process in a closed terminal will be stopped immediately.`
                : agentTabs.length > 0 && otherTabs.length > 0
                  ? `This will archive ${agentTabs.length} agent(s) and close ${otherTabs.length} tab(s).`
                  : terminalTabs.length > 0
                    ? `This will close ${terminalTabs.length} terminal(s). Any running process in a closed terminal will be stopped immediately.`
                    : otherTabs.length > 0
                      ? `This will close ${otherTabs.length} tab(s).`
                      : `This will archive ${agentTabs.length} agent(s).`,
        confirmLabel: "Close",
        cancelLabel: "Cancel",
        destructive: true,
      });
      if (!confirmed) {
        return;
      }

      for (const { tabId, terminalId } of terminalTabs) {
        try {
          await killTerminalMutation.mutateAsync(terminalId);
          queryClient.setQueryData<ListTerminalsPayload>(terminalsQueryKey, (current) => {
            if (!current) {
              return current;
            }
            return {
              ...current,
              terminals: current.terminals.filter((terminal) => terminal.id !== terminalId),
            };
          });
          closeWorkspaceTab({
            serverId: normalizedServerId,
            workspaceId: normalizedWorkspaceId,
            tabId,
          });
        } catch (error) {
          console.warn("[WorkspaceScreen] Failed to close terminal tab to the right", { terminalId, error });
        }
      }

      for (const { tabId, agentId } of agentTabs) {
        if (!normalizedServerId) {
          continue;
        }
        try {
          await archiveAgent({ serverId: normalizedServerId, agentId });
          closeWorkspaceTab({
            serverId: normalizedServerId,
            workspaceId: normalizedWorkspaceId,
            tabId,
          });
        } catch (error) {
          console.warn("[WorkspaceScreen] Failed to archive agent tab to the right", { agentId, error });
        }
      }

      for (const { tabId } of otherTabs) {
        closeWorkspaceTab({
          serverId: normalizedServerId,
          workspaceId: normalizedWorkspaceId,
          tabId,
        });
      }

      const closedKeys = new Set(toClose.map((tab) => tab.key));
      setHoveredTabKey((current) => (current && closedKeys.has(current) ? null : current));
      setHoveredCloseTabKey((current) => (current && closedKeys.has(current) ? null : current));
    },
    [
      archiveAgent,
      closeWorkspaceTab,
      killTerminalMutation,
      normalizedServerId,
      normalizedWorkspaceId,
      queryClient,
      tabs,
      terminalsQueryKey,
    ]
  );

  const handleOpenAgentChatView = useCallback(() => {
    if (!activeAgent) {
      return;
    }
    router.push(
      buildHostAgentDetailRoute(normalizedServerId, activeAgent.id) as any
    );
  }, [activeAgent, normalizedServerId, router]);

  const renderContent = () => {
    const target = activeTab?.target ?? null;
    if (!target) {
      return (
        <View style={styles.emptyState}>
          <Text style={styles.emptyStateText}>
            No tabs are available yet. Use New tab to create an agent or terminal.
          </Text>
        </View>
      );
    }
    if (activeTabAvailability === "invalid") {
      return (
        <View style={styles.emptyState}>
          <Text style={styles.emptyStateText}>
            This tab is no longer available. It will be removed from your workspace.
          </Text>
        </View>
      );
    }

    if (target.kind === "draft") {
      return (
        <WorkspaceDraftAgentTab
          serverId={normalizedServerId}
          workspaceId={normalizedWorkspaceId}
          tabId={activeTabId ?? target.draftId}
          draftId={target.draftId}
          onCreated={(agentSnapshot) => {
            const tabId = activeTabId ?? target.draftId;
            replaceWorkspaceTabTarget({
              serverId: normalizedServerId,
              workspaceId: normalizedWorkspaceId,
              tabId,
              target: { kind: "agent", agentId: agentSnapshot.id },
            });
          }}
        />
      );
    }

    if (target.kind === "agent") {
      return (
        <AgentReadyScreen
          serverId={normalizedServerId}
          agentId={target.agentId}
          showHeader={false}
          showExplorerSidebar={false}
          wrapWithExplorerSidebarProvider={false}
        />
      );
    }

    if (target.kind === "file") {
      return (
        <FilePane
          serverId={normalizedServerId}
          workspaceRoot={normalizedWorkspaceId}
          filePath={target.path}
        />
      );
    }

    return (
      <TerminalPane
        serverId={normalizedServerId}
        cwd={normalizedWorkspaceId}
        selectedTerminalId={target.terminalId}
        onSelectedTerminalIdChange={(terminalId) => {
          if (!terminalId) {
            return;
          }
          const tabId = openOrFocusTab({
            serverId: normalizedServerId,
            workspaceId: normalizedWorkspaceId,
            target: { kind: "terminal", terminalId },
          });
          if (tabId) {
            navigateToTabId(tabId);
          }
        }}
        hideHeader
        manageTerminalDirectorySubscription={false}
      />
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.threePaneRow}>
        <View style={styles.centerColumn}>
          <ScreenHeader
            left={
              <>
                <SidebarMenuToggle />
                <View style={styles.headerTitleContainer}>
                  <Text style={styles.headerTitle} numberOfLines={1}>
                    {workspaceName}
                  </Text>
                  <Text style={styles.headerProjectTitle} numberOfLines={1}>
                    {headerProjectName}
                  </Text>
                </View>
              </>
            }
            right={
              <View style={styles.headerRight}>
                <HeaderToggleButton
                  testID="workspace-explorer-toggle"
                  onPress={handleToggleExplorer}
                  tooltipLabel="Toggle explorer"
                  tooltipKeys={["mod", "E"]}
                  tooltipSide="left"
                  style={styles.menuButton}
                  accessible
                  accessibilityRole="button"
                  accessibilityLabel={isExplorerOpen ? "Close explorer" : "Open explorer"}
                  accessibilityState={{ expanded: isExplorerOpen }}
                >
                  {isMobile ? (
                    isGitCheckout ? (
                      <GitBranch
                        size={theme.iconSize.lg}
                        color={
                          isExplorerOpen
                            ? theme.colors.foreground
                            : theme.colors.foregroundMuted
                        }
                      />
                    ) : (
                      <Folder
                        size={theme.iconSize.lg}
                        color={
                          isExplorerOpen
                            ? theme.colors.foreground
                            : theme.colors.foregroundMuted
                        }
                      />
                    )
                  ) : (
                    <PanelRight
                      size={theme.iconSize.md}
                      color={
                        isExplorerOpen
                          ? theme.colors.foreground
                          : theme.colors.foregroundMuted
                      }
                    />
                  )}
                </HeaderToggleButton>

                {activeAgent ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      testID="workspace-agent-overflow-menu"
                      style={styles.menuButton}
                    >
                      <MoreVertical
                        size={isMobile ? theme.iconSize.lg : theme.iconSize.md}
                        color={theme.colors.foregroundMuted}
                      />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="end"
                      width={DROPDOWN_WIDTH}
                      testID="workspace-agent-overflow-content"
                    >
                      <DropdownMenuItem
                        testID="workspace-agent-overflow-open-chat"
                        description="Open this agent with the full chat header"
                        onSelect={handleOpenAgentChatView}
                      >
                        Open chat view
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </View>
            }
          />

          {isMobile ? (
            <View style={styles.mobileTabsRow} testID="workspace-tabs-row">
              <Pressable
                ref={tabSwitcherAnchorRef}
                style={({ hovered, pressed }) => [
                  styles.switcherTrigger,
                  (hovered || pressed || isTabSwitcherOpen) && styles.switcherTriggerActive,
                  { borderWidth: 0, borderColor: "transparent" },
                  Platform.OS === "web"
                    ? {
                        outlineStyle: "solid",
                        outlineWidth: 0,
                        outlineColor: "transparent",
                      }
                    : null,
                ]}
                onPress={() => setIsTabSwitcherOpen(true)}
              >
                <View style={styles.switcherTriggerLeft}>
                  <View style={styles.switcherTriggerIcon} testID="workspace-active-tab-icon">
                    {(() => {
                      const activeDescriptor = tabs.find((tab) => tab.key === activeTabKey) ?? null;
                      if (!activeDescriptor) {
                        return <View style={styles.tabIcon}><Bot size={14} color={theme.colors.foregroundMuted} /></View>;
                      }

                      if (activeDescriptor.kind === "terminal") {
                        return <Terminal size={14} color={theme.colors.foreground} />;
                      }

                      if (activeDescriptor.kind === "file") {
                        return <FileText size={14} color={theme.colors.foreground} />;
                      }

                      if (activeDescriptor.kind === "draft") {
                        return <Pencil size={14} color={theme.colors.foreground} />;
                      }

                      if (activeDescriptor.kind !== "agent") {
                        return <Bot size={14} color={theme.colors.foreground} />;
                      }

                      const tabAgent = agentsById.get(activeDescriptor.agentId) ?? null;
                      const tabAgentStatusBucket = tabAgent
                        ? deriveSidebarStateBucket({
                            status: tabAgent.status,
                            pendingPermissionCount: tabAgent.pendingPermissions.length,
                            requiresAttention: tabAgent.requiresAttention,
                            attentionReason: tabAgent.attentionReason,
                          })
                        : null;
                      const tabAgentStatusColor =
                        tabAgentStatusBucket === null
                          ? null
                          : getStatusDotColor({
                              theme,
                              bucket: tabAgentStatusBucket,
                              showDoneAsInactive: false,
                            });

                      return (
                        <View style={styles.tabAgentIconWrapper}>
                          {activeDescriptor.provider === "claude" ? (
                            <ClaudeIcon size={14} color={theme.colors.foreground} />
                          ) : activeDescriptor.provider === "codex" ? (
                            <CodexIcon size={14} color={theme.colors.foreground} />
                          ) : (
                            <Bot size={14} color={theme.colors.foreground} />
                          )}
                          {tabAgentStatusColor ? (
                            <View
                              style={[
                                styles.tabStatusDot,
                                {
                                  backgroundColor: tabAgentStatusColor,
                                  borderColor: theme.colors.surface0,
                                },
                              ]}
                            />
                          ) : null}
                        </View>
                      );
                    })()}
                  </View>

                  <Text style={styles.switcherTriggerText} numberOfLines={1}>
                    {activeTabLabel}
                  </Text>
                </View>

                <ChevronDown size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
              </Pressable>

              <View style={styles.mobileTabsActions}>
                <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
                  <TooltipTrigger
                    testID="workspace-new-agent-tab"
                    onPress={() => handleSelectNewTabOption(NEW_TAB_AGENT_OPTION_ID)}
                    accessibilityRole="button"
                    accessibilityLabel="New agent tab"
                    style={({ hovered, pressed }) => [
                      styles.newTabActionButton,
                      (hovered || pressed) && styles.newTabActionButtonHovered,
                    ]}
                  >
                    <Plus size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
                  </TooltipTrigger>
                  <TooltipContent side="bottom" align="end" offset={8}>
                    <Text style={styles.newTabTooltipText}>New agent tab</Text>
                  </TooltipContent>
                </Tooltip>

                <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
                  <TooltipTrigger
                    testID="workspace-new-terminal-tab"
                    onPress={() => handleSelectNewTabOption(NEW_TAB_TERMINAL_OPTION_ID)}
                    onHoverIn={() => setIsNewTerminalHovered(true)}
                    onHoverOut={() => setIsNewTerminalHovered(false)}
                    disabled={createTerminalMutation.isPending}
                    accessibilityRole="button"
                    accessibilityLabel="New terminal tab"
                    style={({ hovered, pressed }) => [
                      styles.newTabActionButton,
                      createTerminalMutation.isPending && styles.newTabActionButtonDisabled,
                      (hovered || pressed) && styles.newTabActionButtonHovered,
                    ]}
                  >
                    {createTerminalMutation.isPending ? (
                      <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
                    ) : (
                      <View style={styles.terminalPlusIcon}>
                        <SquareTerminal size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
                        <View style={[styles.terminalPlusBadge, isNewTerminalHovered && styles.terminalPlusBadgeHovered]}>
                          <Plus size={10} color={theme.colors.foregroundMuted} />
                        </View>
                      </View>
                    )}
                  </TooltipTrigger>
                  <TooltipContent side="bottom" align="end" offset={8}>
                    <Text style={styles.newTabTooltipText}>New terminal tab</Text>
                  </TooltipContent>
                </Tooltip>
              </View>

              <Combobox
                options={tabSwitcherOptions}
                value={activeTabKey}
                onSelect={handleSelectSwitcherTab}
                searchable={false}
                title="Switch tab"
                searchPlaceholder="Search tabs"
                open={isTabSwitcherOpen}
                onOpenChange={setIsTabSwitcherOpen}
                anchorRef={tabSwitcherAnchorRef}
              />
            </View>
          ) : (
            <WorkspaceDesktopTabsRow
              tabs={tabs}
              activeTabKey={activeTabKey}
              agentsById={agentsById}
              normalizedServerId={normalizedServerId}
              hoveredCloseTabKey={hoveredCloseTabKey}
              setHoveredTabKey={setHoveredTabKey}
              setHoveredCloseTabKey={setHoveredCloseTabKey}
              isArchivingAgent={isArchivingAgent}
              killTerminalPending={killTerminalMutation.isPending}
              killTerminalId={killTerminalMutation.variables ?? null}
              onNavigateTab={navigateToTabId}
              onCloseTab={handleCloseTabById}
              onCopyResumeCommand={handleCopyResumeCommand}
              onCopyAgentId={handleCopyAgentId}
              onCloseTabsToRight={handleCloseTabsToRight}
              onSelectNewTabOption={handleSelectNewTabOption}
              newTabAgentOptionId={NEW_TAB_AGENT_OPTION_ID}
              newTabTerminalOptionId={NEW_TAB_TERMINAL_OPTION_ID}
              createTerminalPending={createTerminalMutation.isPending}
              isNewTerminalHovered={isNewTerminalHovered}
              setIsNewTerminalHovered={setIsNewTerminalHovered}
              onReorderTabs={handleReorderTabs}
            />
          )}

          <View style={styles.centerContent}>
            {isMobile ? (
              <GestureDetector gesture={explorerOpenGesture} touchAction="pan-y">
                <View style={styles.content}>{renderContent()}</View>
              </GestureDetector>
            ) : (
              <View style={styles.content}>{renderContent()}</View>
            )}
          </View>
        </View>

        <ExplorerSidebar
          serverId={normalizedServerId}
          workspaceId={normalizedWorkspaceId}
          workspaceRoot={normalizedWorkspaceId}
          isGit={isGitCheckout}
          onOpenFile={handleOpenFileFromExplorer}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  threePaneRow: {
    flex: 1,
    minHeight: 0,
    flexDirection: "row",
    alignItems: "stretch",
  },
  centerColumn: {
    flex: 1,
    minHeight: 0,
  },
  headerTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: {
      xs: "400",
      md: "300",
    },
    color: theme.colors.foreground,
    flexShrink: 1,
  },
  headerTitleContainer: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  headerProjectTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    flexShrink: 1,
  },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  menuButton: {
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
  },
  newTabActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  newTabActionButton: {
    width: 30,
    height: 30,
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    alignItems: "center",
    justifyContent: "center",
  },
  newTabActionButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  newTabActionButtonDisabled: {
    opacity: 0.6,
  },
  newTabTooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.popoverForeground,
  },
  terminalPlusIcon: {
    position: "relative",
    width: theme.iconSize.sm,
    height: theme.iconSize.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  terminalPlusBadge: {
    position: "absolute",
    right: -5,
    bottom: -5,
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: theme.colors.surface1,
    alignItems: "center",
    justifyContent: "center",
  },
  terminalPlusBadgeHovered: {
    backgroundColor: theme.colors.surface2,
  },
  mobileTabsRow: {
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  mobileTabsActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  switcherTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flex: 1,
    minWidth: 0,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    justifyContent: "space-between",
  },
  switcherTriggerActive: {
    backgroundColor: theme.colors.surface2,
  },
  switcherTriggerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flex: 1,
    minWidth: 0,
  },
  switcherTriggerIcon: {
    flexShrink: 0,
  },
  switcherTriggerText: {
    minWidth: 0,
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  tabsContainer: {
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    flexDirection: "row",
    alignItems: "center",
  },
  tabsScroll: {
    flex: 1,
    minWidth: 0,
  },
  tabsContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  tabsActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingRight: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  centerContent: {
    flex: 1,
    minHeight: 0,
  },
  tab: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    maxWidth: 260,
  },
  tabHandle: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flex: 1,
    minWidth: 0,
  },
  tabIcon: {
    flexShrink: 0,
  },
  tabAgentIconWrapper: {
    position: "relative",
    width: 14,
    height: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  tabStatusDot: {
    position: "absolute",
    right: -2,
    bottom: -2,
    width: 7,
    height: 7,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
  },
  tabActive: {
    backgroundColor: theme.colors.surface2,
  },
  tabHovered: {
    backgroundColor: theme.colors.surface2,
  },
  tabLabel: {
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  tabLabelWithCloseButton: {
    paddingRight: 0,
  },
  tabLabelActive: {
    color: theme.colors.foreground,
  },
  tabCloseButton: {
    width: 18,
    height: 18,
    marginLeft: 0,
    borderRadius: theme.borderRadius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  tabCloseButtonShown: {
    opacity: 1,
  },
  tabCloseButtonHidden: {
    opacity: 0,
  },
  tabCloseButtonActive: {
    backgroundColor: theme.colors.surface3,
  },
  content: {
    flex: 1,
    minHeight: 0,
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[6],
  },
  emptyStateText: {
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
}));
