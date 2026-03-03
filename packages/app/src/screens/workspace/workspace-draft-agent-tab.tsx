import { useCallback, useEffect, useMemo, useReducer } from "react";
import { Keyboard, Platform, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AgentInputArea } from "@/components/agent-input-area";
import { AgentConfigRow } from "@/components/agent-form/agent-form-dropdowns";
import { AgentStreamView } from "@/components/agent-stream-view";
import { MAX_CONTENT_WIDTH } from "@/constants/layout";
import { useAgentFormState } from "@/hooks/use-agent-form-state";
import { useHostRuntimeSession } from "@/runtime/host-runtime";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { generateMessageId, type StreamItem, type UserMessageImageAttachment } from "@/types/stream";
import { encodeImages } from "@/utils/encode-images";
import type { AgentCapabilityFlags, AgentSessionConfig } from "@server/server/agent/agent-sdk-types";
import type { AgentSnapshotPayload } from "@server/shared/messages";
import { normalizeAgentSnapshot } from "@/utils/agent-snapshots";

const EMPTY_PENDING_PERMISSIONS = new Map();
const EMPTY_STREAM_ITEMS: StreamItem[] = [];
const DRAFT_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: false,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
};

type WorkspaceDraftAgentTabProps = {
  serverId: string;
  workspaceId: string;
  tabId: string;
  draftId: string;
  onCreated: (snapshot: AgentSnapshotPayload) => void;
};

type CreateAttempt = {
  clientMessageId: string;
  text: string;
  timestamp: Date;
  images?: UserMessageImageAttachment[];
};

type DraftAgentMachineState =
  | { tag: "draft"; promptText: string; errorMessage: string }
  | { tag: "creating"; attempt: CreateAttempt };

type DraftAgentMachineEvent =
  | { type: "DRAFT_SET_PROMPT"; text: string }
  | { type: "DRAFT_SET_ERROR"; message: string }
  | { type: "SUBMIT"; attempt: CreateAttempt }
  | { type: "CREATE_FAILED"; message: string };

function assertNever(value: never): never {
  throw new Error(`Unhandled state: ${JSON.stringify(value)}`);
}

