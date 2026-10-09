/**
 * Qoder runtime — credential helpers shared by the adapter and the probes.
 *
 * Qoder is a CLI-only provider: every turn spawns `qoder -p …`. The adapter and
 * the status probes must build that process environment in exactly the same
 * way, otherwise a probe can validate one credential while turns run with
 * another and the UI reports a healthy provider whose every turn fails.
 *
 * @module provider/qoderRuntime
 */
import type { QoderSettings } from "@lmcstools/core";

/** Environment variable the Qoder CLI reads for a personal access token. */
export const QODER_PAT_ENV = "QODER_PERSONAL_ACCESS_TOKEN";

/** Browser-login profile written by `qoder` then `/login`, relative to $HOME. */
export const QODER_AUTH_FILE = ".qoder/.auth/user";

/**
 * Credential to hand the Qoder CLI, if any.
 *
 * A configured PAT takes precedence over the ambient environment, mirroring the
 * CLI's own behaviour: `QODER_PERSONAL_ACCESS_TOKEN` overrides any saved login.
 */
export function buildQoderAuthEnv(
  config: QoderSettings,
  environment?: NodeJS.ProcessEnv,
): Record<string, string | undefined> {
  const pat = config.personalAccessToken?.trim() || environment?.[QODER_PAT_ENV]?.trim();
  if (pat) {
    return { [QODER_PAT_ENV]: pat };
  }
  return {};
}

/** Ambient environment plus the configured credential, for spawning `qoder`. */
export function mergeQoderEnv(
  environment: NodeJS.ProcessEnv,
  config: QoderSettings,
): NodeJS.ProcessEnv {
  return { ...environment, ...buildQoderAuthEnv(config, environment) };
}

/** The configured PAT, from settings or the environment, if there is one. */
export function resolveQoderPat(
  config: QoderSettings,
  environment?: NodeJS.ProcessEnv,
): string | undefined {
  return config.personalAccessToken?.trim() || environment?.[QODER_PAT_ENV]?.trim() || undefined;
}

/**
 * Substring the CLI emits when it refuses a configured PAT.
 *
 * Both surfaces carry it — `qoder -p` reports
 * "QoderAuthError: The QODER_PERSONAL_ACCESS_TOKEN environment variable
 * contains a token that was rejected …" and `qoder --list-models` reports
 * "Failed to fetch model list: The QODER_PERSONAL_ACCESS_TOKEN environment
 * variable contains a token that was rejected …" — so matching the shared tail
 * covers both without pinning either prefix.
 */
const QODER_PAT_REJECTED_MARKER = "contains a token that was rejected";

/**
 * True when the CLI rejected the configured PAT.
 *
 * Worth distinguishing from a generic failure because a rejected PAT is worse
 * than no credential at all: the CLI states it "overrides any saved login", so
 * a stale token silently breaks an otherwise working browser login.
 */
export function isQoderPatRejected(output: string): boolean {
  return output.includes(QODER_PAT_REJECTED_MARKER);
}

/**
 * The CLI's own explanation of a rejected PAT, for surfacing to the user.
 * Returns null when the output is not a rejection.
 */
export function qoderPatRejectionDetail(output: string): string | null {
  if (!isQoderPatRejected(output)) {
    return null;
  }
  const line = output
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.includes(QODER_PAT_REJECTED_MARKER));
  if (!line) {
    return "The Qoder personal access token was rejected.";
  }
  // Drop the CLI's own operation prefix so the message reads as a reason.
  return line
    .replace(/^(?:Failed to fetch model list:\s*)?/, "")
    .replace(/^QoderAuthError:\s*/, "");
}
