import { useMemo, type Dispatch, type SetStateAction } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { Bot, FileText, Pencil, Plus, SquareTerminal, Terminal, X } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { SortableInlineList } from "@/components/sortable-inline-list";
import { ClaudeIcon } from "@/components/icons/claude-icon";
import { CodexIcon } from "@/components/icons/codex-icon";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useWorkspaceTabLayout } from "@/screens/workspace/use-workspace-tab-layout";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import { deriveSidebarStateBucket } from "@/utils/sidebar-agent-state";
import { getStatusDotColor } from "@/utils/status-dot-color";
import { encodeFilePathForPathSegment } from "@/utils/host-routes";
import type { Agent } from "@/stores/session-store";

const DROPDOWN_WIDTH = 220;
type NewTabOptionId = "__new_tab_agent__" | "__new_tab_terminal__";

type WorkspaceDesktopTabsRowProps = {
  tabs: WorkspaceTabDescriptor[];
  activeTabKey: string;
  agentsById: Map<string, Agent>;
  normalizedServerId: string;
  hoveredCloseTabKey: string | null;
  setHoveredTabKey: Dispatch<SetStateAction<string | null>>;
  setHoveredCloseTabKey: Dispatch<SetStateAction<string | null>>;
  isArchivingAgent: (input: { serverId: string; agentId: string }) => boolean;
  killTerminalPending: boolean;
  killTerminalId: string | null;
  onNavigateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => Promise<void> | void;
  onCopyResumeCommand: (agentId: string) => Promise<void> | void;
  onCopyAgentId: (agentId: string) => Promise<void> | void;
  onCloseTabsToRight: (tabId: string) => Promise<void> | void;
  onSelectNewTabOption: (optionId: NewTabOptionId) => void;
  newTabAgentOptionId: NewTabOptionId;
  newTabTerminalOptionId: NewTabOptionId;
  createTerminalPending: boolean;
  isNewTerminalHovered: boolean;
  setIsNewTerminalHovered: Dispatch<SetStateAction<boolean>>;
  onReorderTabs: (nextTabs: WorkspaceTabDescriptor[]) => void;
};

