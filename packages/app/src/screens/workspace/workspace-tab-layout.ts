export type WorkspaceTabLayoutMode = "full" | "compact" | "icon";

export type WorkspaceTabLayoutInput = {
  containerWidth: number;
  actionsWidth: number;
  tabLabelLengths: number[];
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

export type WorkspaceTabLayoutResult = {
  mode: WorkspaceTabLayoutMode;
  tabWidths: number[];
  shouldScroll: boolean;
  showLabels: boolean;
  showCloseButtons: boolean;
};

function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

function sum(values: number[]): number {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total;
}

function computeTotalRowWidth(input: {
  tabWidths: number[];
  tabGap: number;
  rowPaddingHorizontal: number;
}): number {
  if (input.tabWidths.length === 0) {
    return 0;
  }
  return (
    input.rowPaddingHorizontal * 2 +
    sum(input.tabWidths) +
    Math.max(input.tabWidths.length - 1, 0) * input.tabGap
  );
}

export function computeWorkspaceTabLayout(
  input: WorkspaceTabLayoutInput
): WorkspaceTabLayoutResult {
  const tabCount = input.tabLabelLengths.length;
  if (tabCount === 0) {
    return {
      mode: "full",
      tabWidths: [],
      shouldScroll: false,
      showLabels: true,
      showCloseButtons: true,
    };
  }

  const availableWidth = Math.max(0, input.containerWidth - input.actionsWidth);
  const minLabelWidth =
    input.metrics.tabBaseWidthWithClose + input.metrics.charWidth * input.metrics.minLabelChars;

  const preferredTabWidths = input.tabLabelLengths.map((rawLength) => {
    const labelLength = Math.max(rawLength, 1);
    const preferred = input.metrics.tabBaseWidthWithClose + labelLength * input.metrics.charWidth;
    return clamp(preferred, minLabelWidth, input.metrics.maxTabWidth);
  });

  const preferredTotal = computeTotalRowWidth({
    tabWidths: preferredTabWidths,
    tabGap: input.metrics.tabGap,
    rowPaddingHorizontal: input.metrics.rowPaddingHorizontal,
  });

  if (preferredTotal <= availableWidth) {
    return {
      mode: "full",
      tabWidths: preferredTabWidths,
      shouldScroll: false,
      showLabels: true,
      showCloseButtons: true,
    };
  }

  const compactMinTabWidths = preferredTabWidths.map(() => minLabelWidth);
  const compactTotal = computeTotalRowWidth({
    tabWidths: compactMinTabWidths,
    tabGap: input.metrics.tabGap,
    rowPaddingHorizontal: input.metrics.rowPaddingHorizontal,
  });

  if (compactTotal <= availableWidth) {
    const totalShrinkCapacity = sum(preferredTabWidths.map((width) => width - minLabelWidth));
    const targetShrink = preferredTotal - availableWidth;
    const shrinkRatio = totalShrinkCapacity > 0 ? targetShrink / totalShrinkCapacity : 1;
    const tabWidths = preferredTabWidths.map((preferred) => {
      const shrinkCapacity = preferred - minLabelWidth;
      return preferred - shrinkCapacity * shrinkRatio;
    });

    return {
      mode: "compact",
      tabWidths,
      shouldScroll: false,
      showLabels: true,
      showCloseButtons: true,
    };
  }

  const iconTabWidths = preferredTabWidths.map(() => input.metrics.iconOnlyTabWidth);
  const iconTotal = computeTotalRowWidth({
    tabWidths: iconTabWidths,
    tabGap: input.metrics.tabGap,
    rowPaddingHorizontal: input.metrics.rowPaddingHorizontal,
  });

  return {
    mode: "icon",
    tabWidths: iconTabWidths,
    shouldScroll: iconTotal > availableWidth,
    showLabels: false,
    showCloseButtons: false,
  };
}
