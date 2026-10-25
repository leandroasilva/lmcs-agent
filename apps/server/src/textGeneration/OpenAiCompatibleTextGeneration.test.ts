import { describe, expect, it } from "vite-plus/test";

import { resolveChatCompletionsUrl } from "./OpenAiCompatibleTextGeneration.ts";

describe("resolveChatCompletionsUrl", () => {
  it("appends the endpoint to an API root", () => {
    expect(resolveChatCompletionsUrl("https://api.deepseek.com/v1")).toBe(
      "https://api.deepseek.com/v1/chat/completions",
    );
  });

  it("completes a URL that stops at the chat collection", () => {
    expect(resolveChatCompletionsUrl("https://api.deepseek.com/v1/chat")).toBe(
      "https://api.deepseek.com/v1/chat/completions",
    );
  });

  it("keeps a pasted full endpoint", () => {
    expect(resolveChatCompletionsUrl("https://api.deepseek.com/v1/chat/completions")).toBe(
      "https://api.deepseek.com/v1/chat/completions",
    );
  });

  it("ignores trailing slashes and surrounding spaces", () => {
    expect(resolveChatCompletionsUrl("  https://api.deepseek.com/v1/ ")).toBe(
      "https://api.deepseek.com/v1/chat/completions",
    );
  });
});
