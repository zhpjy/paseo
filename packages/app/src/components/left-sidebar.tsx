import { useCallback, useMemo, useState, useEffect, useRef, useSyncExternalStore } from 'react'
import { View, Pressable, Text, Platform } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Animated, {
  useAnimatedStyle,
  interpolate,
  Extrapolation,
  runOnJS,
  useSharedValue,
} from 'react-native-reanimated'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import { StyleSheet, UnistylesRuntime, useUnistyles } from 'react-native-unistyles'
import { Plus, Settings, Users } from 'lucide-react-native'
import { router, usePathname } from 'expo-router'
import { usePanelStore } from '@/stores/panel-store'
import { SidebarAgentList } from './sidebar-agent-list'
import { SidebarAgentListSkeleton } from './sidebar-agent-list-skeleton'
import { useSidebarAgentsList } from '@/hooks/use-sidebar-agents-list'
import { useSidebarAnimation } from '@/contexts/sidebar-animation-context'
import { useTauriDragHandlers, useTrafficLightPadding } from '@/utils/tauri-window'
import { Combobox } from '@/components/ui/combobox'
import { useDaemonRegistry } from '@/contexts/daemon-registry-context'
import { getHostRuntimeStore } from '@/runtime/host-runtime'
import { useSessionStore } from '@/stores/session-store'
import { formatConnectionStatus } from '@/utils/daemons'
import { HEADER_INNER_HEIGHT, HEADER_INNER_HEIGHT_MOBILE } from '@/constants/layout'
import {
  checkoutStatusQueryKey,
  type CheckoutStatusPayload,
} from '@/hooks/use-checkout-status-query'
import { queryClient } from '@/query/query-client'
import {
  buildNewAgentRoute,
  resolveNewAgentWorkingDir,
  resolveSelectedAgentForNewAgent,
} from '@/utils/new-agent-routing'
import {
  buildHostAgentsRoute,
  buildHostSettingsRoute,
  mapPathnameToServer,
  parseServerIdFromPathname,
} from '@/utils/host-routes'

const DESKTOP_SIDEBAR_WIDTH = 320

interface LeftSidebarProps {
  selectedAgentId?: string
}

