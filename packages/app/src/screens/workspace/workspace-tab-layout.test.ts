import { describe, expect, it } from "vitest";
import { computeWorkspaceTabLayout } from "@/screens/workspace/workspace-tab-layout";

const metrics = {
  rowPaddingHorizontal: 8,
  tabGap: 4,
  maxTabWidth: 260,
  iconOnlyTabWidth: 40,
  tabBaseWidthWithClose: 84,
  minLabelChars: 4,
  charWidth: 7,
};

describe("computeWorkspaceTabLayout", () => {
  it("keeps full width tabs when space is available", () => {
    const result = computeWorkspaceTabLayout({
      containerWidth: 1200,
      actionsWidth: 100,
      tabLabelLengths: [8, 10, 7],
      metrics,
    });

    expect(result.mode).toBe("full");
    expect(result.shouldScroll).toBe(false);
    expect(result.showLabels).toBe(true);
    expect(result.showCloseButtons).toBe(true);
  });

  it("shrinks proportionally in compact mode before icon-only", () => {
    const result = computeWorkspaceTabLayout({
      containerWidth: 500,
      actionsWidth: 110,
      tabLabelLengths: [24, 12, 8],
      metrics,
    });

    expect(result.mode).toBe("compact");
    expect(result.shouldScroll).toBe(false);
    expect(result.showLabels).toBe(true);
    expect(result.tabWidths[0]).toBeGreaterThan(result.tabWidths[1]);
    expect(result.tabWidths[1]).toBeGreaterThan(result.tabWidths[2]);
  });

  it("falls back to icon mode when compact labels still cannot fit", () => {
    const result = computeWorkspaceTabLayout({
      containerWidth: 300,
      actionsWidth: 120,
      tabLabelLengths: [14, 14, 14, 14],
      metrics,
    });

    expect(result.mode).toBe("icon");
    expect(result.showLabels).toBe(false);
    expect(result.showCloseButtons).toBe(false);
    expect(result.shouldScroll).toBe(true);
  });

  it("keeps icon mode without scroll when icons can fit", () => {
    const result = computeWorkspaceTabLayout({
      containerWidth: 380,
      actionsWidth: 120,
      tabLabelLengths: [20, 20, 20, 20],
      metrics,
    });

    expect(result.mode).toBe("icon");
    expect(result.shouldScroll).toBe(false);
  });
});