export function WorkspaceDesktopTabsRow({
  tabs,
  activeTabKey,
  agentsById,
  normalizedServerId,
  hoveredCloseTabKey,
  setHoveredTabKey,
  setHoveredCloseTabKey,
  isArchivingAgent,
  killTerminalPending,
  killTerminalId,
  onNavigateTab,
  onCloseTab,
  onCopyResumeCommand,
  onCopyAgentId,
  onCloseTabsToRight,
  onSelectNewTabOption,
  newTabAgentOptionId,
  newTabTerminalOptionId,
  createTerminalPending,
  isNewTerminalHovered,
  setIsNewTerminalHovered,
  onReorderTabs,
}: WorkspaceDesktopTabsRowProps) {
  const { theme } = useUnistyles();

  const layoutMetrics = useMemo(
    () => ({
      rowPaddingHorizontal: theme.spacing[2],
      tabGap: theme.spacing[1],
      maxTabWidth: 260,
      iconOnlyTabWidth: 40,
      tabBaseWidthWithClose: 84,
      minLabelChars: 4,
      charWidth: 7,
    }),
    [theme.spacing]
  );

  const { layout, onContainerLayout, onActionsLayout } = useWorkspaceTabLayout({
    tabLabels: tabs.map((tab) => tab.label),
    metrics: layoutMetrics,
  });

  return (
    <View style={styles.tabsContainer} testID="workspace-tabs-row" onLayout={onContainerLayout}>
      <ScrollView
        horizontal
        scrollEnabled={layout.shouldScroll}
        testID="workspace-tabs-scroll"
        style={styles.tabsScroll}
        contentContainerStyle={styles.tabsContent}
        showsHorizontalScrollIndicator={false}
      >
        <SortableInlineList
          data={tabs}
          keyExtractor={(tab) => tab.key}
          useDragHandle
          disabled={tabs.length < 2}
          onDragEnd={onReorderTabs}
          renderItem={({ item: tab, dragHandleProps, index }) => {
            const isActive = tab.key === activeTabKey;
            const tabAgent = tab.kind === "agent" ? agentsById.get(tab.agentId) ?? null : null;
            const isCloseHovered = hoveredCloseTabKey === tab.key;
            const isClosingAgent =
              tab.kind === "agent" &&
              isArchivingAgent({
                serverId: normalizedServerId,
                agentId: tab.agentId,
              });
            const isClosingTerminal =
              tab.kind === "terminal" && killTerminalPending && killTerminalId === tab.terminalId;
            const isClosingTab = isClosingAgent || isClosingTerminal;
            const shouldShowCloseButton = layout.showCloseButtons;
            const iconColor = isActive ? theme.colors.foreground : theme.colors.foregroundMuted;
            const tabWidth = layout.tabWidths[index] ?? layoutMetrics.maxTabWidth;
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
            const icon =
              tab.kind === "agent" ? (
                <View style={styles.tabAgentIconWrapper}>
                  {tab.provider === "claude" ? (
                    <ClaudeIcon size={14} color={iconColor} />
                  ) : tab.provider === "codex" ? (
                    <CodexIcon size={14} color={iconColor} />
                  ) : (
                    <Bot size={14} color={iconColor} />
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
              ) : tab.kind === "draft" ? (
                <Pencil size={14} color={iconColor} />
              ) : tab.kind === "file" ? (
                <FileText size={14} color={iconColor} />
              ) : (
                <Terminal size={14} color={iconColor} />
              );

            const contextMenuTestId = `workspace-tab-context-${tab.key}`;

            return (
              <ContextMenu key={tab.key}>
                <ContextMenuTrigger
                  testID={`workspace-tab-${tab.key}`}
                  enabledOnMobile={false}
                  style={({ hovered, pressed }) => [
                    styles.tab,
                    { width: tabWidth, minWidth: tabWidth, maxWidth: tabWidth },
                    layout.mode === "icon" && styles.tabIconOnly,
                    isActive && styles.tabActive,
                    (hovered || pressed || isCloseHovered) && styles.tabHovered,
                  ]}
                  onHoverIn={() => {
                    setHoveredTabKey(tab.key);
                  }}
                  onHoverOut={() => {
                    setHoveredTabKey((current) => (current === tab.key ? null : current));
                  }}
                  onPress={() => {
                    onNavigateTab(tab.tabId);
                  }}
                  accessibilityLabel={tab.label}
                >
                  <View
                    {...(dragHandleProps?.attributes as any)}
                    {...(dragHandleProps?.listeners as any)}
                    ref={(node: unknown) => {
                      dragHandleProps?.setActivatorNodeRef?.(node);
                    }}
                    style={styles.tabHandle}
                  >
                    <View style={styles.tabIcon}>{icon}</View>
                    {layout.showLabels ? (
                      <Text
                        style={[
                          styles.tabLabel,
                          isActive && styles.tabLabelActive,
                          shouldShowCloseButton && styles.tabLabelWithCloseButton,
                        ]}
                        numberOfLines={1}
                      >
                        {tab.label}
                      </Text>
                    ) : null}
                  </View>

                  {shouldShowCloseButton ? (
                    <Pressable
                      testID={
                        tab.kind === "agent"
                          ? `workspace-agent-close-${tab.agentId}`
                          : tab.kind === "terminal"
                            ? `workspace-terminal-close-${tab.terminalId}`
                            : tab.kind === "draft"
                              ? `workspace-draft-close-${tab.draftId}`
                              : `workspace-file-close-${encodeFilePathForPathSegment(tab.filePath)}`
                      }
                      disabled={isClosingTab}
                      onHoverIn={() => {
                        setHoveredTabKey(tab.key);
                        setHoveredCloseTabKey(tab.key);
                      }}
                      onHoverOut={() => {
                        setHoveredTabKey((current) => (current === tab.key ? null : current));
                        setHoveredCloseTabKey((current) => (current === tab.key ? null : current));
                      }}
                      onPress={(event) => {
                        event.stopPropagation?.();
                        void onCloseTab(tab.tabId);
                      }}
                      style={({ hovered, pressed }) => [
                        styles.tabCloseButton,
                        styles.tabCloseButtonShown,
                        (hovered || pressed) && styles.tabCloseButtonActive,
                      ]}
                    >
                      {isClosingTab ? (
                        <ActivityIndicator size={12} color={theme.colors.foregroundMuted} />
                      ) : (
                        <X size={12} color={theme.colors.foregroundMuted} />
                      )}
                    </Pressable>
                  ) : null}
                </ContextMenuTrigger>

                <ContextMenuContent align="start" width={DROPDOWN_WIDTH} testID={contextMenuTestId}>
                  {tab.kind === "agent" ? (
                    <>
                      <ContextMenuItem
                        testID={`${contextMenuTestId}-copy-resume-command`}
                        onSelect={() => {
                          void onCopyResumeCommand(tab.agentId);
                        }}
                      >
                        Copy resume command
                      </ContextMenuItem>
                      <ContextMenuItem
                        testID={`${contextMenuTestId}-copy-agent-id`}
                        onSelect={() => {
                          void onCopyAgentId(tab.agentId);
                        }}
                      >
                        Copy agent id
                      </ContextMenuItem>
                    </>
                  ) : null}

                  <ContextMenuSeparator />

                  <ContextMenuItem
                    testID={`${contextMenuTestId}-close-right`}
                    disabled={tabs.findIndex((t) => t.key === tab.key) === tabs.length - 1}
                    onSelect={() => {
                      void onCloseTabsToRight(tab.tabId);
                    }}
                  >
                    Close to the right
                  </ContextMenuItem>
                  <ContextMenuItem
                    testID={`${contextMenuTestId}-close`}
                    onSelect={() => {
                      void onCloseTab(tab.tabId);
                    }}
                  >
                    Close
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          }}
        />
      </ScrollView>
      <View style={styles.tabsActions} onLayout={onActionsLayout}>
        <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
          <TooltipTrigger
            testID="workspace-new-agent-tab"
            onPress={() => onSelectNewTabOption(newTabAgentOptionId)}
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
            onPress={() => onSelectNewTabOption(newTabTerminalOptionId)}
            onHoverIn={() => setIsNewTerminalHovered(true)}
            onHoverOut={() => setIsNewTerminalHovered(false)}
            disabled={createTerminalPending}
            accessibilityRole="button"
            accessibilityLabel="New terminal tab"
            style={({ hovered, pressed }) => [
              styles.newTabActionButton,
              createTerminalPending && styles.newTabActionButtonDisabled,
              (hovered || pressed) && styles.newTabActionButtonHovered,
            ]}
          >
            {createTerminalPending ? (
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
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
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
  tab: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  tabIconOnly: {
    justifyContent: "center",
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
  tabCloseButtonActive: {
    backgroundColor: theme.colors.surface3,
  },
  newTabActionButton: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  newTabActionButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  newTabActionButtonDisabled: {
    opacity: 0.5,
  },
  terminalPlusIcon: {
    width: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  terminalPlusBadge: {
    position: "absolute",
    right: -7,
    bottom: -7,
    width: 12,
    height: 12,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.colors.surface0,
    backgroundColor: theme.colors.surface0,
  },
  terminalPlusBadgeHovered: {
    backgroundColor: theme.colors.surface2,
  },
  newTabTooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
}));
