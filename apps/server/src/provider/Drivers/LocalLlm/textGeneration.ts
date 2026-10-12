import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { LocalLlmSettings } from "@lmcstools/core";
import { TextGenerationError } from "@lmcstools/core";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@lmcstools/core/git";

import type * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "../../textGeneration/TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "../../textGeneration/TextGenerationUtils.ts";
import { chatCompletion, type LocalLlmClientConfig } from "./httpClient.ts";

const isTextGenerationError = Schema.is(TextGenerationError);

function callApi(
  config: LocalLlmClientConfig,
  prompt: string,
  operation: string,
): Effect.Effect<string, TextGenerationError> {
  return chatCompletion(config, {
    messages: [{ role: "user", content: prompt }],
    temperature: 0.3,
    maxTokens: 2048,
  }).pipe(
    Effect.map((response) => response.content),
    Effect.flatMap((content) => {
      if (!content || content.length === 0) {
        return Effect.fail(
          new TextGenerationError({
            operation,
            detail: "Local LLM returned empty response",
          }),
        );
      }
      return Effect.succeed(content);
    }),
    Effect.catch((error: unknown) =>
      isTextGenerationError(error)
        ? Effect.fail(error)
        : Effect.fail(
            new TextGenerationError({
              operation,
              detail:
                error instanceof Error
                  ? `Local LLM API call failed: ${error.message}`
                  : "Local LLM API call failed",
              cause: error,
            }),
          ),
    ),
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

export function makeLocalLlmTextGeneration(
  settings: LocalLlmSettings,
): TextGeneration.TextGeneration["Service"] {
  const config: LocalLlmClientConfig = {
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    model: settings.model,
    apiFormat: settings.apiFormat,
  };

  const call = (prompt: string, operation: string): Effect.Effect<string, TextGenerationError> =>
    callApi(config, prompt, operation);

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
