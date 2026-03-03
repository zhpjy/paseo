import { View, Text, Pressable, Image, Platform, Alert, ActivityIndicator, StatusBar } from 'react-native'
import { useQueries } from '@tanstack/react-query'
import {
  useCallback,
  useMemo,
  useState,
  useEffect,
  useRef,
  type ReactElement,
  type MutableRefObject,
} from 'react'
import { router, usePathname, useSegments } from 'expo-router'
import { StyleSheet, UnistylesRuntime, useUnistyles } from 'react-native-unistyles'
import { Gesture, GestureDetector, type GestureType } from 'react-native-gesture-handler'
import { Archive, ChevronDown, ChevronRight } from 'lucide-react-native'
import { DraggableList, type DraggableRenderItemInfo } from './draggable-list'
import { getHostRuntimeStore, isHostRuntimeConnected } from '@/runtime/host-runtime'
import { getIsTauri } from '@/constants/layout'
import { projectIconQueryKey } from '@/hooks/use-project-icon-query'
import {
  buildHostWorkspaceRoute,
  parseHostWorkspaceAgentRouteFromPathname,
  parseHostWorkspaceRouteFromPathname,
  parseHostWorkspaceTerminalRouteFromPathname,
} from '@/utils/host-routes'
import {
  type SidebarProjectEntry,
  type SidebarWorkspaceEntry,
} from '@/hooks/use-sidebar-agents-list'
import { useSidebarOrderStore } from '@/stores/sidebar-order-store'
import { useCheckoutGitActionsStore } from '@/stores/checkout-git-actions-store'
import { useKeyboardShortcutsStore } from '@/stores/keyboard-shortcuts-store'
import { formatTimeAgo } from '@/utils/time'
import type { SidebarStateBucket } from '@/utils/sidebar-agent-state'
import { confirmDialog } from '@/utils/confirm-dialog'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  useContextMenu,
} from '@/components/ui/context-menu'
import { deriveProjectDisplayName } from '@/utils/agent-grouping'
import {
  buildSidebarWorkspaceViewModel,
  type SidebarWorkspaceTreeRow,
} from '@/utils/sidebar-shortcuts'

function toProjectIconDataUri(icon: { mimeType: string; data: string } | null): string | null {
  if (!icon) {
    return null
  }
  return `data:${icon.mimeType};base64,${icon.data}`
}

interface SidebarAgentListProps {
  isOpen?: boolean
  projects: SidebarProjectEntry[]
  serverId: string | null
  isRefreshing?: boolean
  onRefresh?: () => void
  onWorkspacePress?: () => void
  listFooterComponent?: ReactElement | null
  /** Gesture ref for coordinating with parent gestures (e.g., sidebar close) */
  parentGestureRef?: MutableRefObject<GestureType | undefined>
}

interface ProjectRowProps {
  project: SidebarProjectEntry
  displayName: string
  iconDataUri: string | null
  collapsed: boolean
  onToggle: () => void
  onLongPress: () => void
}

interface WorkspaceRowProps {
  workspace: SidebarWorkspaceEntry
  selected: boolean
  shortcutNumber: number | null
  showShortcutBadge: boolean
  onPress: () => void
  drag: () => void
}

function resolveWorkspaceBranchLabel(workspace: SidebarWorkspaceEntry): string {
  const branch = workspace.branchName?.trim()
  if (branch && branch.length > 0) {
    return branch
  }
  return 'Unknown branch'
}

function resolveWorkspaceCreatedAtLabel(workspace: SidebarWorkspaceEntry): string | null {
  if (!workspace.createdAt) {
    return null
  }
  return formatTimeAgo(workspace.createdAt)
}

function resolveStatusDotColor(input: { theme: ReturnType<typeof useUnistyles>['theme']; bucket: SidebarStateBucket }) {
  const { theme, bucket } = input
  return bucket === 'needs_input'
    ? theme.colors.palette.amber[500]
    : bucket === 'failed'
      ? theme.colors.palette.red[500]
      : bucket === 'running'
        ? theme.colors.palette.blue[500]
        : bucket === 'attention'
          ? theme.colors.palette.green[500]
          : theme.colors.border
}

function WorkspaceStatusIndicator({
  bucket,
  loading = false,
}: {
  bucket: SidebarWorkspaceEntry['statusBucket']
  loading?: boolean
}) {
  const { theme } = useUnistyles()
  const color = resolveStatusDotColor({ theme, bucket })

  return (
    <View style={styles.workspaceStatusDot}>
      {loading ? (
        <ActivityIndicator size={8} color={theme.colors.foregroundMuted} />
      ) : (
        <View style={[styles.workspaceStatusDotFill, { backgroundColor: color }]} />
      )}
    </View>
  )
}

