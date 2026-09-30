import { describe, expect, it } from "vite-plus/test";

import enUS from "./locales/en-US.json";
import ptBR from "./locales/pt-BR.json";

/**
 * Leaf-path collection over nested catalog objects. A string value is a leaf;
 * any object is traversed so the comparison is about key shape, not ordering.
 */
function collectLeafPaths(node: unknown, prefix = ""): string[] {
  if (node !== null && typeof node === "object") {
    return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
      collectLeafPaths(value, prefix ? `${prefix}.${key}` : key),
    );
  }
  return [prefix];
}

function readLeaf(node: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc !== null && typeof acc === "object") return (acc as Record<string, unknown>)[key];
    return undefined;
  }, node);
}

function interpolationVars(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return [...value.matchAll(/\{\{\s*([\w.]+)/g)].map((match) => match[1]!).sort();
}

describe("mobile i18n catalogs", () => {
  it("keep an identical key set between en-US and pt-BR", () => {
    const enKeys = collectLeafPaths(enUS).sort();
    const ptKeys = collectLeafPaths(ptBR).sort();
    const missingInPt = enKeys.filter((key) => !ptKeys.includes(key));
    const extraInPt = ptKeys.filter((key) => !enKeys.includes(key));
    expect({ missingInPt, extraInPt }).toEqual({ missingInPt: [], extraInPt: [] });
  });

  it("have no empty translated values", () => {
    const emptyPt = collectLeafPaths(ptBR).filter((path) => {
      const value = readLeaf(ptBR, path);
      return typeof value !== "string" || value.trim() === "";
    });
    expect(emptyPt).toEqual([]);
  });

  it("carry the same interpolation variables per key across locales", () => {
    const mismatched = collectLeafPaths(enUS)
      .filter((path) => {
        const enVars = interpolationVars(readLeaf(enUS, path));
        const ptVars = interpolationVars(readLeaf(ptBR, path));
        return JSON.stringify(enVars) !== JSON.stringify(ptVars);
      })
      .map((path) => ({
        path,
        en: interpolationVars(readLeaf(enUS, path)),
        pt: interpolationVars(readLeaf(ptBR, path)),
      }));
    expect(mismatched).toEqual([]);
  });
});
