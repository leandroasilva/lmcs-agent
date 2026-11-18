//! The joining `Path.layer` hands the shipped code. The layer is host-native, so on the
//! machine these reads were measured on it is `path.posix`, which is what `opencode`'s
//! `auth.json` path and `claude_credits`' account path are built from. A Windows spelling
//! would be read here as one directory name containing backslashes, and that is the answer
//! the golden records because it is the answer the shipped code gives.

/// `path.posix.join`: non-empty segments joined with `/` and then normalised, so empty and `.`
/// segments disappear, `..` pops one segment and is dropped at the root, a leading `/` is kept,
/// and nothing else is special — a `~` is an ordinary directory name and a space is a segment
/// like any other.
#[must_use]
pub fn posix_join(parts: &[&str]) -> String {
    // An empty segment is skipped rather than separated, which is what keeps a home of `""`
    // from turning the path absolute.
    let mut joined = String::new();
    for part in parts {
        if part.is_empty() {
            continue;
        }
        if !joined.is_empty() {
            joined.push('/');
        }
        joined.push_str(part);
    }
    posix_normalize(&joined)
}

/// `path.posix.normalize`.
#[must_use]
pub fn posix_normalize(path: &str) -> String {
    let absolute = path.starts_with('/');
    let trailing_separator = path.ends_with('/');
    let mut segments: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => match segments.last() {
                Some(last) if *last != ".." => {
                    segments.pop();
                }
                _ if absolute => {}
                _ => segments.push(".."),
            },
            other => segments.push(other),
        }
    }
    let mut joined = segments.join("/");
    if joined.is_empty() && !absolute {
        joined = ".".to_owned();
    }
    if trailing_separator && !joined.is_empty() {
        joined.push('/');
    }
    if absolute {
        format!("/{joined}")
    } else {
        joined
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joining_follows_the_posix_rules_the_shipped_layer_uses() {
        assert_eq!(posix_join(&["", ".local", "share"]), ".local/share");
        assert_eq!(posix_join(&[]), ".");
        assert_eq!(
            posix_join(&["/xdg", "opencode", "auth.json"]),
            "/xdg/opencode/auth.json"
        );
        assert_eq!(posix_join(&["a", ".", "b"]), "a/b");
        assert_eq!(posix_join(&["/a/b", "..", "c"]), "/a/c");
        assert_eq!(posix_join(&["/a", "..", ".."]), "/");
        assert_eq!(posix_join(&["~", ".config"]), "~/.config");
        assert_eq!(
            posix_join(&["/cfg with space", ".claude.json"]),
            "/cfg with space/.claude.json"
        );
    }

    #[test]
    fn normalising_keeps_the_absolute_and_the_trailing_separator() {
        assert_eq!(posix_normalize("/a//b/"), "/a/b/");
        // More than one leading separator is still one: POSIX leaves exactly two slashes to the
        // implementation and Node does not use them.
        assert_eq!(posix_normalize("//a"), "/a");
        assert_eq!(posix_normalize("///a"), "/a");
        assert_eq!(posix_normalize("/"), "/");
        assert_eq!(posix_normalize("a/"), "a/");
        assert_eq!(posix_normalize("a/../b"), "b");
        assert_eq!(posix_normalize("../a"), "../a");
        assert_eq!(posix_normalize("a/../.."), "..");
        assert_eq!(posix_normalize(""), ".");
    }
}