function ProjectRow({
  project,
  displayName,
  iconDataUri,
  collapsed,
  onToggle,
  onLongPress,
}: ProjectRowProps) {
  const didLongPressRef = useRef(false)

  const handlePress = useCallback(() => {
    if (didLongPressRef.current) {
      didLongPressRef.current = false
      return
    }
    onToggle()
  }, [onToggle])

  const handleLongPress = useCallback(() => {
    didLongPressRef.current = true
    onLongPress()
  }, [onLongPress])

  return (
    <Pressable
      style={({ pressed, hovered = false }) => [
        styles.projectRow,
        hovered && styles.projectRowHovered,
        pressed && styles.projectRowPressed,
      ]}
      onPress={handlePress}
      onLongPress={handleLongPress}
      delayLongPress={200}
      testID={`sidebar-project-row-${project.projectKey}`}
    >
      <View style={styles.projectRowLeft}>
        {collapsed ? (
          <ChevronRight size={14} color="#9ca3af" />
        ) : (
          <ChevronDown size={14} color="#9ca3af" />
        )}

        {iconDataUri ? (
          <Image source={{ uri: iconDataUri }} style={styles.projectIcon} />
        ) : (
          <View style={styles.projectIconFallback}>
            <Text style={styles.projectIconFallbackText}>
              {displayName.charAt(0).toUpperCase()}
            </Text>
          </View>
        )}

        <Text style={styles.projectTitle} numberOfLines={1}>
          {displayName}
        </Text>
      </View>
    </Pressable>
  )
}