export function LeftSidebar({ selectedAgentId }: LeftSidebarProps) {
  const { theme } = useUnistyles()
  const insets = useSafeAreaInsets()
  const isMobile = UnistylesRuntime.breakpoint === 'xs' || UnistylesRuntime.breakpoint === 'sm'
  const mobileView = usePanelStore((state) => state.mobileView)
  const desktopAgentListOpen = usePanelStore((state) => state.desktop.agentListOpen)
  const closeToAgent = usePanelStore((state) => state.closeToAgent)
  const pathname = usePathname()
  const { daemons } = useDaemonRegistry()
  const runtime = getHostRuntimeStore()
  const runtimeConnectionStatusSignature = useSyncExternalStore(
    (onStoreChange) => runtime.subscribeAll(onStoreChange),
    () =>
      daemons
        .map(
          (daemon) =>
            `${daemon.serverId}:${
              runtime.getSnapshot(daemon.serverId)?.connectionStatus ?? 'connecting'
            }`
        )
        .join('|'),
    () =>
      daemons
        .map(
          (daemon) =>
            `${daemon.serverId}:${
              runtime.getSnapshot(daemon.serverId)?.connectionStatus ?? 'connecting'
            }`
        )
        .join('|')
  )
  const activeServerIdFromPath = useMemo(() => parseServerIdFromPathname(pathname), [pathname])
  const activeServerId = activeServerIdFromPath ?? daemons[0]?.serverId ?? null
  const activeHostLabel = useMemo(() => {
    if (!activeServerId) return 'No host'
    const daemon = daemons.find((entry) => entry.serverId === activeServerId)
    const trimmed = daemon?.label?.trim()
    return trimmed && trimmed.length > 0 ? trimmed : activeServerId
  }, [activeServerId, daemons])
  const activeHostStatus = activeServerId
    ? (runtime.getSnapshot(activeServerId)?.connectionStatus ?? 'connecting')
    : 'idle'
  const activeHostStatusColor =
    activeHostStatus === 'online'
      ? theme.colors.palette.green[400]
      : activeHostStatus === 'connecting'
        ? theme.colors.palette.amber[500]
        : theme.colors.palette.red[500]
  const hostOptions = useMemo(
    () =>
      daemons.map((daemon) => ({
        id: daemon.serverId,
        label: daemon.label?.trim() || daemon.serverId,
        description: formatConnectionStatus(
          runtime.getSnapshot(daemon.serverId)?.connectionStatus ?? 'connecting'
        ),
      })),
    [daemons, runtime, runtimeConnectionStatusSignature]
  )
  const hostTriggerRef = useRef<View>(null)
  const [isHostPickerOpen, setIsHostPickerOpen] = useState(false)

  // Derive isOpen from the unified panel state
  const isOpen = isMobile ? mobileView === 'agent-list' : desktopAgentListOpen

  const { projects, isInitialLoad, isRevalidating, refreshAll } = useSidebarAgentsList({
    serverId: activeServerId,
    enabled: isOpen,
  })
  const {
    translateX,
    backdropOpacity,
    windowWidth,
    animateToOpen,
    animateToClose,
    isGesturing,
    closeGestureRef,
  } = useSidebarAnimation()
  const dragHandlers = useTauriDragHandlers()
  const trafficLightPadding = useTrafficLightPadding()
  const closeTouchStartX = useSharedValue(0)
  const closeTouchStartY = useSharedValue(0)

  // Track user-initiated refresh to avoid showing spinner on background revalidation
  const [isManualRefresh, setIsManualRefresh] = useState(false)

  const handleRefresh = useCallback(() => {
    setIsManualRefresh(true)
    refreshAll()
  }, [refreshAll])

  // Reset manual refresh flag when revalidation completes
  useEffect(() => {
    if (!isRevalidating && isManualRefresh) {
      setIsManualRefresh(false)
    }
  }, [isRevalidating, isManualRefresh])

  const handleClose = useCallback(() => {
    closeToAgent()
  }, [closeToAgent])

  const handleCreateAgentClean = useCallback(() => {
    let targetServerId = activeServerId
    let targetWorkingDir: string | null = null

    const selectedAgent = resolveSelectedAgentForNewAgent({
      pathname,
      selectedAgentId,
    })
    if (selectedAgent) {
      targetServerId = selectedAgent.serverId
      const agent = useSessionStore
        .getState()
        .sessions[selectedAgent.serverId]?.agents?.get(selectedAgent.agentId)
      const cwd = agent?.cwd?.trim()
      if (cwd) {
        const checkout =
          queryClient.getQueryData<CheckoutStatusPayload>(
            checkoutStatusQueryKey(selectedAgent.serverId, cwd)
          ) ?? null
        targetWorkingDir = resolveNewAgentWorkingDir(cwd, checkout)
      }
    }

    if (!targetServerId) {
      return
    }
    router.push(buildNewAgentRoute(targetServerId, targetWorkingDir) as any)
  }, [activeServerId, pathname, selectedAgentId])

  // Mobile: close sidebar and navigate
  const handleCreateAgentCleanMobile = useCallback(() => {
    closeToAgent()
    handleCreateAgentClean()
  }, [closeToAgent, handleCreateAgentClean])

  // Desktop: just navigate, don't close
  const handleCreateAgentCleanDesktop = useCallback(() => {
    handleCreateAgentClean()
  }, [handleCreateAgentClean])

  // Mobile: close sidebar and navigate
  const handleSettingsMobile = useCallback(() => {
    if (!activeServerId) {
      return
    }
    closeToAgent()
    router.push(buildHostSettingsRoute(activeServerId) as any)
  }, [activeServerId, closeToAgent])

  // Desktop: just navigate, don't close
  const handleSettingsDesktop = useCallback(() => {
    if (!activeServerId) {
      return
    }
    router.push(buildHostSettingsRoute(activeServerId) as any)
  }, [activeServerId])

  const handleViewMore = useCallback(() => {
    if (!activeServerId) {
      return
    }
    if (isMobile) {
      translateX.value = -windowWidth
      backdropOpacity.value = 0
      closeToAgent()
    }
    router.push(buildHostAgentsRoute(activeServerId) as any)
  }, [activeServerId, backdropOpacity, closeToAgent, isMobile, translateX, windowWidth])

  const handleHostSelect = useCallback(
    (nextServerId: string) => {
      if (!nextServerId) {
        return
      }
      const nextPath = mapPathnameToServer(pathname, nextServerId)
      setIsHostPickerOpen(false)
      router.push(nextPath as any)
    },
    [pathname]
  )

  // Close gesture (swipe left to close when sidebar is open)
  const closeGesture = Gesture.Pan()
    .withRef(closeGestureRef)
    .enabled(isOpen)
    // Use manual activation so child views keep touch streams unless we detect
    // an intentional left-swipe close (mirrors explorer-sidebar pattern).
    .manualActivation(true)
    .onTouchesDown((event) => {
      const touch = event.changedTouches[0]
      if (!touch) {
        return
      }
      closeTouchStartX.value = touch.absoluteX
      closeTouchStartY.value = touch.absoluteY
    })
    .onTouchesMove((event, stateManager) => {
      const touch = event.changedTouches[0]
      if (!touch || event.numberOfTouches !== 1) {
        stateManager.fail()
        return
      }

      const deltaX = touch.absoluteX - closeTouchStartX.value
      const deltaY = touch.absoluteY - closeTouchStartY.value
      const absDeltaX = Math.abs(deltaX)
      const absDeltaY = Math.abs(deltaY)

      // Fail quickly on clear rightward or vertical intent so child views keep control.
      if (deltaX >= 10) {
        stateManager.fail()
        return
      }
      if (absDeltaY > 10 && absDeltaY > absDeltaX) {
        stateManager.fail()
        return
      }

      // Activate only on intentional leftward movement.
      if (deltaX <= -15 && absDeltaX > absDeltaY) {
        stateManager.activate()
      }
    })
    .onStart(() => {
      isGesturing.value = true
    })
    .onUpdate((event) => {
      if (!isMobile) return
      // Only allow swiping left (closing)
      const newTranslateX = Math.min(0, Math.max(-windowWidth, event.translationX))
      translateX.value = newTranslateX
      backdropOpacity.value = interpolate(
        newTranslateX,
        [-windowWidth, 0],
        [0, 1],
        Extrapolation.CLAMP
      )
    })
    .onEnd((event) => {
      isGesturing.value = false
      if (!isMobile) return
      const shouldClose = event.translationX < -windowWidth / 3 || event.velocityX < -500
      if (shouldClose) {
        animateToClose()
        runOnJS(handleClose)()
      } else {
        animateToOpen()
      }
    })
    .onFinalize(() => {
      isGesturing.value = false
    })

  const sidebarAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }))

  const backdropAnimatedStyle = useAnimatedStyle(() => ({
    opacity: backdropOpacity.value,
    pointerEvents: backdropOpacity.value > 0.01 ? 'auto' : 'none',
  }))

  // Render mobile sidebar
  // On web, keep the overlay interactive only while the sidebar is open.
  // This preserves swipe/scroll behavior without blocking taps when closed.
  const overlayPointerEvents = Platform.OS === 'web' ? (isOpen ? 'auto' : 'none') : 'box-none'
  if (isMobile) {
    return (
      <View style={StyleSheet.absoluteFillObject} pointerEvents={overlayPointerEvents}>
        {/* Backdrop */}
        <Animated.View style={[styles.backdrop, backdropAnimatedStyle]}>
          <Pressable style={styles.backdropPressable} onPress={handleClose} />
        </Animated.View>

        <GestureDetector gesture={closeGesture} touchAction="pan-y">
          <Animated.View
            style={[
              styles.mobileSidebar,
              { width: windowWidth, paddingTop: insets.top, paddingBottom: insets.bottom },
              sidebarAnimatedStyle,
            ]}
            pointerEvents="auto"
          >
            <View style={styles.sidebarContent} pointerEvents="auto">
              {/* Header */}
              <View style={styles.sidebarHeader}>
                <View style={styles.sidebarHeaderRow}>
                  <Pressable
                    style={styles.newAgentButton}
                    testID="sidebar-new-agent"
                    onPress={handleCreateAgentCleanMobile}
                  >
                    {({ hovered }) => (
                      <>
                        <Plus
                          size={theme.iconSize.md}
                          color={hovered ? theme.colors.foreground : theme.colors.foregroundMuted}
                        />
                        <Text
                          style={[
                            styles.newAgentButtonText,
                            hovered && styles.newAgentButtonTextHovered,
                          ]}
                        >
                          New agent
                        </Text>
                      </>
                    )}
                  </Pressable>
                </View>
              </View>

              {/* Middle: scrollable project/workspace tree */}
              {isInitialLoad ? (
                <SidebarAgentListSkeleton />
              ) : (
                <SidebarAgentList
                  isOpen={isOpen}
                  serverId={activeServerId}
                  projects={projects}
                  isRefreshing={isManualRefresh && isRevalidating}
                  onRefresh={handleRefresh}
                  onWorkspacePress={closeToAgent}
                  parentGestureRef={closeGestureRef}
                />
              )}

              {/* Footer */}
              <View style={styles.sidebarFooter}>
                <View style={styles.footerHostSlot}>
                  <Pressable
                    ref={hostTriggerRef}
                    style={({ hovered = false }) => [
                      styles.hostTrigger,
                      hovered && styles.hostTriggerHovered,
                    ]}
                    onPress={() => setIsHostPickerOpen(true)}
                    disabled={hostOptions.length === 0}
                  >
                    <View
                      style={[styles.hostStatusDot, { backgroundColor: activeHostStatusColor }]}
                    />
                    <Text style={styles.hostTriggerText} numberOfLines={1}>
                      {activeHostLabel}
                    </Text>
                  </Pressable>
                </View>
                <View style={styles.footerIconRow}>
                  <Pressable
                    style={styles.footerIconButton}
                    testID="sidebar-all-agents"
                    nativeID="sidebar-all-agents"
                    collapsable={false}
                    accessible
                    accessibilityLabel="All agents"
                    accessibilityRole="button"
                    onPress={handleViewMore}
                  >
                    {({ hovered }) => (
                      <Users
                        size={theme.iconSize.lg}
                        color={hovered ? theme.colors.foreground : theme.colors.foregroundMuted}
                      />
                    )}
                  </Pressable>
                  <Pressable
                    style={styles.footerIconButton}
                    testID="sidebar-settings"
                    nativeID="sidebar-settings"
                    collapsable={false}
                    accessible
                    accessibilityLabel="Settings"
                    accessibilityRole="button"
                    onPress={handleSettingsMobile}
                  >
                    {({ hovered }) => (
                      <Settings
                        size={theme.iconSize.lg}
                        color={hovered ? theme.colors.foreground : theme.colors.foregroundMuted}
                      />
                    )}
                  </Pressable>
                </View>
                <Combobox
                  options={hostOptions}
                  value={activeServerId ?? ''}
                  onSelect={handleHostSelect}
                  searchable={false}
                  title="Switch host"
                  searchPlaceholder="Search hosts..."
                  open={isHostPickerOpen}
                  onOpenChange={setIsHostPickerOpen}
                  anchorRef={hostTriggerRef}
                />
              </View>
            </View>
          </Animated.View>
        </GestureDetector>
      </View>
    )
  }

  // Desktop: no edge swipe, just show/hide based on isOpen
  if (!isOpen) {
    return null
  }

  return (
    <View style={[styles.desktopSidebar, { width: DESKTOP_SIDEBAR_WIDTH }]}>
      {trafficLightPadding.top > 0 ? (
        <View style={{ height: trafficLightPadding.top }} {...dragHandlers} />
      ) : null}
      <View style={styles.sidebarHeader} {...dragHandlers}>
        <View style={styles.sidebarHeaderRow}>
          <Pressable
            style={styles.newAgentButton}
            testID="sidebar-new-agent"
            onPress={handleCreateAgentCleanDesktop}
          >
            {({ hovered }) => (
              <>
                <Plus
                  size={theme.iconSize.md}
                  color={hovered ? theme.colors.foreground : theme.colors.foregroundMuted}
                />
                <Text
                  style={[styles.newAgentButtonText, hovered && styles.newAgentButtonTextHovered]}
                >
                  New agent
                </Text>
              </>
            )}
          </Pressable>
        </View>
      </View>

      {/* Middle: scrollable project/workspace tree */}
      {isInitialLoad ? (
        <SidebarAgentListSkeleton />
      ) : (
        <SidebarAgentList
          isOpen={isOpen}
          serverId={activeServerId}
          projects={projects}
          isRefreshing={isManualRefresh && isRevalidating}
          onRefresh={handleRefresh}
        />
      )}

      {/* Footer */}
      <View style={styles.sidebarFooter}>
        <View style={styles.footerHostSlot}>
          <Pressable
            ref={hostTriggerRef}
            style={({ hovered = false }) => [
              styles.hostTrigger,
              hovered && styles.hostTriggerHovered,
            ]}
            onPress={() => setIsHostPickerOpen(true)}
            disabled={hostOptions.length === 0}
          >
            <View style={[styles.hostStatusDot, { backgroundColor: activeHostStatusColor }]} />
            <Text style={styles.hostTriggerText} numberOfLines={1}>
              {activeHostLabel}
            </Text>
          </Pressable>
        </View>
        <View style={styles.footerIconRow}>
          <Pressable
            style={styles.footerIconButton}
            testID="sidebar-all-agents"
            nativeID="sidebar-all-agents"
            collapsable={false}
            accessible
            accessibilityLabel="All agents"
            accessibilityRole="button"
            onPress={handleViewMore}
          >
            {({ hovered }) => (
              <Users
                size={theme.iconSize.lg}
                color={hovered ? theme.colors.foreground : theme.colors.foregroundMuted}
              />
            )}
          </Pressable>
          <Pressable
            style={styles.footerIconButton}
            testID="sidebar-settings"
            nativeID="sidebar-settings"
            collapsable={false}
            accessible
            accessibilityLabel="Settings"
            accessibilityRole="button"
            onPress={handleSettingsDesktop}
          >
            {({ hovered }) => (
              <Settings
                size={theme.iconSize.lg}
                color={hovered ? theme.colors.foreground : theme.colors.foregroundMuted}
              />
            )}
          </Pressable>
        </View>
        <Combobox
          options={hostOptions}
          value={activeServerId ?? ''}
          onSelect={handleHostSelect}
          searchable={false}
          title="Switch host"
          searchPlaceholder="Search hosts..."
          open={isHostPickerOpen}
          onOpenChange={setIsHostPickerOpen}
          anchorRef={hostTriggerRef}
        />
      </View>
    </View>
  )
}

