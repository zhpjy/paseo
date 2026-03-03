import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
} from '@/hooks/use-sidebar-agents-list'

export interface SidebarShortcutWorkspaceTarget {
  serverId: string
  workspaceId: string
}

export type SidebarWorkspaceTreeRow =
  | {
      kind: 'project'
      rowKey: string
      project: SidebarProjectEntry
      displayName: string
    }
  | {
      kind: 'workspace'
      rowKey: string
      projectKey: string
      workspace: SidebarWorkspaceEntry
      shortcutNumber: number | null
    }

export interface SidebarWorkspaceViewModel {
  rows: SidebarWorkspaceTreeRow[]
  shortcutTargets: SidebarShortcutWorkspaceTarget[]
  shortcutIndexByWorkspaceKey: Map<string, number>
}

export function buildSidebarWorkspaceViewModel(input: {
  projects: SidebarProjectEntry[]
  collapsedProjectKeys: ReadonlySet<string>
  getProjectDisplayName: (project: SidebarProjectEntry) => string
  shortcutLimit?: number
}): SidebarWorkspaceViewModel {
  const maxShortcuts = Math.max(0, Math.floor(input.shortcutLimit ?? 9))
  const rows: SidebarWorkspaceTreeRow[] = []
  const shortcutTargets: SidebarShortcutWorkspaceTarget[] = []
  const shortcutIndexByWorkspaceKey = new Map<string, number>()

  for (const project of input.projects) {
    rows.push({
      kind: 'project',
      rowKey: `project:${project.projectKey}`,
      project,
      displayName: input.getProjectDisplayName(project),
    })

    if (input.collapsedProjectKeys.has(project.projectKey)) {
      continue
    }

    for (const workspace of project.workspaces) {
      const shortcutNumber =
        shortcutTargets.length < maxShortcuts ? shortcutTargets.length + 1 : null
      if (shortcutNumber !== null) {
        shortcutTargets.push({
          serverId: workspace.serverId,
          workspaceId: workspace.cwd,
        })
        shortcutIndexByWorkspaceKey.set(workspace.workspaceKey, shortcutNumber)
      }

      rows.push({
        kind: 'workspace',
        rowKey: `workspace:${project.projectKey}:${workspace.workspaceKey}`,
        projectKey: project.projectKey,
        workspace,
        shortcutNumber,
      })
    }
  }

  return { rows, shortcutTargets, shortcutIndexByWorkspaceKey }
}
