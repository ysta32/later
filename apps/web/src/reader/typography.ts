export type FontFamily = "serif" | "sans" | "dyslexia";
export type Width = "narrow" | "medium" | "wide";
export type Theme = "light" | "sepia" | "dark";

export interface TypographySettings {
  font: FontFamily;
  size: number;
  lineHeight: number;
  width: Width;
  theme: Theme;
}

export const DEFAULTS: TypographySettings = {
  font: "serif",
  size: 19,
  lineHeight: 1.7,
  width: "medium",
  theme: "light",
};
export const SIZE_RANGE = [14, 26] as const;
export const LINE_HEIGHT_RANGE = [1.3, 2.2] as const;
export const STORAGE_KEY = "later.reader.typography";

const FONTS: Record<FontFamily, string> = {
  serif: `"Iowan Old Style", "Charter", "Georgia", "Times New Roman", serif`,
  sans: `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif`,
  dyslexia: `"OpenDyslexic", "Atkinson Hyperlegible", "Comic Sans MS", "Verdana", sans-serif`,
};
const WIDTHS: Record<Width, string> = { narrow: "560px", medium: "680px", wide: "820px" };

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function num(v: unknown, fallback: number, lo: number, hi: number): number {
  return typeof v === "number" && Number.isFinite(v) ? clamp(v, lo, hi) : fallback;
}
function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

/** Tolerant parse: accepts JSON text or object; invalid fields fall back to defaults; numbers are clamped. */
export function parseSettings(raw: unknown): TypographySettings {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return { ...DEFAULTS };
    }
  }
  if (typeof obj !== "object" || obj === null) return { ...DEFAULTS };
  const o = obj as Record<string, unknown>;
  return {
    font: pick(o.font, ["serif", "sans", "dyslexia"] as const, DEFAULTS.font),
    size: Math.round(num(o.size, DEFAULTS.size, SIZE_RANGE[0], SIZE_RANGE[1])),
    lineHeight:
      Math.round(num(o.lineHeight, DEFAULTS.lineHeight, LINE_HEIGHT_RANGE[0], LINE_HEIGHT_RANGE[1]) * 100) /
      100,
    width: pick(o.width, ["narrow", "medium", "wide"] as const, DEFAULTS.width),
    theme: pick(o.theme, ["light", "sepia", "dark"] as const, DEFAULTS.theme),
  };
}

export function serializeSettings(s: TypographySettings): string {
  return JSON.stringify(parseSettings(s));
}

export function cssVars(s: TypographySettings): Record<string, string> {
  return {
    "--r-font": FONTS[s.font],
    "--r-size": `${s.size}px`,
    "--r-lh": String(s.lineHeight),
    "--r-width": WIDTHS[s.width],
  };
}

type StoreLike = Pick<Storage, "getItem" | "setItem">;

export function loadSettings(store: StoreLike | undefined = globalThis.localStorage): TypographySettings {
  try {
    return parseSettings(store?.getItem(STORAGE_KEY) ?? null);
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(
  s: TypographySettings,
  store: StoreLike | undefined = globalThis.localStorage,
): void {
  try {
    store?.setItem(STORAGE_KEY, serializeSettings(s));
  } catch {
    /* storage unavailable or full: settings stay in memory */
  }
}
