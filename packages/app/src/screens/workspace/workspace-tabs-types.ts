import type { Agent } from "@/stores/session-store";

export type WorkspaceTabDescriptor =
  | {
      key: string;
      tabId: string;
      kind: "draft";
      draftId: string;
      label: string;
      subtitle: string;
    }
  | {
      key: string;
      tabId: string;
      kind: "agent";
      agentId: string;
      provider: Agent["provider"];
      label: string;
      subtitle: string;
    }
  | {
      key: string;
      tabId: string;
      kind: "terminal";
      terminalId: string;
      label: string;
      subtitle: string;
    }
  | {
      key: string;
      tabId: string;
      kind: "file";
      filePath: string;
      label: string;
      subtitle: string;
    };