function WorkspaceRow({
  workspace,
  selected,
  shortcutNumber,
  showShortcutBadge,
  onPress,
  drag,
}: WorkspaceRowProps) {
  const { theme } = useUnistyles()
  const createdAtLabel = resolveWorkspaceCreatedAtLabel(workspace)

  const { setAnchorRect, setOpen } = useContextMenu()
  const didLongPressRef = useRef(false)
  const didLongPressCleanupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressArmedRef = useRef(false)
  const longPressCancelledRef = useRef(false)
  const didStartDragRef = useRef(false)
  const touchStartRef = useRef<{ x: number; y: number } | null>(null)

  const archiveStatus = useCheckoutGitActionsStore((state) =>
    state.getStatus({
      serverId: workspace.serverId,
      cwd: workspace.cwd,
      actionId: 'archive-worktree',
    })
  )
  const runArchiveWorktree = useCheckoutGitActionsStore((state) => state.archiveWorktree)
  const isArchiving = archiveStatus === 'pending'

  const openContextMenuAtTouchStart = useCallback(() => {
    const point = touchStartRef.current
    if (!point) {
      return
    }
    const statusBarHeight = Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) : 0
    setAnchorRect({
      x: point.x,
      y: point.y + statusBarHeight,
      width: 0,
      height: 0,
    })
    setOpen(true)
  }, [setAnchorRect, setOpen])

  const handleArchiveWorktree = useCallback(() => {
    if (!workspace.isPaseoOwnedWorktree) {
      return
    }

    void confirmDialog({
      title: 'Archive worktree?',
      message: `Archive this worktree?\n\n${workspace.cwd}`,
      confirmLabel: 'Archive',
      cancelLabel: 'Cancel',
      destructive: true,
    })
      .then((confirmed) => {
        if (!confirmed) {
          return
        }
        return runArchiveWorktree({
          serverId: workspace.serverId,
          cwd: workspace.cwd,
          worktreePath: workspace.cwd,
        })
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : 'Failed to archive worktree'
        Alert.alert('Error', message)
      })
  }, [runArchiveWorktree, workspace.cwd, workspace.isPaseoOwnedWorktree, workspace.serverId])

  const handlePress = useCallback(() => {
    if (didLongPressRef.current) {
      didLongPressRef.current = false
      return
    }
    onPress()
  }, [onPress])

  const handleLongPress = useCallback(() => {
    if (longPressCancelledRef.current) {
      return
    }
    didLongPressRef.current = true
    longPressArmedRef.current = true
  }, [])

  const moveMonitorGesture = useMemo(() => {
    if (Platform.OS === 'web') {
      return null
    }

    const CANCEL_SLOP_PX = 10
    const DRAG_SLOP_PX = 8

    return Gesture.Pan()
      .manualActivation(true)
      .runOnJS(true)
      .onTouchesDown((event) => {
        const touch = event.changedTouches[0]
        if (!touch) {
          return
        }
        touchStartRef.current = { x: touch.absoluteX, y: touch.absoluteY }
      })
      .onTouchesMove((event, stateManager) => {
        const touch = event.changedTouches[0]
        if (!touch || event.numberOfTouches !== 1) {
          stateManager.fail()
          return
        }

        const start = touchStartRef.current
        if (!start) {
          touchStartRef.current = { x: touch.absoluteX, y: touch.absoluteY }
          return
        }

        const dx = touch.absoluteX - start.x
        const dy = touch.absoluteY - start.y
        const distance = Math.sqrt(dx * dx + dy * dy)

        if (!longPressArmedRef.current) {
          if (distance > CANCEL_SLOP_PX) {
            longPressCancelledRef.current = true
            stateManager.fail()
          }
          return
        }

        if (didStartDragRef.current) {
          return
        }

        if (distance > DRAG_SLOP_PX) {
          didStartDragRef.current = true
          drag()
          stateManager.fail()
        }
      })
  }, [drag])

  const trigger = (
    <ContextMenuTrigger
      enabledOnMobile={false}
      style={({ pressed, hovered = false }) => [
        styles.workspaceRow,
        selected && styles.workspaceRowSelected,
        hovered && styles.workspaceRowHovered,
        pressed && styles.workspaceRowPressed,
      ]}
      onPressIn={(event) => {
        if (didLongPressCleanupTimerRef.current) {
          clearTimeout(didLongPressCleanupTimerRef.current)
          didLongPressCleanupTimerRef.current = null
        }
        longPressCancelledRef.current = false
        longPressArmedRef.current = false
        didStartDragRef.current = false
        touchStartRef.current = { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY }
      }}
      onPressOut={() => {
        if (Platform.OS === 'web') {
          return
        }
        if (!longPressArmedRef.current || didStartDragRef.current) {
          longPressCancelledRef.current = false
          longPressArmedRef.current = false
          didStartDragRef.current = false
          touchStartRef.current = null
          return
        }
        openContextMenuAtTouchStart()
        didLongPressCleanupTimerRef.current = setTimeout(() => {
          didLongPressRef.current = false
          didLongPressCleanupTimerRef.current = null
        }, 0)
        longPressCancelledRef.current = false
        longPressArmedRef.current = false
        didStartDragRef.current = false
        touchStartRef.current = null
      }}
      onPress={handlePress}
      onLongPress={handleLongPress}
      delayLongPress={200}
      testID={`sidebar-workspace-row-${workspace.workspaceKey}`}
    >
      <View style={styles.workspaceRowLeft}>
        <WorkspaceStatusIndicator bucket={workspace.statusBucket} loading={isArchiving} />
        <Text style={styles.workspaceBranchText} numberOfLines={1}>
          {resolveWorkspaceBranchLabel(workspace)}
        </Text>
      </View>
      <View style={styles.workspaceRowRight}>
        {createdAtLabel ? (
          <Text style={styles.workspaceCreatedAtText} numberOfLines={1}>
            {createdAtLabel}
          </Text>
        ) : null}
        {showShortcutBadge && shortcutNumber !== null ? (
          <View style={styles.shortcutBadge}>
            <Text style={styles.shortcutBadgeText}>{shortcutNumber}</Text>
          </View>
        ) : null}
      </View>
    </ContextMenuTrigger>
  )

  return (
    <>
      {moveMonitorGesture ? (
        <GestureDetector gesture={moveMonitorGesture}>{trigger}</GestureDetector>
      ) : (
        trigger
      )}

      <ContextMenuContent
        align="start"
        width={220}
        testID={`sidebar-workspace-context-${workspace.workspaceKey}`}
      >
        <ContextMenuItem
          leading={<Archive size={16} color={theme.colors.foregroundMuted} />}
          destructive
          disabled={!workspace.isPaseoOwnedWorktree}
          status={workspace.isPaseoOwnedWorktree ? archiveStatus : 'idle'}
          pendingLabel="Archiving…"
          successLabel="Archived"
          onSelect={handleArchiveWorktree}
          testID={`sidebar-workspace-context-${workspace.workspaceKey}-archive`}
        >
          Archive worktree
        </ContextMenuItem>
      </ContextMenuContent>
    </>
  )
}

