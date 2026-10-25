import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { TextGenerationApiSettings } from "@lmcstools/core";
import { TextGenerationError } from "@lmcstools/core";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@lmcstools/core/git";

import type * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const API_TIMEOUT_MS = 180_000;
const isTextGenerationError = Schema.is(TextGenerationError);

interface ChatCompletionResponse {
  choices: Array<{
    message: {
      content: string | null;
    };
  }>;
}

/**
 * The chat-completions endpoint a configured base URL stands for.
 *
 * Providers document their URL differently — an API root, the `/chat`
 * collection, or the full endpoint — and users paste whichever they copied.
 * Only the suffix the value is missing gets added, so every form reaches the
 * endpoint instead of 404ing on a doubled path.
 */
export function resolveChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  if (trimmed.endsWith("/chat")) return `${trimmed}/completions`;
  return `${trimmed}/chat/completions`;
}

function callOpenAiCompatibleApi(
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: string,
  operation: string,
): Effect.Effect<string, TextGenerationError> {
  const url = resolveChatCompletionsUrl(baseUrl);

  return Effect.tryPromise({
    try: () =>
      fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_object" },
          temperature: 0.3,
        }),
      }).then(async (response) => {
        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new Error(`API request failed (${response.status}): ${body}`);
        }
        return response.json() as Promise<ChatCompletionResponse>;
      }),
    catch: (error) =>
      new TextGenerationError({
        operation,
        detail:
          error instanceof Error
            ? `OpenAI-compatible API call failed: ${error.message}`
            : "OpenAI-compatible API call failed",
        cause: error,
      }),
  }).pipe(
    Effect.timeout(`${API_TIMEOUT_MS} millis`),
    Effect.mapError((error) =>
      isTextGenerationError(error)
        ? error
        : new TextGenerationError({
            operation,
            detail: "OpenAI-compatible API call timed out",
            cause: error,
          }),
    ),
    Effect.flatMap((response) => {
      const content = response.choices[0]?.message?.content;
      if (!content) {
        return Effect.fail(
          new TextGenerationError({
            operation,
            detail: "OpenAI-compatible API returned empty response",
          }),
        );
      }
      return Effect.succeed(content);
    }),
  );
}

function decodeJsonOutput<S extends Schema.Constraint>(
  raw: string,
  schema: S,
  operation: string,
): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> {
  const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(schema));
  return decodeOutput(raw).pipe(
    Effect.catchTags({
      SchemaError: (cause) =>
        Effect.fail(
          new TextGenerationError({
            operation,
            detail: "API response did not match expected schema",
            cause,
          }),
        ),
    }),
    Effect.catch((error: unknown) =>
      isTextGenerationError(error)
        ? Effect.fail(error)
        : Effect.fail(
            new TextGenerationError({
              operation,
              detail: "Failed to parse API response as JSON",
              cause: error,
            }),
          ),
    ),
  );
}

export function makeOpenAiCompatibleTextGeneration(
  apiConfig: TextGenerationApiSettings,
): TextGeneration.TextGeneration["Service"] {
  const { baseUrl, apiKey, model } = apiConfig;

  const call = (prompt: string, operation: string): Effect.Effect<string, TextGenerationError> =>
    callOpenAiCompatibleApi(baseUrl, apiKey, model, prompt, operation);

  return {
    generateCommitMessage: (input) =>
      Effect.gen(function* () {
        const { prompt, outputSchema } = buildCommitMessagePrompt({
          branch: input.branch,
          stagedSummary: input.stagedSummary,
          stagedPatch: input.stagedPatch,
          includeBranch: input.includeBranch === true,
          policy: input.policy,
        });
        const raw = yield* call(prompt, "generateCommitMessage");
        const decoded = yield* decodeJsonOutput(raw, outputSchema, "generateCommitMessage");
        return {
          subject: sanitizeCommitSubject(decoded.subject),
          body: decoded.body.trim(),
          ...("branch" in decoded && typeof decoded.branch === "string"
            ? { branch: sanitizeBranchFragment(decoded.branch) }
            : {}),
        };
      }),

    generatePrContent: (input) =>
      Effect.gen(function* () {
        const { prompt, outputSchema } = buildPrContentPrompt({
          baseBranch: input.baseBranch,
          headBranch: input.headBranch,
          commitSummary: input.commitSummary,
          diffSummary: input.diffSummary,
          diffPatch: input.diffPatch,
          changeRequestTemplate: input.changeRequestTemplate,
          policy: input.policy,
        });
        const raw = yield* call(prompt, "generatePrContent");
        const decoded = yield* decodeJsonOutput(raw, outputSchema, "generatePrContent");
        return {
          title: sanitizePrTitle(decoded.title),
          body: decoded.body.trim(),
        };
      }),

    generateBranchName: (input) =>
      Effect.gen(function* () {
        const { prompt, outputSchema } = buildBranchNamePrompt({
          message: input.message,
          attachments: input.attachments,
        });
        const raw = yield* call(prompt, "generateBranchName");
        const decoded = yield* decodeJsonOutput(raw, outputSchema, "generateBranchName");
        return {
          branch: sanitizeFeatureBranchName(String(decoded.branch)),
        };
      }),

    generateThreadTitle: (input) =>
      Effect.gen(function* () {
        const { prompt, outputSchema } = buildThreadTitlePrompt({
          linkedContext: input.linkedContext,
          message: input.message,
          previousTitle: input.previousTitle,
          attachments: input.attachments,
        });
        const raw = yield* call(prompt, "generateThreadTitle");
        const decoded = yield* decodeJsonOutput(raw, outputSchema, "generateThreadTitle");
        return {
          title: sanitizeThreadTitle(String(decoded.title)),
          needsRefinement: decoded.needsRefinement ?? false,
        };
      }),
  };
}

export function isTextGenerationApiConfigured(config: TextGenerationApiSettings): boolean {
  return (
    config.enabled &&
    config.baseUrl.length > 0 &&
    config.apiKey.length > 0 &&
    config.model.length > 0
  );
}
