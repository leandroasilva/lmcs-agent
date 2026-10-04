import * as Option from "effect/Option";

export type JoinPath = (first: string, ...segments: string[]) => string;

function normalizeConfiguredBaseDir(lmcsHome: Option.Option<string>): Option.Option<string> {
  if (Option.isNone(lmcsHome)) {
    return Option.none();
  }
  const trimmed = lmcsHome.value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
}

export function resolveDesktopBaseDir(input: {
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly lmcsHome: Option.Option<string>;
}): string {
  return Option.getOrElse(normalizeConfiguredBaseDir(input.lmcsHome), () =>
    input.joinPath(input.homeDirectory, ".lmcs"),
  );
}

export function resolveDesktopStateDir(input: {
  readonly baseDir: string;
  readonly isDevelopment: boolean;
  readonly joinPath: JoinPath;
  readonly lmcsHome: Option.Option<string>;
}): string {
  const useDevSubdir =
    input.isDevelopment && Option.isNone(normalizeConfiguredBaseDir(input.lmcsHome));
  return input.joinPath(input.baseDir, useDevSubdir ? "dev" : "userdata");
}
