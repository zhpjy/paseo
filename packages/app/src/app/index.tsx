import { useEffect, useRef, useSyncExternalStore, useState } from 'react'
import { usePathname, useRouter } from 'expo-router'
import { useDaemonRegistry } from '@/contexts/daemon-registry-context'
import { shouldUseManagedDesktopDaemon } from '@/desktop/managed-runtime/managed-runtime'
import { buildHostRootRoute } from '@/utils/host-routes'
import { StartupSplashScreen } from '@/screens/startup-splash-screen'
import { WelcomeScreen } from '@/components/welcome-screen'
import { getHostRuntimeStore, isHostRuntimeConnected } from '@/runtime/host-runtime'
import {
  shouldRedirectToWelcome,
  shouldWaitOnStartupRace,
  WELCOME_ROUTE,
} from './index-startup'

const STARTUP_TIMEOUT_MS = 30_000
const APP_START_TIME = performance.now()

function useAnyHostOnline(serverIds: string[]): string | null {
  const runtime = getHostRuntimeStore()
  return useSyncExternalStore(
    (onStoreChange) => runtime.subscribeAll(onStoreChange),
    () => {
      let firstOnlineServerId: string | null = null
      let firstOnlineAt: string | null = null
      for (const serverId of serverIds) {
        const snapshot = runtime.getSnapshot(serverId)
        const lastOnlineAt = snapshot?.lastOnlineAt ?? null
        if (!isHostRuntimeConnected(snapshot) || !lastOnlineAt) {
          continue
        }
        if (!firstOnlineAt || lastOnlineAt < firstOnlineAt) {
          firstOnlineAt = lastOnlineAt
          firstOnlineServerId = serverId
        }
      }
      return firstOnlineServerId
    },
    () => {
      let firstOnlineServerId: string | null = null
      let firstOnlineAt: string | null = null
      for (const serverId of serverIds) {
        const snapshot = runtime.getSnapshot(serverId)
        const lastOnlineAt = snapshot?.lastOnlineAt ?? null
        if (!isHostRuntimeConnected(snapshot) || !lastOnlineAt) {
          continue
        }
        if (!firstOnlineAt || lastOnlineAt < firstOnlineAt) {
          firstOnlineAt = lastOnlineAt
          firstOnlineServerId = serverId
        }
      }
      return firstOnlineServerId
    }
  )
}

export default function Index() {
  const router = useRouter()
  const pathname = usePathname()
  const { daemons, isLoading: registryLoading } = useDaemonRegistry()
  const [hasTimedOut, setHasTimedOut] = useState(false)
  const isDesktopStartupRace = shouldUseManagedDesktopDaemon()
  const onlineServerId = useAnyHostOnline(daemons.map((daemon) => daemon.serverId))
  const startupLogged = useRef(false)

  useEffect(() => {
    if (onlineServerId && !startupLogged.current) {
      startupLogged.current = true
      console.info('[Startup] host online', {
        serverId: onlineServerId,
        elapsedMs: Math.round(performance.now() - APP_START_TIME),
      })
    }
  }, [onlineServerId])

  useEffect(() => {
    const timer = setTimeout(() => {
      setHasTimedOut(true)
    }, STARTUP_TIMEOUT_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    if (registryLoading) {
      return
    }
    if (!onlineServerId) {
      return
    }
    if (pathname !== '/' && pathname !== '') {
      return
    }
    console.info('[Startup] navigating to host route', {
      serverId: onlineServerId,
      elapsedMs: Math.round(performance.now() - APP_START_TIME),
    })
    router.replace(buildHostRootRoute(onlineServerId) as any)
  }, [onlineServerId, pathname, registryLoading, router])

  useEffect(() => {
    if (
      !shouldRedirectToWelcome({
        registryLoading,
        onlineServerId,
        hasTimedOut,
        pathname,
        isDesktopStartupRace,
        daemonCount: daemons.length,
      })
    ) {
      return
    }
    router.replace(WELCOME_ROUTE as any)
  }, [daemons.length, hasTimedOut, isDesktopStartupRace, onlineServerId, pathname, registryLoading, router])

  if (
    shouldWaitOnStartupRace({
      registryLoading,
      onlineServerId,
      hasTimedOut,
      isDesktopStartupRace,
      daemonCount: daemons.length,
      pathname,
    })
  ) {
    return <StartupSplashScreen />
  }

  if (!onlineServerId) {
    return <WelcomeScreen />
  }

  return null
}
