import { describe, it, expect } from "vitest";
import {
  DEFAULTS,
  parseSettings,
  serializeSettings,
  cssVars,
  loadSettings,
  saveSettings,
  STORAGE_KEY,
} from "./typography.ts";

describe("typography", () => {
  it("falls back to defaults on garbage", () => {
    expect(parseSettings("not json")).toEqual(DEFAULTS);
    expect(parseSettings(null)).toEqual(DEFAULTS);
    expect(parseSettings({ font: "comic", theme: 5 })).toEqual(DEFAULTS);
  });
  it("clamps numbers", () => {
    expect(parseSettings({ size: 99, lineHeight: 0 }).size).toBe(26);
    expect(parseSettings({ size: 2 }).size).toBe(14);
    expect(parseSettings({ lineHeight: 9 }).lineHeight).toBe(2.2);
    expect(parseSettings({ lineHeight: 0 }).lineHeight).toBe(1.3);
    expect(parseSettings({ size: NaN }).size).toBe(DEFAULTS.size);
  });
  it("round-trips", () => {
    const s = { font: "dyslexia", size: 22, lineHeight: 1.9, width: "wide", theme: "dark" } as const;
    expect(parseSettings(serializeSettings(s))).toEqual(s);
  });
  it("produces css vars", () => {
    const v = cssVars({ ...DEFAULTS, size: 20, width: "narrow" });
    expect(v["--r-size"]).toBe("20px");
    expect(v["--r-width"]).toBe("560px");
  });
  it("persists via store", () => {
    const m = new Map<string, string>();
    const store = {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
    };
    saveSettings({ ...DEFAULTS, theme: "sepia" }, store);
    expect(m.has(STORAGE_KEY)).toBe(true);
    expect(loadSettings(store).theme).toBe("sepia");
  });
});
