import { useCallback, useMemo, useState } from "react";
import type { LayoutChangeEvent } from "react-native";
import {
  computeWorkspaceTabLayout,
  type WorkspaceTabLayoutResult,
} from "@/screens/workspace/workspace-tab-layout";

type UseWorkspaceTabLayoutInput = {
  tabLabels: string[];
  metrics: {
    rowPaddingHorizontal: number;
    tabGap: number;
    maxTabWidth: number;
    iconOnlyTabWidth: number;
    tabBaseWidthWithClose: number;
    minLabelChars: number;
    charWidth: number;
  };
};

type UseWorkspaceTabLayoutResult = {
  layout: WorkspaceTabLayoutResult;
  onContainerLayout: (event: LayoutChangeEvent) => void;
  onActionsLayout: (event: LayoutChangeEvent) => void;
};

export function useWorkspaceTabLayout(input: UseWorkspaceTabLayoutInput): UseWorkspaceTabLayoutResult {
  const [containerWidth, setContainerWidth] = useState(0);
  const [actionsWidth, setActionsWidth] = useState(0);

  const onContainerLayout = useCallback((event: LayoutChangeEvent) => {
    setContainerWidth(event.nativeEvent.layout.width);
  }, []);

  const onActionsLayout = useCallback((event: LayoutChangeEvent) => {
    setActionsWidth(event.nativeEvent.layout.width);
  }, []);

  const layout = useMemo(
    () =>
      computeWorkspaceTabLayout({
        containerWidth,
        actionsWidth,
        tabLabelLengths: input.tabLabels.map((label) => label.length),
        metrics: input.metrics,
      }),
    [actionsWidth, containerWidth, input.metrics, input.tabLabels]
  );

  return {
    layout,
    onContainerLayout,
    onActionsLayout,
  };
}
