import { create } from "zustand";
import type { MessageInputKeyboardActionKind } from "@/keyboard/actions";
import type { SidebarShortcutWorkspaceTarget } from "@/utils/sidebar-shortcuts";

export type MessageInputActionRequest = {
  id: number;
  agentKey: string;
  kind: MessageInputKeyboardActionKind;
};

interface KeyboardShortcutsState {
  commandCenterOpen: boolean;
  shortcutsDialogOpen: boolean;
  altDown: boolean;
  cmdOrCtrlDown: boolean;
  /** Sidebar-visible workspace targets (up to 9), in top-to-bottom visual order. */
  sidebarShortcutWorkspaceTargets: SidebarShortcutWorkspaceTarget[];
  messageInputActionRequest: MessageInputActionRequest | null;
  nextMessageInputActionRequestId: number;

  setCommandCenterOpen: (open: boolean) => void;
  setShortcutsDialogOpen: (open: boolean) => void;
  setAltDown: (down: boolean) => void;
  setCmdOrCtrlDown: (down: boolean) => void;
  setSidebarShortcutWorkspaceTargets: (targets: SidebarShortcutWorkspaceTarget[]) => void;
  resetModifiers: () => void;

  requestMessageInputAction: (input: {
    agentKey: string;
    kind: MessageInputKeyboardActionKind;
  }) => void;
  clearMessageInputActionRequest: (id: number) => void;
}

export const useKeyboardShortcutsStore = create<KeyboardShortcutsState>(
  (set, get) => ({
    commandCenterOpen: false,
    shortcutsDialogOpen: false,
    altDown: false,
    cmdOrCtrlDown: false,
    sidebarShortcutWorkspaceTargets: [],
    messageInputActionRequest: null,
    nextMessageInputActionRequestId: 1,

    setCommandCenterOpen: (open) => set({ commandCenterOpen: open }),
    setShortcutsDialogOpen: (open) => set({ shortcutsDialogOpen: open }),
    setAltDown: (down) => set({ altDown: down }),
    setCmdOrCtrlDown: (down) => set({ cmdOrCtrlDown: down }),
    setSidebarShortcutWorkspaceTargets: (targets) =>
      set({ sidebarShortcutWorkspaceTargets: targets }),
    resetModifiers: () => set({ altDown: false, cmdOrCtrlDown: false }),

    requestMessageInputAction: ({ agentKey, kind }) => {
      const id = get().nextMessageInputActionRequestId;
      set({
        messageInputActionRequest: { id, agentKey, kind },
        nextMessageInputActionRequestId: id + 1,
      });
    },
    clearMessageInputActionRequest: (id) => {
      const current = get().messageInputActionRequest;
      if (!current || current.id !== id) {
        return;
      }
      set({ messageInputActionRequest: null });
    },
  })
);
