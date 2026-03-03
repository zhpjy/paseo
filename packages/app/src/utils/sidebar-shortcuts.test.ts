import { describe, expect, it } from "vitest";
import type { SidebarProjectEntry, SidebarWorkspaceEntry } from "@/hooks/use-sidebar-agents-list";

import { buildSidebarWorkspaceViewModel } from "./sidebar-shortcuts";

function workspace(serverId: string, cwd: string): SidebarWorkspaceEntry {
  return {
    workspaceKey: `${serverId}:${cwd}`,
    serverId,
    cwd,
    branchName: null,
    createdAt: null,
    isMainCheckout: false,
    isPaseoOwnedWorktree: false,
    statusBucket: "done",
  };
}

function project(projectKey: string, workspaces: SidebarWorkspaceEntry[]): SidebarProjectEntry {
  return {
    projectKey,
    projectName: projectKey,
    iconWorkingDir: workspaces[0]?.cwd ?? "",
    statusBucket: "done",
    activeCount: 0,
    totalCount: workspaces.length,
    latestCreatedAt: null,
    workspaces,
  };
}

describe("buildSidebarWorkspaceViewModel", () => {
  it("builds visible rows and shortcut targets in visual order", () => {
    const projects = [
      project("p1", [workspace("s1", "/repo/main"), workspace("s1", "/repo/feat-a")]),
      project("p2", [workspace("s1", "/repo2/main")]),
    ];

    const model = buildSidebarWorkspaceViewModel({
      projects,
      collapsedProjectKeys: new Set<string>(["p2"]),
      getProjectDisplayName: (entry) => entry.projectName,
    });

    expect(model.rows.map((row) => row.kind)).toEqual(["project", "workspace", "workspace", "project"]);
    expect(model.shortcutTargets).toEqual([
      { serverId: "s1", workspaceId: "/repo/main" },
      { serverId: "s1", workspaceId: "/repo/feat-a" },
    ]);
    expect(model.shortcutIndexByWorkspaceKey.get("s1:/repo/main")).toBe(1);
    expect(model.shortcutIndexByWorkspaceKey.get("s1:/repo/feat-a")).toBe(2);
    expect(model.shortcutIndexByWorkspaceKey.get("s1:/repo2/main")).toBeUndefined();
  });

  it("limits shortcuts to 9", () => {
    const workspaces = Array.from({ length: 20 }, (_, index) => workspace("s", `/repo/w${index + 1}`));
    const projects = [project("p", workspaces)];

    const model = buildSidebarWorkspaceViewModel({
      projects,
      collapsedProjectKeys: new Set<string>(),
      getProjectDisplayName: (entry) => entry.projectName,
    });

    expect(model.shortcutTargets).toHaveLength(9);
    expect(model.shortcutTargets[0]).toEqual({ serverId: "s", workspaceId: "/repo/w1" });
    expect(model.shortcutTargets[8]).toEqual({ serverId: "s", workspaceId: "/repo/w9" });
  });
});