const styles = StyleSheet.create((theme) => ({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  backdropPressable: {
    flex: 1,
  },
  mobileSidebar: {
    position: 'absolute',
    top: 0,
    left: 0,
    bottom: 0,
    backgroundColor: theme.colors.surface0,
    overflow: 'hidden',
  },
  sidebarContent: {
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
  },
  desktopSidebar: {
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  sidebarHeader: {
    height: {
      xs: HEADER_INNER_HEIGHT_MOBILE,
      md: HEADER_INNER_HEIGHT,
    },
    paddingHorizontal: theme.spacing[2],
    justifyContent: 'center',
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    userSelect: 'none',
  },
  sidebarHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing[2],
  },
  newAgentButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
    flexShrink: 0,
  },
  newAgentButtonHovered: {},
  newAgentButtonText: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  newAgentButtonTextHovered: {
    color: theme.colors.foreground,
  },
  hostTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: theme.spacing[2],
    minWidth: 0,
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  hostTriggerHovered: {
    borderColor: theme.colors.borderAccent,
  },
  hostStatusDot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
  },
  hostTriggerText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
    minWidth: 0,
  },
  sidebarFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  footerHostSlot: {
    flexGrow: 0,
    flexShrink: 1,
    minWidth: 0,
    marginRight: theme.spacing[2],
  },
  footerIconRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[2],
    flexShrink: 0,
  },
  footerIconButton: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
  },
  hostPickerList: {
    gap: theme.spacing[2],
  },
  hostPickerOption: {
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  hostPickerOptionText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  hostPickerCancel: {
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface0,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    alignItems: 'center',
  },
  hostPickerCancelText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}))