function WorkspaceRowWithMenu({
  workspace,
  selected,
  shortcutNumber,
  showShortcutBadge,
  onPress,
  drag,
}: {
  workspace: SidebarWorkspaceEntry
  selected: boolean
  shortcutNumber: number | null
  showShortcutBadge: boolean
  onPress: () => void
  drag: () => void
}) {
  return (
    <ContextMenu>
      <WorkspaceRow
        workspace={workspace}
        selected={selected}
        shortcutNumber={shortcutNumber}
        showShortcutBadge={showShortcutBadge}
        onPress={onPress}
        drag={drag}
      />
    </ContextMenu>
  )
}

function mergeWithRemainder(input: {
  currentOrder: string[]
  reorderedVisibleKeys: string[]
}): string[] {
  const reorderedSet = new Set(input.reorderedVisibleKeys)
  const remainder = input.currentOrder.filter((key) => !reorderedSet.has(key))
  return [...input.reorderedVisibleKeys, ...remainder]
}

function hasVisibleOrderChanged(input: {
  currentOrder: string[]
  reorderedVisibleKeys: string[]
}): boolean {
  const currentVisible = input.currentOrder.filter((key) =>
    input.reorderedVisibleKeys.includes(key)
  )
  if (currentVisible.length !== input.reorderedVisibleKeys.length) {
    return true
  }
  return input.reorderedVisibleKeys.some((key, index) => currentVisible[index] !== key)
}

