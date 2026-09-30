import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_LOCALE, isLocale, LOCALE_META, SUPPORTED_LOCALES } from "./locales.ts";

describe("locale guards", () => {
  it("accept exactly the supported locale codes", () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(isLocale(locale)).toBe(true);
    }
  });

  it("reject unknown, malformed, and non-string values", () => {
    expect(isLocale("fr-FR")).toBe(false);
    expect(isLocale("en")).toBe(false);
    expect(isLocale("EN-US")).toBe(false);
    expect(isLocale("")).toBe(false);
    expect(isLocale(undefined)).toBe(false);
    expect(isLocale(null)).toBe(false);
    expect(isLocale(5)).toBe(false);
    expect(isLocale({})).toBe(false);
  });

  it("keeps the default locale within the supported set", () => {
    expect(SUPPORTED_LOCALES).toContain(DEFAULT_LOCALE);
  });

  it("describe every supported locale with left-to-right direction metadata", () => {
    for (const locale of SUPPORTED_LOCALES) {
      const meta = LOCALE_META[locale];
      expect(meta.dir).toBe("ltr");
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.nativeLabel.length).toBeGreaterThan(0);
    }
  });
});
