import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

vi.mock("expo-sqlite", () => ({ openDatabaseAsync: vi.fn() }));
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
}));

import { sanitizePreferences } from "./mobile-preferences";

describe("mobile preferences sanitization", () => {
  it("round-trips a supported locale through the persisted blob", () => {
    expect(sanitizePreferences(sanitizePreferences({ locale: "pt-BR" }))).toEqual({
      locale: "pt-BR",
    });
  });

  it("drops unknown or malformed locale values", () => {
    expect(sanitizePreferences({ locale: "fr-FR" as never }).locale).toBeUndefined();
    expect(sanitizePreferences({ locale: 5 as never }).locale).toBeUndefined();
    expect("locale" in sanitizePreferences({})).toBe(false);
  });
});
