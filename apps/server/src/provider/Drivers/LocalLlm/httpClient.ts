import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

export type ApiFormat = "openai" | "anthropic";

export interface LocalLlmClientConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly apiFormat: ApiFormat;
}

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | ReadonlyArray<ContentPart>;
  readonly toolCallId?: string;
  readonly toolCalls?: ReadonlyArray<ToolCall>;
}

export type ContentPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image_url"; readonly image_url: { readonly url: string } };

export interface ToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
}

export interface ToolDefinition {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

export interface ChatCompletionRequest {
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly tools?: ReadonlyArray<ToolDefinition>;
  readonly stream?: boolean;
  readonly temperature?: number;
  readonly maxTokens?: number;
}

export interface ChatCompletionDelta {
  readonly type: "text" | "toolCallStart" | "toolCallDelta" | "toolCallEnd" | "done";
  readonly text?: string;
  readonly toolCall?: {
    readonly index: number;
    readonly id?: string;
    readonly name?: string;
    readonly arguments?: string;
  };
}

export interface ChatCompletionResponse {
  readonly content: string;
  readonly toolCalls: ReadonlyArray<ToolCall>;
}

export interface ModelInfo {
  readonly id: string;
  readonly object?: string;
}

const DEFAULT_TIMEOUT_MS = 180_000;

function buildUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}${path}`;
}

function buildHeaders(apiKey: string, apiFormat: ApiFormat): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey.length > 0) {
    if (apiFormat === "anthropic") {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }
  }
  return headers;
}

function buildOpenAiBody(
  config: LocalLlmClientConfig,
  request: ChatCompletionRequest,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages: request.messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
      ...(m.toolCalls ? { tool_calls: m.toolCalls } : {}),
    })),
  };
  if (request.stream) body.stream = true;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
  if (request.tools && request.tools.length > 0) body.tools = request.tools;
  return body;
}

function buildAnthropicBody(
  config: LocalLlmClientConfig,
  request: ChatCompletionRequest,
): Record<string, unknown> {
  const systemMessages = request.messages.filter((m) => m.role === "system");
  const nonSystemMessages = request.messages.filter((m) => m.role !== "system");
  const systemPrompt = systemMessages
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n");

  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: request.maxTokens ?? 4096,
    messages: nonSystemMessages.map((m) => {
      if (m.role === "tool" && m.toolCallId) {
        return {
          role: "user" as const,
          content: [
            {
              type: "tool_result" as const,
              tool_use_id: m.toolCallId,
              content: typeof m.content === "string" ? m.content : "",
            },
          ],
        };
      }
      if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
        return {
          role: "assistant" as const,
          content: [
            ...(typeof m.content === "string" && m.content.length > 0
              ? [{ type: "text" as const, text: m.content }]
              : []),
            ...m.toolCalls.map((tc) => ({
              type: "tool_use" as const,
              id: tc.id,
              name: tc.function.name,
              input: JSON.parse(tc.function.arguments),
            })),
          ],
        };
      }
      return {
        role: m.role === "tool" ? ("user" as const) : m.role,
        content: m.content,
      };
    }),
  };
  if (systemPrompt.length > 0) body.system = systemPrompt;
  if (request.stream) body.stream = true;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));
  }
  return body;
}

function getEndpointPath(apiFormat: ApiFormat): string {
  return apiFormat === "anthropic" ? "/v1/messages" : "/v1/chat/completions";
}

export function fetchModels(
  config: LocalLlmClientConfig,
): Effect.Effect<ReadonlyArray<ModelInfo>, Error> {
  return Effect.tryPromise({
    try: () =>
      fetch(buildUrl(config.baseUrl, "/v1/models"), {
        method: "GET",
        headers: buildHeaders(config.apiKey, "openai"),
        signal: AbortSignal.timeout(10_000),
      }).then(async (response) => {
        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new Error(`Failed to fetch models (${response.status}): ${body}`);
        }
        return response.json() as Promise<{ data: ModelInfo[] }>;
      }),
    catch: (error) => (error instanceof Error ? error : new Error("Failed to fetch models")),
  }).pipe(
    Effect.map((result) => result.data),
    Effect.timeout(`${DEFAULT_TIMEOUT_MS} millis`),
  );
}

export function chatCompletion(
  config: LocalLlmClientConfig,
  request: ChatCompletionRequest,
): Effect.Effect<ChatCompletionResponse, Error> {
  const url = buildUrl(config.baseUrl, getEndpointPath(config.apiFormat));
  const body =
    config.apiFormat === "anthropic"
      ? buildAnthropicBody(config, request)
      : buildOpenAiBody(config, request);

  return Effect.tryPromise({
    try: () =>
      fetch(url, {
        method: "POST",
        headers: buildHeaders(config.apiKey, config.apiFormat),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      }).then(async (response) => {
        if (!response.ok) {
          const responseBody = await response.text().catch(() => "");
          throw new Error(`API request failed (${response.status}): ${responseBody}`);
        }
        return response.json() as Promise<Record<string, unknown>>;
      }),
    catch: (error) => (error instanceof Error ? error : new Error("API request failed")),
  }).pipe(
    Effect.timeout(`${DEFAULT_TIMEOUT_MS} millis`),
    Effect.map((response) => parseCompletionResponse(response, config.apiFormat)),
  );
}

function parseCompletionResponse(
  response: Record<string, unknown>,
  apiFormat: ApiFormat,
): ChatCompletionResponse {
  if (apiFormat === "anthropic") {
    const content = response.content as Array<Record<string, unknown>> | undefined;
    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];
    if (content) {
      for (const part of content) {
        if (part.type === "text") {
          textParts.push(part.text as string);
        } else if (part.type === "tool_use") {
          toolCalls.push({
            id: part.id as string,
            type: "function",
            function: {
              name: part.name as string,
              arguments: JSON.stringify(part.input),
            },
          });
        }
      }
    }
    return { content: textParts.join(""), toolCalls };
  }

  const choices = response.choices as Array<Record<string, unknown>> | undefined;
  const message = choices?.[0]?.message as Record<string, unknown> | undefined;
  const content = (message?.content as string | null) ?? "";
  const rawToolCalls = message?.tool_calls as Array<Record<string, unknown>> | undefined;
  const toolCalls: ToolCall[] = (rawToolCalls ?? []).map((tc) => ({
    id: tc.id as string,
    type: "function" as const,
    function: {
      name: (tc.function as Record<string, unknown>).name as string,
      arguments: (tc.function as Record<string, unknown>).arguments as string,
    },
  }));
  return { content, toolCalls };
}

export function chatCompletionStream(
  config: LocalLlmClientConfig,
  request: ChatCompletionRequest,
): Stream.Stream<ChatCompletionDelta, Error> {
  const url = buildUrl(config.baseUrl, getEndpointPath(config.apiFormat));
  const body =
    config.apiFormat === "anthropic"
      ? buildAnthropicBody(config, { ...request, stream: true })
      : buildOpenAiBody(config, { ...request, stream: true });

  return Stream.async<ChatCompletionDelta, Error>((emit) =>
    Effect.gen(function* () {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

      try {
        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(url, {
              method: "POST",
              headers: buildHeaders(config.apiKey, config.apiFormat),
              body: JSON.stringify(body),
              signal: controller.signal,
            }),
          catch: (error) => (error instanceof Error ? error : new Error("Stream request failed")),
        });

        if (!response.ok) {
          const responseBody = yield* Effect.tryPromise({
            try: () => response.text(),
            catch: () => new Error("Failed to read error response"),
          });
          emit(new Error(`Stream request failed (${response.status}): ${responseBody}`));
          return;
        }

        if (!response.body) {
          emit(new Error("Response body is null"));
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = yield* Effect.tryPromise({
            try: () => reader.read(),
            catch: (error) => (error instanceof Error ? error : new Error("Stream read failed")),
          });

          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const deltas = parseSseLine(line, config.apiFormat);
            for (const delta of deltas) {
              emit(delta);
            }
          }
        }

        emit({ type: "done" });
      } catch (error) {
        emit(error instanceof Error ? error : new Error("Stream failed"));
      } finally {
        clearTimeout(timeoutId);
      }
    }),
  );
}

function parseSseLine(line: string, apiFormat: ApiFormat): ChatCompletionDelta[] {
  const deltas: ChatCompletionDelta[] = [];

  if (apiFormat === "anthropic") {
    if (!line.startsWith("data: ")) return deltas;
    const data = line.slice(6).trim();
    if (data === "[DONE]") return deltas;

    try {
      const event = JSON.parse(data) as Record<string, unknown>;
      switch (event.type) {
        case "content_block_delta": {
          const delta = event.delta as Record<string, unknown>;
          if (delta.type === "text_delta") {
            deltas.push({ type: "text", text: delta.text as string });
          } else if (delta.type === "input_json_delta") {
            deltas.push({
              type: "toolCallDelta",
              toolCall: {
                index: event.index as number,
                arguments: delta.partial_json as string,
              },
            });
          }
          break;
        }
        case "content_block_start": {
          const block = event.content_block as Record<string, unknown>;
          if (block.type === "tool_use") {
            deltas.push({
              type: "toolCallStart",
              toolCall: {
                index: event.index as number,
                id: block.id as string,
                name: block.name as string,
              },
            });
          }
          break;
        }
        case "content_block_stop": {
          deltas.push({
            type: "toolCallEnd",
            toolCall: { index: event.index as number },
          });
          break;
        }
      }
    } catch {
      // Skip malformed lines
    }
    return deltas;
  }

  // OpenAI format
  if (!line.startsWith("data: ")) return deltas;
  const data = line.slice(6).trim();
  if (data === "[DONE]") return deltas;

  try {
    const chunk = JSON.parse(data) as Record<string, unknown>;
    const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
    const delta = choices?.[0]?.delta as Record<string, unknown> | undefined;
    if (!delta) return deltas;

    if (typeof delta.content === "string" && delta.content.length > 0) {
      deltas.push({ type: "text", text: delta.content });
    }

    const toolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined;
    if (toolCalls) {
      for (const tc of toolCalls) {
        const index = tc.index as number;
        const fn = tc.function as Record<string, unknown> | undefined;
        if (tc.id) {
          deltas.push({
            type: "toolCallStart",
            toolCall: {
              index,
              id: tc.id as string,
              name: fn?.name as string | undefined,
            },
          });
        }
        if (fn?.arguments) {
          deltas.push({
            type: "toolCallDelta",
            toolCall: { index, arguments: fn.arguments as string },
          });
        }
        deltas.push({ type: "toolCallEnd", toolCall: { index } });
      }
    }
  } catch {
    // Skip malformed lines
  }

  return deltas;
}