export function WorkspaceDraftAgentTab({
  serverId,
  workspaceId,
  tabId,
  draftId,
  onCreated,
}: WorkspaceDraftAgentTabProps) {
  const { client, isConnected } = useHostRuntimeSession(serverId);

  const setPendingCreateAttempt = useCreateFlowStore((state) => state.setPending);
  const updatePendingAgentId = useCreateFlowStore((state) => state.updateAgentId);
  const markPendingCreateLifecycle = useCreateFlowStore((state) => state.markLifecycle);
  const clearPendingCreateAttempt = useCreateFlowStore((state) => state.clear);

  const {
    selectedProvider,
    setProviderFromUser,
    selectedMode,
    setModeFromUser,
    selectedModel,
    setModelFromUser,
    selectedThinkingOptionId,
    setThinkingOptionFromUser,
    workingDir,
    setWorkingDir,
    providerDefinitions,
    modeOptions,
    availableModels,
    availableThinkingOptions,
    isModelLoading,
    persistFormPreferences,
  } = useAgentFormState({
    initialServerId: serverId,
    initialValues: { workingDir: workspaceId },
    isVisible: true,
    isCreateFlow: true,
    onlineServerIds: isConnected ? [serverId] : [],
  });

  // Lock working directory to workspace.
  useEffect(() => {
    if (workingDir.trim() === workspaceId.trim()) {
      return;
    }
    setWorkingDir(workspaceId);
  }, [setWorkingDir, workingDir, workspaceId]);

  const [machine, dispatch] = useReducer(
    (state: DraftAgentMachineState, event: DraftAgentMachineEvent): DraftAgentMachineState => {
      switch (event.type) {
        case "DRAFT_SET_PROMPT": {
          if (state.tag !== "draft") {
            return state;
          }
          return { ...state, promptText: event.text };
        }
        case "DRAFT_SET_ERROR": {
          if (state.tag !== "draft") {
            return state;
          }
          return { ...state, errorMessage: event.message };
        }
        case "SUBMIT": {
          return { tag: "creating", attempt: event.attempt };
        }
        case "CREATE_FAILED": {
          if (state.tag !== "creating") {
            return state;
          }
          return { tag: "draft", promptText: state.attempt.text, errorMessage: event.message };
        }
        default:
          return assertNever(event);
      }
    },
    { tag: "draft", promptText: "", errorMessage: "" }
  );

  const promptValue = machine.tag === "draft" ? machine.promptText : "";
  const formErrorMessage = machine.tag === "draft" ? machine.errorMessage : "";
  const isSubmitting = machine.tag === "creating";

  const optimisticStreamItems = useMemo<StreamItem[]>(() => {
    if (machine.tag !== "creating") {
      return EMPTY_STREAM_ITEMS;
    }
    return [
      {
        kind: "user_message",
        id: machine.attempt.clientMessageId,
        text: machine.attempt.text,
        timestamp: machine.attempt.timestamp,
        ...(machine.attempt.images && machine.attempt.images.length > 0
          ? { images: machine.attempt.images }
          : {}),
      },
    ];
  }, [machine]);

  const draftAgent = useMemo<Agent | null>(() => {
    if (machine.tag !== "creating") {
      return null;
    }
    const now = machine.attempt.timestamp;
    const model = selectedModel.trim() || null;
    const thinkingOptionId = selectedThinkingOptionId.trim() || null;
    const modeId = modeOptions.length > 0 && selectedMode !== "" ? selectedMode : null;
    return {
      serverId,
      id: tabId,
      provider: selectedProvider,
      status: "running",
      createdAt: now,
      updatedAt: now,
      lastUserMessageAt: now,
      lastActivityAt: now,
      capabilities: DRAFT_CAPABILITIES,
      currentModeId: modeId,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      runtimeInfo: { provider: selectedProvider, sessionId: null, model, modeId },
      title: "New agent",
      cwd: workspaceId,
      model,
      thinkingOptionId,
      labels: {},
    };
  }, [
    machine,
    modeOptions.length,
    selectedMode,
    selectedModel,
    selectedProvider,
    selectedThinkingOptionId,
    serverId,
    tabId,
    workspaceId,
  ]);

  const handleCreateFromInput = useCallback(
    async ({ text, images }: { text: string; images?: UserMessageImageAttachment[] }) => {
      if (isSubmitting) {
        throw new Error("Already loading");
      }
      dispatch({ type: "DRAFT_SET_ERROR", message: "" });
      const trimmedPrompt = text.trim();
      if (!trimmedPrompt) {
        dispatch({ type: "DRAFT_SET_ERROR", message: "Initial prompt is required" });
        throw new Error("Initial prompt is required");
      }
      if (providerDefinitions.length === 0) {
        dispatch({
          type: "DRAFT_SET_ERROR",
          message: "No available providers on the selected host",
        });
        throw new Error("No available providers on the selected host");
      }
      if (!client) {
        dispatch({ type: "DRAFT_SET_ERROR", message: "Host is not connected" });
        throw new Error("Host is not connected");
      }

      const attempt: CreateAttempt = {
        clientMessageId: generateMessageId(),
        text: trimmedPrompt,
        timestamp: new Date(),
        ...(images && images.length > 0 ? { images } : {}),
      };

      setPendingCreateAttempt({
        draftId,
        serverId,
        agentId: null,
        clientMessageId: attempt.clientMessageId,
        text: attempt.text,
        timestamp: attempt.timestamp.getTime(),
        ...(attempt.images && attempt.images.length > 0 ? { images: attempt.images } : {}),
      });

      const modeId = modeOptions.length > 0 && selectedMode !== "" ? selectedMode : undefined;
      const trimmedModel = selectedModel.trim();
      const trimmedThinkingOptionId = selectedThinkingOptionId.trim();
      const config: AgentSessionConfig = {
        provider: selectedProvider,
        cwd: workspaceId,
        ...(modeId ? { modeId } : {}),
        ...(trimmedModel ? { model: trimmedModel } : {}),
        ...(trimmedThinkingOptionId ? { thinkingOptionId: trimmedThinkingOptionId } : {}),
      };

      void persistFormPreferences();
      if (Platform.OS === "web") {
        (document.activeElement as HTMLElement | null)?.blur?.();
      }
      Keyboard.dismiss();
      dispatch({ type: "SUBMIT", attempt });

      try {
        const imagesData = await encodeImages(images);
        const result = await client.createAgent({
          config,
          labels: { ui: "true" },
          initialPrompt: trimmedPrompt,
          clientMessageId: attempt.clientMessageId,
          ...(imagesData && imagesData.length > 0 ? { images: imagesData } : {}),
        });

        const agentId = result.id;
        updatePendingAgentId({ draftId, agentId });

        const normalized = normalizeAgentSnapshot(result, serverId);
        useSessionStore.getState().setAgents(serverId, (prev) => {
          const next = new Map(prev);
          next.set(agentId, normalized);
          return next;
        });

        onCreated(result);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to create agent";
        dispatch({ type: "CREATE_FAILED", message });
        markPendingCreateLifecycle({ draftId, lifecycle: "abandoned" });
        clearPendingCreateAttempt({ draftId });
        throw error;
      }
    },
    [
      clearPendingCreateAttempt,
      client,
      draftId,
      isSubmitting,
      markPendingCreateLifecycle,
      modeOptions.length,
      onCreated,
      persistFormPreferences,
      providerDefinitions.length,
      selectedMode,
      selectedModel,
      selectedProvider,
      selectedThinkingOptionId,
      serverId,
      setPendingCreateAttempt,
      updatePendingAgentId,
      workspaceId,
    ]
  );

  const draftCommandConfig = useMemo(() => {
    return {
      provider: selectedProvider,
      cwd: workspaceId,
      ...(modeOptions.length > 0 && selectedMode !== "" ? { modeId: selectedMode } : {}),
      ...(selectedModel.trim() ? { model: selectedModel.trim() } : {}),
      ...(selectedThinkingOptionId.trim()
        ? { thinkingOptionId: selectedThinkingOptionId.trim() }
        : {}),
    };
  }, [
    modeOptions.length,
    selectedMode,
    selectedModel,
    selectedProvider,
    selectedThinkingOptionId,
    workspaceId,
  ]);

  return (
    <View style={styles.container}>
      <View style={styles.contentContainer}>
        {machine.tag === "creating" && draftAgent ? (
          <View style={styles.streamContainer}>
            <AgentStreamView
              agentId={tabId}
              serverId={serverId}
              agent={draftAgent}
              streamItems={optimisticStreamItems}
              pendingPermissions={EMPTY_PENDING_PERMISSIONS}
            />
          </View>
        ) : (
          <ScrollView style={styles.scrollView} contentContainerStyle={styles.configScrollContent}>
            <View style={styles.configSection}>
              <AgentConfigRow
                providerDefinitions={providerDefinitions}
                selectedProvider={selectedProvider}
                onSelectProvider={setProviderFromUser}
                modeOptions={modeOptions}
                selectedMode={selectedMode}
                onSelectMode={setModeFromUser}
                models={availableModels}
                selectedModel={selectedModel}
                onSelectModel={setModelFromUser}
                isModelLoading={isModelLoading}
                thinkingOptions={availableThinkingOptions}
                selectedThinkingOptionId={selectedThinkingOptionId}
                onSelectThinkingOption={setThinkingOptionFromUser}
                disabled={isSubmitting}
              />

              {formErrorMessage ? (
                <View style={styles.errorContainer}>
                  <Text style={styles.errorText}>{formErrorMessage}</Text>
                </View>
              ) : null}
            </View>
          </ScrollView>
        )}
      </View>

      <View style={styles.inputAreaWrapper}>
        <AgentInputArea
          agentId={tabId}
          serverId={serverId}
          onSubmitMessage={handleCreateFromInput}
          isSubmitLoading={isSubmitting}
          blurOnSubmit={true}
          value={promptValue}
          onChangeText={(next) => dispatch({ type: "DRAFT_SET_PROMPT", text: next })}
          autoFocus={machine.tag === "draft"}
          commandDraftConfig={draftCommandConfig}
          draftId={draftId}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    width: "100%",
    alignSelf: "center",
    maxWidth: MAX_CONTENT_WIDTH,
  },
  contentContainer: {
    flex: 1,
  },
  streamContainer: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  configScrollContent: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[6],
  },
  configSection: {
    gap: theme.spacing[3],
  },
  inputAreaWrapper: {
    width: "100%",
  },
  errorContainer: {
    marginTop: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.destructive,
  },
  errorText: {
    color: theme.colors.destructive,
  },
}));
