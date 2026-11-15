//! Which shell a terminal runs, in which order the server is willing to fall back.
//!
//! Ported from `resolveShellCandidates` and its helpers in
//! `apps/server/src/terminal/Manager.ts`.

use crate::Platform;
use crate::env::Env;
use crate::jsstr::{js_first_whitespace_token, js_strip_outer_quotes, js_to_lowercase, js_trim};

/// A shell to try, with the arguments that make it usable as an interactive shell.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShellCandidate {
    pub shell: String,
    pub args: Option<Vec<String>>,
}

/// `defaultShellResolver`.
#[must_use]
pub fn default_shell_resolver(platform: Platform, env: &Env) -> String {
    if platform.is_win32() {
        return "pwsh.exe".to_string();
    }
    env.get("SHELL").unwrap_or("bash").to_string()
}

/// `normalizeShellCommand`. Windows keeps the whole command line; POSIX takes the first
/// whitespace-separated token and removes one quote from each end.
#[must_use]
pub fn normalize_shell_command(value: Option<&str>, platform: Platform) -> Option<String> {
    let value = value?;
    if value.is_empty() {
        return None;
    }
    let trimmed = js_trim(value);
    if trimmed.is_empty() {
        return None;
    }
    if platform.is_win32() {
        return Some(trimmed.to_string());
    }
    let first_token = js_trim(js_first_whitespace_token(trimmed));
    if first_token.is_empty() {
        return None;
    }
    Some(js_strip_outer_quotes(first_token).to_string())
}

/// `basenameForPlatform`. Separators only count on the platform they belong to, so a
/// Windows path on POSIX is one long file name.
#[must_use]
pub fn basename_for_platform(command: &str, platform: Platform) -> String {
    let normalized: String = if platform.is_win32() {
        command.replace('/', "\\")
    } else {
        command.replace('\\', "/")
    };
    let parts: Vec<&str> = if platform.is_win32() {
        normalized
            .split('\\')
            .filter(|part| !part.is_empty())
            .collect()
    } else {
        normalized
            .split('/')
            .filter(|part| !part.is_empty())
            .collect()
    };
    parts
        .last()
        .map_or_else(|| normalized.clone(), |last| (*last).to_string())
}

/// `joinWindowsPath`.
#[must_use]
pub fn join_windows_path(parts: &[&str]) -> String {
    let cleaned: Vec<String> = parts
        .iter()
        .enumerate()
        .map(|(index, part)| {
            if index == 0 {
                part.trim_end_matches(['/', '\\']).to_string()
            } else {
                part.trim_matches(['/', '\\']).to_string()
            }
        })
        .filter(|part| !part.is_empty())
        .collect();
    cleaned.join("\\")
}

/// `shellCandidateFromCommand`. The arguments exist because PowerShell prints a banner and
/// zsh echoes the prompt for every line of a pasted block.
#[must_use]
pub fn shell_candidate_from_command(
    command: Option<&str>,
    platform: Platform,
) -> Option<ShellCandidate> {
    let command = command?;
    if command.is_empty() {
        return None;
    }
    let shell_name = js_to_lowercase(&basename_for_platform(command, platform));
    if platform.is_win32() && (shell_name == "pwsh.exe" || shell_name == "powershell.exe") {
        return Some(ShellCandidate {
            shell: command.to_string(),
            args: Some(vec!["-NoLogo".to_string()]),
        });
    }
    if !platform.is_win32() && shell_name == "zsh" {
        return Some(ShellCandidate {
            shell: command.to_string(),
            args: Some(vec!["-o".to_string(), "nopromptsp".to_string()]),
        });
    }
    Some(ShellCandidate {
        shell: command.to_string(),
        args: None,
    })
}

/// `windowsSystemRoot`. `||` chains on a trimmed string, so a whitespace-only value falls
/// through to the next variable rather than producing a path below a blank root.
fn windows_system_root(env: &Env) -> String {
    for key in ["SystemRoot", "windir"] {
        let trimmed = js_trim(env.get(key).unwrap_or("")).to_string();
        if !trimmed.is_empty() {
            return trimmed;
        }
    }
    "C:\\Windows".to_string()
}

/// `windowsPowerShellPath`.
fn windows_powershell_path(env: &Env) -> String {
    join_windows_path(&[
        &windows_system_root(env),
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
    ])
}

/// `windowsCmdPath`.
fn windows_cmd_path(env: &Env) -> String {
    join_windows_path(&[&windows_system_root(env), "System32", "cmd.exe"])
}

/// `formatShellCandidate`. This string is what the user sees when every shell failed.
#[must_use]
pub fn format_shell_candidate(candidate: &ShellCandidate) -> String {
    match &candidate.args {
        Some(args) if !args.is_empty() => format!("{} {}", candidate.shell, args.join(" ")),
        _ => candidate.shell.clone(),
    }
}