export function SidebarAgentList({
  isOpen = true,
  projects,
  serverId,
  isRefreshing = false,
  onRefresh,
  onWorkspacePress,
  listFooterComponent,
  parentGestureRef,
}: SidebarAgentListProps) {
  const isMobile = UnistylesRuntime.breakpoint === 'xs' || UnistylesRuntime.breakpoint === 'sm'
  const showDesktopWebScrollbar = Platform.OS === 'web' && !isMobile
  const segments = useSegments()
  const pathname = usePathname()
  const shouldReplaceWorkspaceNavigation = segments[0] === 'h'
  const [collapsedProjectKeys, setCollapsedProjectKeys] = useState<Set<string>>(new Set())
  const [canonicalResyncNonce, setCanonicalResyncNonce] = useState(0)
  const isTauri = getIsTauri()
  const altDown = useKeyboardShortcutsStore((state) => state.altDown)
  const cmdOrCtrlDown = useKeyboardShortcutsStore((state) => state.cmdOrCtrlDown)
  const setSidebarShortcutWorkspaceTargets = useKeyboardShortcutsStore(
    (state) => state.setSidebarShortcutWorkspaceTargets
  )
  const showShortcutBadges = altDown || (isTauri && cmdOrCtrlDown)

  const getProjectOrder = useSidebarOrderStore((state) => state.getProjectOrder)
  const setProjectOrder = useSidebarOrderStore((state) => state.setProjectOrder)
  const getWorkspaceOrder = useSidebarOrderStore((state) => state.getWorkspaceOrder)
  const setWorkspaceOrder = useSidebarOrderStore((state) => state.setWorkspaceOrder)

  const activeWorkspaceSelection = useMemo(() => {
    if (!pathname) {
      return null
    }
    const parsed =
      parseHostWorkspaceAgentRouteFromPathname(pathname) ??
      parseHostWorkspaceTerminalRouteFromPathname(pathname) ??
      parseHostWorkspaceRouteFromPathname(pathname)
    if (!parsed) {
      return null
    }
    return {
      serverId: parsed.serverId,
      workspaceId: parsed.workspaceId,
    }
  }, [pathname])

  useEffect(() => {
    setCollapsedProjectKeys((prev) => {
      const validProjectKeys = new Set(projects.map((project) => project.projectKey))
      const next = new Set<string>()
      for (const key of prev) {
        if (validProjectKeys.has(key)) {
          next.add(key)
        }
      }
      return next
    })
  }, [projects])

  const projectIconRequests = useMemo(() => {
    if (!isOpen || !serverId) {
      return []
    }
    const unique = new Map<string, { serverId: string; cwd: string }>()
    for (const project of projects) {
      const cwd = project.iconWorkingDir.trim()
      if (!cwd) {
        continue
      }
      unique.set(`${serverId}:${cwd}`, { serverId, cwd })
    }
    return Array.from(unique.values())
  }, [isOpen, projects, serverId])

  const projectIconQueries = useQueries({
    queries: projectIconRequests.map((request) => ({
      queryKey: projectIconQueryKey(request.serverId, request.cwd),
      queryFn: async () => {
        const client = getHostRuntimeStore().getClient(request.serverId)
        if (!client) {
          return null
        }
        const result = await client.requestProjectIcon(request.cwd)
        return result.icon
      },
      select: toProjectIconDataUri,
      enabled: Boolean(
        isOpen &&
        getHostRuntimeStore().getClient(request.serverId) &&
        isHostRuntimeConnected(getHostRuntimeStore().getSnapshot(request.serverId)) &&
        request.cwd
      ),
      staleTime: Infinity,
      gcTime: 1000 * 60 * 60,
      refetchOnMount: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    })),
  })

  const projectIconByProjectKey = useMemo(() => {
    const iconByServerAndCwd = new Map<string, string | null>()
    for (let index = 0; index < projectIconRequests.length; index += 1) {
      const request = projectIconRequests[index]
      if (!request) {
        continue
      }
      iconByServerAndCwd.set(
        `${request.serverId}:${request.cwd}`,
        projectIconQueries[index]?.data ?? null
      )
    }

    const byProject = new Map<string, string | null>()
    for (const project of projects) {
      const cwd = project.iconWorkingDir.trim()
      if (!cwd || !serverId) {
        byProject.set(project.projectKey, null)
        continue
      }
      byProject.set(project.projectKey, iconByServerAndCwd.get(`${serverId}:${cwd}`) ?? null)
    }

    return byProject
  }, [projectIconQueries, projectIconRequests, projects, serverId])

  const viewModel = useMemo(
    () =>
      buildSidebarWorkspaceViewModel({
        projects,
        collapsedProjectKeys,
        getProjectDisplayName: (project) =>
          deriveProjectDisplayName({
            projectKey: project.projectKey,
            projectName: project.projectName,
          }),
      }),
    [canonicalResyncNonce, collapsedProjectKeys, projects]
  )

  useEffect(() => {
    setSidebarShortcutWorkspaceTargets(viewModel.shortcutTargets)
  }, [setSidebarShortcutWorkspaceTargets, viewModel.shortcutTargets])

  useEffect(() => {
    return () => {
      setSidebarShortcutWorkspaceTargets([])
    }
  }, [setSidebarShortcutWorkspaceTargets])

  const toggleProjectCollapsed = useCallback((projectKey: string) => {
    setCollapsedProjectKeys((prev) => {
      const next = new Set(prev)
      if (next.has(projectKey)) {
        next.delete(projectKey)
      } else {
        next.add(projectKey)
      }
      return next
    })
  }, [])

  const renderRow = useCallback(
    ({ item, drag }: DraggableRenderItemInfo<SidebarWorkspaceTreeRow>) => {
      if (item.kind === 'project') {
        return (
          <ProjectRow
            project={item.project}
            displayName={item.displayName}
            iconDataUri={projectIconByProjectKey.get(item.project.projectKey) ?? null}
            collapsed={collapsedProjectKeys.has(item.project.projectKey)}
            onToggle={() => toggleProjectCollapsed(item.project.projectKey)}
            onLongPress={drag}
          />
        )
      }

      const workspaceRoute = buildHostWorkspaceRoute(serverId ?? '', item.workspace.cwd)
      const navigate = shouldReplaceWorkspaceNavigation ? router.replace : router.push
      const isSelected =
        Boolean(serverId) &&
        activeWorkspaceSelection?.serverId === serverId &&
        activeWorkspaceSelection.workspaceId === item.workspace.cwd

      return (
        <WorkspaceRowWithMenu
          workspace={item.workspace}
          selected={isSelected}
          shortcutNumber={item.shortcutNumber}
          showShortcutBadge={showShortcutBadges}
          onPress={() => {
            if (!serverId) {
              return
            }
            onWorkspacePress?.()
            navigate(workspaceRoute as any)
          }}
          drag={drag}
        />
      )
    },
    [
      activeWorkspaceSelection,
      collapsedProjectKeys,
      onWorkspacePress,
      projectIconByProjectKey,
      serverId,
      showShortcutBadges,
      shouldReplaceWorkspaceNavigation,
      toggleProjectCollapsed,
    ]
  )

  const keyExtractor = useCallback((entry: SidebarWorkspaceTreeRow) => entry.rowKey, [])

  const handleDragEnd = useCallback(
    (reorderedRows: SidebarWorkspaceTreeRow[]) => {
      if (!serverId) {
        return
      }

      let didPersistOrderChange = false
      const reorderedProjectKeys = reorderedRows
        .filter(
          (row): row is Extract<SidebarWorkspaceTreeRow, { kind: 'project' }> =>
            row.kind === 'project'
        )
        .map((row) => row.project.projectKey)

      const currentProjectOrder = getProjectOrder(serverId)
      if (
        hasVisibleOrderChanged({
          currentOrder: currentProjectOrder,
          reorderedVisibleKeys: reorderedProjectKeys,
        })
      ) {
        didPersistOrderChange = true
        setProjectOrder(
          serverId,
          mergeWithRemainder({
            currentOrder: currentProjectOrder,
            reorderedVisibleKeys: reorderedProjectKeys,
          })
        )
      }

      const workspaceRowsByProject = new Map<string, string[]>()
      for (const row of reorderedRows) {
        if (row.kind !== 'workspace') {
          continue
        }
        const list = workspaceRowsByProject.get(row.projectKey) ?? []
        list.push(row.workspace.workspaceKey)
        workspaceRowsByProject.set(row.projectKey, list)
      }

      for (const [projectKey, reorderedWorkspaceKeys] of workspaceRowsByProject.entries()) {
        const currentWorkspaceOrder = getWorkspaceOrder(serverId, projectKey)
        if (
          !hasVisibleOrderChanged({
            currentOrder: currentWorkspaceOrder,
            reorderedVisibleKeys: reorderedWorkspaceKeys,
          })
        ) {
          continue
        }

        didPersistOrderChange = true
        setWorkspaceOrder(
          serverId,
          projectKey,
          mergeWithRemainder({
            currentOrder: currentWorkspaceOrder,
            reorderedVisibleKeys: reorderedWorkspaceKeys,
          })
        )
      }

      // If persisted ordering did not change, force a local resync so draggable UI state
      // snaps back to canonical Project -> Workspaces grouping.
      if (!didPersistOrderChange) {
        setCanonicalResyncNonce((prev) => prev + 1)
      }
    },
    [getProjectOrder, getWorkspaceOrder, serverId, setProjectOrder, setWorkspaceOrder]
  )

  return (
    <View style={styles.container}>
      <DraggableList
        data={viewModel.rows}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        testID="sidebar-project-workspace-list-scroll"
        keyExtractor={keyExtractor}
        renderItem={renderRow}
        onDragEnd={handleDragEnd}
        showsVerticalScrollIndicator={false}
        enableDesktopWebScrollbar={showDesktopWebScrollbar}
        ListFooterComponent={listFooterComponent}
        ListEmptyComponent={<Text style={styles.emptyText}>No projects yet</Text>}
        refreshing={isRefreshing}
        onRefresh={onRefresh}
        simultaneousGestureRef={parentGestureRef}
      />
    </View>
  )
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[4],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    textAlign: 'center',
    marginTop: theme.spacing[8],
    marginHorizontal: theme.spacing[2],
  },
  projectRow: {
    minHeight: 36,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    marginBottom: theme.spacing[1],
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing[2],
  },
  projectRowHovered: {
    backgroundColor: theme.colors.surface1,
  },
  projectRowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  projectRowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[2],
    flex: 1,
    minWidth: 0,
  },
  projectIcon: {
    width: theme.iconSize.sm,
    height: theme.iconSize.sm,
    borderRadius: theme.borderRadius.sm,
  },
  projectIconFallback: {
    width: theme.iconSize.sm,
    height: theme.iconSize.sm,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  projectIconFallbackText: {
    color: theme.colors.foregroundMuted,
    fontSize: 9,
  },
  projectTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    flex: 1,
    minWidth: 0,
  },
  workspaceRow: {
    minHeight: 36,
    marginBottom: theme.spacing[1],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing[2],
  },
  workspaceRowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[2],
    flex: 1,
    minWidth: 0,
  },
  workspaceRowRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[2],
    flexShrink: 0,
  },
  workspaceRowHovered: {
    backgroundColor: theme.colors.surface1,
  },
  workspaceRowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  workspaceRowSelected: {
    backgroundColor: theme.colors.surface2,
  },
  workspaceStatusDot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  workspaceStatusDotFill: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
  },
  workspaceBranchText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    flex: 1,
    minWidth: 0,
  },
  workspaceCreatedAtText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    flexShrink: 0,
  },
  shortcutBadge: {
    minWidth: 18,
    height: 18,
    paddingHorizontal: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shortcutBadgeText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: '600',
    lineHeight: 14,
  },
}))
