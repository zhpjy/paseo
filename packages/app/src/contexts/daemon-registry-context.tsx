import { createContext, useCallback, useContext, useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { decodeOfferFragmentPayload, normalizeHostPort } from '@/utils/daemon-endpoints'
import { probeConnection } from '@/utils/test-daemon-connection'
import { ConnectionOfferSchema, type ConnectionOffer } from '@server/shared/connection-offer'
import {
  shouldUseManagedDesktopDaemon,
  startManagedDaemon,
} from '@/desktop/managed-runtime/managed-runtime'

const REGISTRY_STORAGE_KEY = '@paseo:daemon-registry'
const DAEMON_REGISTRY_QUERY_KEY = ['daemon-registry']
const DEFAULT_LOCALHOST_ENDPOINT = 'localhost:6767'
const DEFAULT_LOCALHOST_BOOTSTRAP_KEY = '@paseo:default-localhost-bootstrap-v1'
const DEFAULT_LOCALHOST_BOOTSTRAP_TIMEOUT_MS = 2500
const E2E_STORAGE_KEY = '@paseo:e2e'

export type DirectTcpHostConnection = {
  id: string
  type: 'directTcp'
  endpoint: string
}

export type DirectSocketHostConnection = {
  id: string
  type: 'directSocket'
  path: string
}

export type DirectPipeHostConnection = {
  id: string
  type: 'directPipe'
  path: string
}

export type RelayHostConnection = {
  id: string
  type: 'relay'
  relayEndpoint: string
  daemonPublicKeyB64: string
}

export type HostConnection =
  | DirectTcpHostConnection
  | DirectSocketHostConnection
  | DirectPipeHostConnection
  | RelayHostConnection

export type HostLifecycle = Record<string, never>

export type HostProfile = {
  serverId: string
  label: string
  lifecycle: HostLifecycle
  connections: HostConnection[]
  preferredConnectionId: string | null
  createdAt: string
  updatedAt: string
}

export type UpdateHostInput = Partial<Omit<HostProfile, 'serverId' | 'createdAt'>>

interface DaemonRegistryContextValue {
  daemons: HostProfile[]
  isLoading: boolean
  error: unknown | null
  upsertDirectConnection: (input: {
    serverId: string
    endpoint: string
    label?: string
  }) => Promise<HostProfile>
  upsertRelayConnection: (input: {
    serverId: string
    relayEndpoint: string
    daemonPublicKeyB64: string
    label?: string
  }) => Promise<HostProfile>
  updateHost: (serverId: string, updates: UpdateHostInput) => Promise<void>
  removeHost: (serverId: string) => Promise<void>
  removeConnection: (serverId: string, connectionId: string) => Promise<void>
  upsertDaemonFromOffer: (offer: ConnectionOffer) => Promise<HostProfile>
  upsertDaemonFromOfferUrl: (offerUrlOrFragment: string) => Promise<HostProfile>
}

const DaemonRegistryContext = createContext<DaemonRegistryContextValue | null>(null)

function defaultLifecycle(): HostLifecycle {
  return {}
}

function normalizeHostLabel(value: string | null | undefined, serverId: string): string {
  const trimmed = value?.trim() ?? ''
  return trimmed.length > 0 ? trimmed : serverId
}

function normalizeEndpointOrNull(endpoint: string): string | null {
  try {
    return normalizeHostPort(endpoint)
  } catch {
    return null
  }
}

export function connectionFromListen(listen: string): HostConnection | null {
  const normalizedListen = listen.trim()
  if (!normalizedListen) {
    return null
  }

  if (normalizedListen.startsWith('pipe://')) {
    const path = normalizedListen.slice('pipe://'.length).trim()
    return path ? { id: `pipe:${path}`, type: 'directPipe', path } : null
  }

  if (normalizedListen.startsWith('unix://')) {
    const path = normalizedListen.slice('unix://'.length).trim()
    return path ? { id: `socket:${path}`, type: 'directSocket', path } : null
  }

  if (normalizedListen.startsWith('\\\\.\\pipe\\')) {
    return {
      id: `pipe:${normalizedListen}`,
      type: 'directPipe',
      path: normalizedListen,
    }
  }

  if (normalizedListen.startsWith('/')) {
    return {
      id: `socket:${normalizedListen}`,
      type: 'directSocket',
      path: normalizedListen,
    }
  }

  try {
    const endpoint = normalizeHostPort(normalizedListen)
    return {
      id: `direct:${endpoint}`,
      type: 'directTcp',
      endpoint,
    }
  } catch {
    return null
  }
}

function normalizeStoredConnection(connection: unknown): HostConnection | null {
  if (!connection || typeof connection !== 'object') {
    return null
  }
  const record = connection as Record<string, unknown>
  const type = typeof record.type === 'string' ? record.type : null
  if (type === 'directTcp') {
    try {
      const endpoint = normalizeHostPort(String(record.endpoint ?? ''))
      return { id: `direct:${endpoint}`, type: 'directTcp', endpoint }
    } catch {
      return null
    }
  }
  if (type === 'directSocket') {
    const path = String(record.path ?? '').trim()
    return path ? { id: `socket:${path}`, type: 'directSocket', path } : null
  }
  if (type === 'directPipe') {
    const path = String(record.path ?? '').trim()
    return path ? { id: `pipe:${path}`, type: 'directPipe', path } : null
  }
  if (type === 'relay') {
    try {
      const relayEndpoint = normalizeHostPort(String(record.relayEndpoint ?? ''))
      const daemonPublicKeyB64 = String(record.daemonPublicKeyB64 ?? '').trim()
      if (!daemonPublicKeyB64) return null
      return {
        id: `relay:${relayEndpoint}`,
        type: 'relay',
        relayEndpoint,
        daemonPublicKeyB64,
      }
    } catch {
      return null
    }
  }

  return null
}

function normalizeStoredLifecycle(_lifecycle: unknown): HostLifecycle {
  return defaultLifecycle()
}

function normalizeStoredHostProfile(entry: unknown): HostProfile | null {
  if (!entry || typeof entry !== 'object') {
    return null
  }
  const record = entry as Record<string, unknown>
  const serverId = typeof record.serverId === 'string' ? record.serverId.trim() : ''
  if (!serverId) {
    return null
  }

  const rawConnections = Array.isArray(record.connections) ? record.connections : []
  const connections = rawConnections
    .map((connection) => normalizeStoredConnection(connection))
    .filter((connection): connection is HostConnection => connection !== null)
  if (connections.length === 0) {
    return null
  }

  const lifecycle = normalizeStoredLifecycle(record.lifecycle)
  const now = new Date().toISOString()
  const label = normalizeHostLabel(
    typeof record.label === 'string' ? record.label : null,
    serverId
  )
  const preferredConnectionId =
    typeof record.preferredConnectionId === 'string' &&
    connections.some((connection) => connection.id === record.preferredConnectionId)
      ? record.preferredConnectionId
      : connections[0]?.id ?? null

  return {
    serverId,
    label,
    lifecycle,
    connections,
    preferredConnectionId,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : now,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : now,
  }
}

function hostConnectionEquals(left: HostConnection, right: HostConnection): boolean {
  if (left.type !== right.type || left.id !== right.id) {
    return false
  }

  if (left.type === 'directTcp' && right.type === 'directTcp') {
    return left.endpoint === right.endpoint
  }
  if (left.type === 'directSocket' && right.type === 'directSocket') {
    return left.path === right.path
  }
  if (left.type === 'directPipe' && right.type === 'directPipe') {
    return left.path === right.path
  }
  if (left.type === 'relay' && right.type === 'relay') {
    return (
      left.relayEndpoint === right.relayEndpoint &&
      left.daemonPublicKeyB64 === right.daemonPublicKeyB64
    )
  }

  return false
}

function hostLifecycleEquals(left: HostLifecycle, right: HostLifecycle): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function upsertHostConnectionInProfiles(input: {
  profiles: HostProfile[]
  serverId: string
  label?: string
  connection: HostConnection
  now?: string
}): HostProfile[] {
  const serverId = input.serverId.trim()
  if (!serverId) {
    throw new Error('serverId is required')
  }

  const now = input.now ?? new Date().toISOString()
  const labelTrimmed = input.label?.trim() ?? ''
  const derivedLabel = labelTrimmed || serverId
  const existing = input.profiles
  const idx = existing.findIndex((daemon) => daemon.serverId === serverId)

  if (idx === -1) {
    const profile: HostProfile = {
      serverId,
      label: derivedLabel,
      lifecycle: defaultLifecycle(),
      connections: [input.connection],
      preferredConnectionId: input.connection.id,
      createdAt: now,
      updatedAt: now,
    }
    return [...existing, profile]
  }

  const prev = existing[idx]!
  const connectionIdx = prev.connections.findIndex((connection) => connection.id === input.connection.id)
  const hadConnection = connectionIdx !== -1
  const connectionChanged =
    connectionIdx === -1
      ? true
      : !hostConnectionEquals(prev.connections[connectionIdx]!, input.connection)
  const nextConnections =
    connectionIdx === -1
      ? [...prev.connections, input.connection]
      : connectionChanged
        ? prev.connections.map((connection, index) =>
            index === connectionIdx ? input.connection : connection
          )
        : prev.connections

  const nextLifecycle = prev.lifecycle
  const nextLabel = labelTrimmed ? labelTrimmed : prev.label
  const nextPreferredConnectionId = prev.preferredConnectionId ?? input.connection.id
  const changed =
    nextLabel !== prev.label ||
    nextPreferredConnectionId !== prev.preferredConnectionId ||
    !hostLifecycleEquals(prev.lifecycle, nextLifecycle) ||
    !hadConnection ||
    connectionChanged

  if (!changed) {
    return existing
  }

  const nextProfile: HostProfile = {
    ...prev,
    label: nextLabel,
    lifecycle: nextLifecycle,
    connections: nextConnections,
    preferredConnectionId: nextPreferredConnectionId,
    updatedAt: now,
  }

  const next = [...existing]
  next[idx] = nextProfile
  return next
}

export function hostHasDirectEndpoint(host: HostProfile, endpoint: string): boolean {
  const normalized = normalizeEndpointOrNull(endpoint)
  if (!normalized) {
    return false
  }
  return host.connections.some(
    (connection) => connection.type === 'directTcp' && connection.endpoint === normalized
  )
}

export function registryHasDirectEndpoint(hosts: HostProfile[], endpoint: string): boolean {
  return hosts.some((host) => hostHasDirectEndpoint(host, endpoint))
}

export function useDaemonRegistry(): DaemonRegistryContextValue {
  const ctx = useContext(DaemonRegistryContext)
  if (!ctx) {
    throw new Error('useDaemonRegistry must be used within DaemonRegistryProvider')
  }
  return ctx
}

export function DaemonRegistryProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const desktopStartupAttemptedRef = useRef(false)
  const localhostBootstrapAttemptedRef = useRef(false)
  const {
    data: daemons = [],
    isPending,
    error,
  } = useQuery({
    queryKey: DAEMON_REGISTRY_QUERY_KEY,
    queryFn: loadDaemonRegistryFromStorage,
    staleTime: Infinity,
    gcTime: Infinity,
  })

  const persist = useCallback(
    async (profiles: HostProfile[]) => {
      queryClient.setQueryData<HostProfile[]>(DAEMON_REGISTRY_QUERY_KEY, profiles)
      await AsyncStorage.setItem(REGISTRY_STORAGE_KEY, JSON.stringify(profiles))
    },
    [queryClient]
  )

  const readDaemons = useCallback(() => {
    return queryClient.getQueryData<HostProfile[]>(DAEMON_REGISTRY_QUERY_KEY) ?? daemons
  }, [queryClient, daemons])

  const updateHost = useCallback(
    async (serverId: string, updates: UpdateHostInput) => {
      const next = readDaemons().map((daemon) =>
        daemon.serverId === serverId
          ? {
              ...daemon,
              ...updates,
              updatedAt: new Date().toISOString(),
            }
          : daemon
      )
      await persist(next)
    },
    [persist, readDaemons]
  )

  const removeHost = useCallback(
    async (serverId: string) => {
      const existing = readDaemons()
      const remaining = existing.filter((daemon) => daemon.serverId !== serverId)
      await persist(remaining)
    },
    [persist, readDaemons]
  )

  const removeConnection = useCallback(
    async (serverId: string, connectionId: string) => {
      const existing = readDaemons()
      const now = new Date().toISOString()
      const next = existing
        .map((daemon) => {
          if (daemon.serverId !== serverId) return daemon
          const remaining = daemon.connections.filter((conn) => conn.id !== connectionId)
          if (remaining.length === 0) {
            return null
          }
          const preferred =
            daemon.preferredConnectionId === connectionId
              ? (remaining[0]?.id ?? null)
              : daemon.preferredConnectionId
          return {
            ...daemon,
            connections: remaining,
            preferredConnectionId: preferred,
            updatedAt: now,
          } satisfies HostProfile
        })
        .filter((entry): entry is HostProfile => entry !== null)
      await persist(next)
    },
    [persist, readDaemons]
  )

  const upsertHostConnection = useCallback(
    async (input: {
      serverId: string
      label?: string
      connection: HostConnection
    }) => {
      const now = new Date().toISOString()
      const next = upsertHostConnectionInProfiles({
        profiles: readDaemons(),
        serverId: input.serverId,
        label: input.label,
        connection: input.connection,
        now,
      })
      await persist(next)
      return next.find((daemon) => daemon.serverId === input.serverId) as HostProfile
    },
    [persist, readDaemons]
  )

  const upsertDirectConnection = useCallback(
    async (input: { serverId: string; endpoint: string; label?: string }) => {
      const endpoint = normalizeHostPort(input.endpoint)
      return upsertHostConnection({
        serverId: input.serverId,
        label: input.label,
        connection: {
          id: `direct:${endpoint}`,
          type: 'directTcp',
          endpoint,
        },
      })
    },
    [upsertHostConnection]
  )

  useEffect(() => {
    if (isPending) return
    if (!shouldUseManagedDesktopDaemon()) return
    if (desktopStartupAttemptedRef.current) return
    desktopStartupAttemptedRef.current = true

    let cancelled = false

    const bootstrapDesktopStartup = async () => {
      const t0 = performance.now()
      const elapsed = () => Math.round(performance.now() - t0)
      try {
        const isE2E = await AsyncStorage.getItem(E2E_STORAGE_KEY)
        if (cancelled || isE2E) {
          return
        }

        console.info('[DaemonRegistry] desktop bootstrap: starting', { elapsedMs: elapsed() })
        await Promise.allSettled([
          (async () => {
            console.info('[DaemonRegistry] desktop bootstrap: startManagedDaemon', { elapsedMs: elapsed() })
            const daemon = await startManagedDaemon()
            console.info('[DaemonRegistry] desktop bootstrap: managed daemon ready', { elapsedMs: elapsed(), serverId: daemon.serverId })
            if (cancelled || !daemon.serverId) {
              return
            }

            const connection = connectionFromListen(daemon.listen)
            if (!connection) {
              return
            }

            await upsertHostConnection({
              serverId: daemon.serverId,
              label: daemon.hostname ?? undefined,
              connection,
            })
            console.info('[DaemonRegistry] desktop bootstrap: host connection upserted', { elapsedMs: elapsed() })
          })().catch((managedBootstrapError) => {
            if (!cancelled) {
              console.warn(
                '[DaemonRegistry] Failed to bootstrap desktop daemon connection',
                { elapsedMs: elapsed() },
                managedBootstrapError
              )
            }
          }),
          (async () => {
            console.info('[DaemonRegistry] desktop bootstrap: probing localhost', { elapsedMs: elapsed() })
            const { serverId, hostname } = await probeConnection(
              {
                id: `bootstrap:${DEFAULT_LOCALHOST_ENDPOINT}`,
                type: 'directTcp',
                endpoint: DEFAULT_LOCALHOST_ENDPOINT,
              },
              { timeoutMs: DEFAULT_LOCALHOST_BOOTSTRAP_TIMEOUT_MS }
            )
            console.info('[DaemonRegistry] desktop bootstrap: localhost probe succeeded', { elapsedMs: elapsed(), serverId })
            if (cancelled) {
              return
            }

            await upsertDirectConnection({
              serverId,
              endpoint: DEFAULT_LOCALHOST_ENDPOINT,
              label: hostname ?? undefined,
            })
            console.info('[DaemonRegistry] desktop bootstrap: direct connection upserted', { elapsedMs: elapsed() })
          })().catch(() => {
            console.info('[DaemonRegistry] desktop bootstrap: localhost probe failed', { elapsedMs: elapsed() })
          }),
        ])
      } catch (bootstrapError) {
        if (cancelled) return
        console.warn(
          '[DaemonRegistry] Failed to bootstrap desktop startup host connections',
          bootstrapError
        )
      }
    }

    void bootstrapDesktopStartup()

    return () => {
      cancelled = true
    }
  }, [isPending, upsertDirectConnection, upsertHostConnection])

  useEffect(() => {
    if (isPending) return
    if (shouldUseManagedDesktopDaemon()) return
    if (localhostBootstrapAttemptedRef.current) return
    localhostBootstrapAttemptedRef.current = true

    let cancelled = false

    const bootstrapLocalhost = async () => {
      try {
        const isE2E = await AsyncStorage.getItem(E2E_STORAGE_KEY)
        if (cancelled || isE2E) {
          return
        }

        const alreadyHandled = await AsyncStorage.getItem(DEFAULT_LOCALHOST_BOOTSTRAP_KEY)
        if (cancelled || alreadyHandled) {
          return
        }

        const existing = readDaemons()
        if (registryHasDirectEndpoint(existing, DEFAULT_LOCALHOST_ENDPOINT)) {
          await AsyncStorage.setItem(DEFAULT_LOCALHOST_BOOTSTRAP_KEY, '1')
          return
        }

        try {
          const { serverId, hostname } = await probeConnection(
            {
              id: `bootstrap:${DEFAULT_LOCALHOST_ENDPOINT}`,
              type: 'directTcp',
              endpoint: DEFAULT_LOCALHOST_ENDPOINT,
            },
            { timeoutMs: DEFAULT_LOCALHOST_BOOTSTRAP_TIMEOUT_MS }
          )
          if (cancelled) return

          await upsertDirectConnection({
            serverId,
            endpoint: DEFAULT_LOCALHOST_ENDPOINT,
            label: hostname ?? undefined,
          })
          await AsyncStorage.setItem(DEFAULT_LOCALHOST_BOOTSTRAP_KEY, '1')
        } catch {
          // Best-effort bootstrap only; keep startup resilient if localhost isn't reachable.
        }
      } catch (bootstrapError) {
        if (cancelled) return
        console.warn('[DaemonRegistry] Failed to bootstrap host connections', bootstrapError)
      }
    }

    void bootstrapLocalhost()

    return () => {
      cancelled = true
    }
  }, [isPending, readDaemons, upsertDirectConnection])

  const upsertRelayConnection = useCallback(
    async (input: {
      serverId: string
      relayEndpoint: string
      daemonPublicKeyB64: string
      label?: string
    }) => {
      const relayEndpoint = normalizeHostPort(input.relayEndpoint)
      const daemonPublicKeyB64 = input.daemonPublicKeyB64.trim()
      if (!daemonPublicKeyB64) {
        throw new Error('daemonPublicKeyB64 is required')
      }
      return upsertHostConnection({
        serverId: input.serverId,
        label: input.label,
        connection: {
          id: `relay:${relayEndpoint}`,
          type: 'relay',
          relayEndpoint,
          daemonPublicKeyB64,
        },
      })
    },
    [upsertHostConnection]
  )

  const upsertDaemonFromOffer = useCallback(
    async (offer: ConnectionOffer) => {
      return upsertRelayConnection({
        serverId: offer.serverId,
        relayEndpoint: offer.relay.endpoint,
        daemonPublicKeyB64: offer.daemonPublicKeyB64,
      })
    },
    [upsertRelayConnection]
  )

  const upsertDaemonFromOfferUrl = useCallback(
    async (offerUrlOrFragment: string) => {
      const marker = '#offer='
      const idx = offerUrlOrFragment.indexOf(marker)
      if (idx === -1) {
        throw new Error('Missing #offer= fragment')
      }
      const encoded = offerUrlOrFragment.slice(idx + marker.length).trim()
      if (!encoded) {
        throw new Error('Offer payload is empty')
      }
      const payload = decodeOfferFragmentPayload(encoded)
      const offer = ConnectionOfferSchema.parse(payload)
      return upsertDaemonFromOffer(offer)
    },
    [upsertDaemonFromOffer]
  )

  const value: DaemonRegistryContextValue = {
    daemons,
    isLoading: isPending,
    error: error ?? null,
    upsertDirectConnection,
    upsertRelayConnection,
    updateHost,
    removeHost,
    removeConnection,
    upsertDaemonFromOffer,
    upsertDaemonFromOfferUrl,
  }

  return <DaemonRegistryContext.Provider value={value}>{children}</DaemonRegistryContext.Provider>
}

async function loadDaemonRegistryFromStorage(): Promise<HostProfile[]> {
  try {
    const stored = await AsyncStorage.getItem(REGISTRY_STORAGE_KEY)
    if (!stored) {
      return []
    }

    const parsed = JSON.parse(stored) as unknown
    if (!Array.isArray(parsed)) {
      return []
    }

    return parsed
      .map((entry) => normalizeStoredHostProfile(entry))
      .filter((entry): entry is HostProfile => entry !== null)
  } catch (error) {
    console.error('[DaemonRegistry] Failed to load daemon registry', error)
    throw error
  }
}
