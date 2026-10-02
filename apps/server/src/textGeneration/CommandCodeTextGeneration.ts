/**
 * CommandCodeTextGeneration — Text generation layer using the Command Code CLI.
 *
 * Spawns `cmd -p "prompt" --output-format json` for each generation request,
 * parses the JSON result, and decodes it against the caller-supplied schema.
 *
 * @module CommandCodeTextGeneration
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnCommand } from "@lmcstools/core/shell";

import {
  type CommandCodeSettings,
  type ModelSelection,
  TextGenerationError,
} from "@lmcstools/core";
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
import { spawnAndCollect } from "../provider/providerSnapshot.ts";

function buildCmdAuthEnv(
  config: CommandCodeSettings,
  environment?: NodeJS.ProcessEnv,
): Record<string, string | undefined> {
  const apiKey = config.apiKey?.trim() || environment?.COMMAND_CODE_API_KEY?.trim();
  if (apiKey) {
    return { COMMAND_CODE_API_KEY: apiKey };
  }
  return {};
}

/**
 * Build a CommandCodeTextGeneration service closure bound to a specific
 * CommandCodeSettings payload.
 */
export const makeCommandCodeTextGeneration = Effect.fn("makeCommandCodeTextGeneration")(function* (
  cmdSettings: CommandCodeSettings,
  environment?: NodeJS.ProcessEnv,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const runCmd = <S extends Schema.Top>(params: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ModelSelection;
  }) =>
    Effect.gen(function* () {
      const binaryPath = cmdSettings.binaryPath?.trim() || "cmd";
      const authEnv = buildCmdAuthEnv(cmdSettings, environment);

      const args = [
        "-p",
        params.prompt,
        "--output-format",
        "json",
        "--yolo",
        "--skip-onboarding",
        "--max-turns",
        "1",
        ...(params.modelSelection.model ? ["-m", params.modelSelection.model] : []),
      ];

      const spawnCommand = yield* resolveSpawnCommand(binaryPath, args, {
        env: { ...process.env, ...authEnv },
      });

      const result = yield* spawnAndCollect(
        binaryPath,
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          env: { ...process.env, ...authEnv },
          cwd: params.cwd,
          shell: spawnCommand.shell,
        }),
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.catchTag("PlatformError", (error) =>
          Effect.fail(
            new TextGenerationError({
              operation: params.operation,
              detail: `Failed to spawn Command Code CLI: ${error.message ?? String(error)}`,
              cause: error,
            }),
          ),
        ),
        Effect.catchTag("ProviderCommandNotFoundError", (error) =>
          Effect.fail(
            new TextGenerationError({
              operation: params.operation,
              detail: `Command Code CLI not found: ${error.binaryPath}`,
            }),
          ),
        ),
      );

      if (result.code !== 0) {
        return yield* new TextGenerationError({
          operation: params.operation,
          detail: `Command Code CLI exited with code ${result.code}: ${result.stderr.slice(0, 500)}`,
        });
      }

      const rawOutput = result.stdout.trim();
      if (!rawOutput) {
        return yield* new TextGenerationError({
          operation: params.operation,
          detail: "Command Code CLI returned no output.",
        });
      }

      // Parse the JSON result from the output
      const lines = rawOutput.split("\n");
      let resultText: string | null = null;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (typeof parsed === "object" && parsed !== null) {
            if (
              parsed.type === "result" &&
              parsed.subtype === "success" &&
              typeof parsed.result === "string"
            ) {
              resultText = parsed.result;
            }
          }
        } catch {
          // Not JSON, skip
        }
      }

      // Fallback: try to parse the entire output as JSON
      if (!resultText) {
        try {
          const parsed = JSON.parse(rawOutput);
          if (typeof parsed === "object" && parsed !== null && typeof parsed.result === "string") {
            resultText = parsed.result;
          }
        } catch {
          // Not JSON
        }
      }

      // Fallback: use raw output as the result text
      if (!resultText) {
        resultText = rawOutput;
      }

      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(params.outputSchemaJson));
      return yield* decodeOutput(extractJsonObject(resultText)).pipe(
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation: params.operation,
                detail: "Command Code returned invalid structured output.",
                cause,
              }),
            ),
        }),
      );
    });

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("CommandCodeTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });

      const generated = yield* runCmd({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
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
    Effect.fn("CommandCodeTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });

      const generated = yield* runCmd({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("CommandCodeTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });

      const generated = yield* runCmd({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        branch: sanitizeBranchFragment(generated.branch),
      };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("CommandCodeTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        linkedContext: input.linkedContext,
        attachments: input.attachments,
      });

      const generated = yield* runCmd({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
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