/// `uniqueShellCandidates`. Deduplicated by the formatted command, so `/bin/sh` and a
/// requested `/bin/sh` collapse but `zsh` and `/bin/zsh` do not.
///
/// Deduplicating by the shell path alone would be equivalent here, and no test can tell
/// the two apart: the arguments are a function of the shell name and the platform, so two
/// candidates with the same path always carry the same arguments.
#[must_use]
pub fn unique_shell_candidates(
    candidates: impl IntoIterator<Item = Option<ShellCandidate>>,
) -> Vec<ShellCandidate> {
    let mut seen: Vec<String> = Vec::new();
    let mut ordered: Vec<ShellCandidate> = Vec::new();
    for candidate in candidates.into_iter().flatten() {
        let key = format_shell_candidate(&candidate);
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        ordered.push(candidate);
    }
    ordered
}

/// `resolveShellCandidates`, given what the shell resolver returned.
#[must_use]
pub fn resolve_shell_candidates(
    resolved_shell: &str,
    platform: Platform,
    env: &Env,
) -> Vec<ShellCandidate> {
    let requested = shell_candidate_from_command(
        normalize_shell_command(Some(resolved_shell), platform).as_deref(),
        platform,
    );

    if platform.is_win32() {
        return unique_shell_candidates([
            requested,
            shell_candidate_from_command(Some("pwsh.exe"), platform),
            shell_candidate_from_command(Some(windows_powershell_path(env).as_str()), platform),
            shell_candidate_from_command(Some("powershell.exe"), platform),
            shell_candidate_from_command(env.get("ComSpec"), platform),
            shell_candidate_from_command(Some(windows_cmd_path(env).as_str()), platform),
            shell_candidate_from_command(Some("cmd.exe"), platform),
        ]);
    }

    unique_shell_candidates([
        requested,
        shell_candidate_from_command(
            normalize_shell_command(env.get("SHELL"), platform).as_deref(),
            platform,
        ),
        shell_candidate_from_command(Some("/bin/zsh"), platform),
        shell_candidate_from_command(Some("/bin/bash"), platform),
        shell_candidate_from_command(Some("/bin/sh"), platform),
        shell_candidate_from_command(Some("zsh"), platform),
        shell_candidate_from_command(Some("bash"), platform),
        shell_candidate_from_command(Some("sh"), platform),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> Env {
        Env::from_pairs(
            pairs
                .iter()
                .map(|(key, value)| ((*key).to_string(), (*value).to_string())),
        )
    }

    fn labels(candidates: &[ShellCandidate]) -> Vec<String> {
        candidates.iter().map(format_shell_candidate).collect()
    }

    #[test]
    fn posix_fallback_order_is_absolute_paths_then_bare_names() {
        assert_eq!(
            labels(&resolve_shell_candidates(
                "bash",
                Platform::Linux,
                &env(&[("SHELL", "/usr/bin/zsh")])
            )),
            [
                "bash",
                "/usr/bin/zsh -o nopromptsp",
                "/bin/zsh -o nopromptsp",
                "/bin/bash",
                "/bin/sh",
                "zsh -o nopromptsp",
                "sh",
            ]
        );
    }

    #[test]
    fn windows_fallback_resolves_absolute_paths_from_the_environment() {
        assert_eq!(
            labels(&resolve_shell_candidates(
                "cmd.exe",
                Platform::Win32,
                &env(&[("SystemRoot", "D:\\sys\\")])
            )),
            [
                "cmd.exe",
                "pwsh.exe -NoLogo",
                "D:\\sys\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoLogo",
                "powershell.exe -NoLogo",
                "D:\\sys\\System32\\cmd.exe",
            ]
        );
    }

    #[test]
    fn basename_separators_are_platform_specific() {
        // Both branches fold the other platform's separator into their own before
        // splitting, so a Windows path on POSIX still yields a basename — which is why a
        // `C:\...\cmd.exe` in `$SHELL` on Linux is offered as a candidate without arguments.
        assert_eq!(
            basename_for_platform("C:\\a\\b\\pwsh.exe", Platform::Linux),
            "pwsh.exe"
        );
        assert_eq!(
            basename_for_platform("C:/a/b/pwsh.exe", Platform::Win32),
            "pwsh.exe"
        );
        // The only thing the platform switch decides is the spelling of the fallback for a
        // name made of nothing but separators.
        assert_eq!(basename_for_platform("///", Platform::Linux), "///");
        assert_eq!(basename_for_platform("///", Platform::Win32), "\\\\\\");
    }

    #[test]
    fn joining_windows_paths_trims_separators_and_drops_empties() {
        assert_eq!(
            join_windows_path(&["C:\\Windows\\", "\\System32", "", "cmd.exe"]),
            "C:\\Windows\\System32\\cmd.exe"
        );
        assert_eq!(join_windows_path(&["C:\\Windows///"]), "C:\\Windows");
        assert_eq!(join_windows_path(&["/", "/"]), "");
    }

    #[test]
    fn a_blank_root_falls_through_to_the_default() {
        assert_eq!(
            windows_system_root(&env(&[("SystemRoot", "   "), ("windir", "E:\\windows")])),
            "E:\\windows"
        );
        assert_eq!(windows_system_root(&env(&[])), "C:\\Windows");
    }
}
