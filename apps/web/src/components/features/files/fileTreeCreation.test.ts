import { describe, expect, it } from "@effect/vitest";

import {
  joinRelativePath,
  resolveCreationParentPath,
  validateNewEntryName,
} from "./fileTreeCreation";

describe("resolveCreationParentPath", () => {
  it("creates at the workspace root without a selection", () => {
    expect(resolveCreationParentPath(null, undefined)).toBe("");
  });

  it("creates inside a selected directory", () => {
    expect(resolveCreationParentPath("apps/web/src", "directory")).toBe("apps/web/src");
  });

  it("creates beside a selected file", () => {
    expect(resolveCreationParentPath("apps/web/src/app.ts", "file")).toBe("apps/web/src");
    expect(resolveCreationParentPath("README.md", "file")).toBe("");
  });

  it("falls back to the parent of an entry whose kind is unknown", () => {
    expect(resolveCreationParentPath("docs/guide.md", undefined)).toBe("docs");
  });
});

describe("validateNewEntryName", () => {
  it("accepts plain and nested names", () => {
    expect(validateNewEntryName("notes.md")).toBeNull();
    expect(validateNewEntryName("deep/nested/notes.md")).toBeNull();
    expect(validateNewEntryName("  spaced.ts  ")).toBeNull();
  });

  it("rejects empty, absolute and dotted-segment names", () => {
    expect(validateNewEntryName("   ")).toBe("Enter a name.");
    expect(validateNewEntryName("/etc/passwd")).toBe("Name must be relative to the target folder.");
    expect(validateNewEntryName("a//b")).toBe("Name contains an invalid path segment.");
    expect(validateNewEntryName("../escape")).toBe("Name contains an invalid path segment.");
    expect(validateNewEntryName("a/./b")).toBe("Name contains an invalid path segment.");
  });

  it("rejects segments longer than the contract limit", () => {
    expect(validateNewEntryName(`${"x".repeat(256)}.ts`)).toBe(
      "Name segments must be 255 characters or fewer.",
    );
  });
});

describe("joinRelativePath", () => {
  it("trims the name and prefixes the parent folder", () => {
    expect(joinRelativePath("", " notes.md ")).toBe("notes.md");
    expect(joinRelativePath("apps/web", "src/app.ts")).toBe("apps/web/src/app.ts");
  });
});
