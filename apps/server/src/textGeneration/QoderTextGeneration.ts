/**
 * QoderTextGeneration – Text generation layer using the Qoder Agent SDK.
 *
 * Spawns a single-turn Qoder SDK query with tools disabled and
 * `dontAsk` permission mode, collects the structured JSON result,
 * and decodes it against the caller-supplied schema.
 *
 * @module QoderTextGeneration
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { type ModelSelection, type QoderSettings, TextGenerationError } from "@lmcstools/core";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@lmcstools/core/git";
import { extractJsonObject } from "@lmcstools/core/schemaJson";

import * as TextGeneration from "./TextGeneration.ts";
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
import { query } from "@qoder-ai/qoder-agent-sdk";
import type { SDKMessage, SDKResultSuccess } from "@qoder-ai/qoder-agent-sdk";

const QODER_TEXT_GEN_TIMEOUT_MS = 120_000;

const isTextGenerationError = Schema.is(TextGenerationError);

/**
 * Build SDK auth options from QoderSettings + environment.
 * Mirrors the same logic used in QoderAdapter.
 */
function buildTextGenAuth(
  config: QoderSettings,
  environment?: NodeJS.ProcessEnv,
): { type: "accessToken"; accessToken: string } | { type: "qodercli" } {
  const pat =
    config.personalAccessToken?.trim() || environment?.QODER_PERSONAL_ACCESS_TOKEN?.trim();
  if (pat) {
    return { type: "accessToken" as const, accessToken: pat };
  }
  return { type: "qodercli" as const };
}

/**
 * Run a single-turn Qoder SDK query and return the parsed, schema-validated
 * structured output.
 */
const runQoderJson = Effect.fn("runQoderJson")(function* <S extends Schema.Top>({
  operation,
  cwd,
  prompt,
  outputSchemaJson,
  modelSelection,
  config,
  environment,
}: {
  operation:
    | "generateCommitMessage"
    | "generatePrContent"
    | "generateBranchName"
    | "generateThreadTitle";
  cwd: string;
  prompt: string;
  outputSchemaJson: S;
  modelSelection: ModelSelection;
  config: QoderSettings;
  environment: NodeJS.ProcessEnv | undefined;
}): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
  const sdkSessionId = crypto.randomUUID();
  const q = query({
    prompt,
    options: {
      auth: buildTextGenAuth(config, environment),
      cwd,
      sessionId: sdkSessionId,
      persistSession: false,
      permissionMode: "dontAsk",
      allowedTools: [],
      maxTurns: 1,
      ...(modelSelection.model ? { model: modelSelection.model } : {}),
    },
  });

  const collectResult = Effect.tryPromise({
    try: async (): Promise<string> => {
      let resultText: string | null = null;
      try {
        for await (const message of q) {
          const msg = message as SDKMessage;
          if (msg.type === "result" && (msg as SDKResultSuccess).subtype === "success") {
            resultText = (msg as SDKResultSuccess).result;
          }
        }
      } finally {
        await q.close().catch(() => {});
      }
      if (resultText === null || resultText.trim().length === 0) {
        throw new Error("Qoder SDK returned no result text.");
      }
      return resultText;
    },
    catch: (error: unknown) =>
      new TextGenerationError({
        operation,
        detail: error instanceof Error ? error.message : "Qoder SDK text generation failed.",
        cause: error,
      }),
  });

  const rawResult = yield* collectResult.pipe(
    Effect.timeoutOption(QODER_TEXT_GEN_TIMEOUT_MS),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new TextGenerationError({
              operation,
              detail: "Qoder SDK text generation timed out.",
            }),
          ),
        onSome: (value) => Effect.succeed(value),
      }),
    ),
  );

  const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson));
  return yield* decodeOutput(extractJsonObject(rawResult)).pipe(
    Effect.catchTags({
      SchemaError: (cause) =>
        Effect.fail(
          new TextGenerationError({
            operation,
            detail: "Qoder returned invalid structured output.",
            cause,
          }),
        ),
    }),
  );
});

/**
 * Build a QoderTextGeneration service closure bound to a specific
 * QoderSettings payload.
 */
export const makeQoderTextGeneration = Effect.fn("makeQoderTextGeneration")(function* (
  qoderSettings: QoderSettings,
  environment?: NodeJS.ProcessEnv,
) {
  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("QoderTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });

      const generated = yield* runQoderJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
        config: qoderSettings,
        environment,
      });

      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("QoderTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });

      const generated = yield* runQoderJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
        config: qoderSettings,
        environment,
      });

      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("QoderTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });

      const generated = yield* runQoderJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
        config: qoderSettings,
        environment,
      });

      return {
        branch: sanitizeBranchFragment(generated.branch),
      };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("QoderTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        linkedContext: input.linkedContext,
        attachments: input.attachments,
      });

      const generated = yield* runQoderJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
        config: qoderSettings,
        environment,
      });

      return {
        title: sanitizeThreadTitle(generated.title),
        ...(generated.needsRefinement ? { needsRefinement: true } : {}),
      };
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
