//! The authorization table: which scope each rpc demands, and what a token without it is told.
//!
//! Ported from `apps/server/src/auth/RpcAuthorization.ts:24-193`. The table is `as const satisfies
//! Record<WsRpcMethod, AuthEnvironmentScope>`, so TypeScript already guarantees every rpc of the group is
//! listed; what this module has to keep is the **listing order** (which is what the golden compares) and
//! the rule that a method absent from it is a `throw`, not a refusal.
//!
//! That throw is worth stating plainly, because it is the one entry in this file that never arrives as a
//! reply: `requiredScopeForRpcMethod` raises a plain `Error` (`RpcAuthorization.ts:180`), which in Effect is
//! a **defect** — it does not match `Effect.catchTags`, so it leaves the request unanswered. What the client
//! does get is the broadcast `Defect` frame, which carries no `requestId` at all, and then silence:
//! `scope-golden.ts` measured a connection that stayed open and never answered again. A port that returns a
//! typed "unknown method" here would be inventing a response the TypeScript never sends. `Object.hasOwn` is
//! the gate, which is why the inherited name `toString` throws too, and why a Rust lookup in a fixed array
//! reproduces the whole rule for free.
//!
//! The scopes themselves are plain strings, not an enum, for a measured reason: the union reachable through
//! the table is seven names and `access:write` is **not** among them, while the contract's
//! `AuthEnvironmentScope` admits more. The predicate is `scopes.includes(required)`
//! (`EnvironmentAuth.ts`'s check), with no hierarchy — holding `orchestration:operate` buys nothing
//! towards `orchestration:read`.
//!
//! The dispatch half — [`Decision`], [`authorize`], [`authorize_device_list`] — is measured by
//! `apps/server/scripts/scope-golden.ts`, and it records three facts this file now has to keep: a refusal
//! is an `Exit`/`Failure`/`Fail` carrying the error below, for **streams as much as for effects**; a
//! method missing from the table is answered outside every request and the connection then stops answering
//! anything; and `device.list` with `inspectOnly` runs with no scope at all.

use serde_json::Value;

/// Every declared method, in the order the object literal declares them, which is the order
/// `Object.entries` yields and therefore the order `auth-golden.ts` recorded.
pub static RPC_REQUIRED_SCOPES: [(&str, &str); 147] = [
    ("orchestration.dispatchCommand", "orchestration:operate"),
    ("orchestration.getWorkflowScript", "orchestration:read"),
    ("orchestration.getTurnDiff", "orchestration:read"),
    ("orchestration.getFullThreadDiff", "orchestration:read"),
    ("orchestration.searchThreads", "orchestration:read"),
    ("orchestration.subscribeShell", "orchestration:read"),
    (
        "orchestration.getArchivedShellSnapshot",
        "orchestration:read",
    ),
    ("orchestration.subscribeThread", "orchestration:read"),
    ("server.probe", "orchestration:read"),
    ("server.getConfig", "orchestration:read"),
    ("server.refreshProviders", "orchestration:operate"),
    ("server.updateProvider", "orchestration:operate"),
    ("provider.auth.start", "orchestration:operate"),
    ("provider.consumeResetCredit", "orchestration:operate"),
    ("provider.auth.complete", "orchestration:operate"),
    ("provider.auth.respond", "orchestration:operate"),
    ("provider.auth.cancel", "orchestration:operate"),
    ("provider.auth.logout", "orchestration:operate"),
    ("provider.auth.subscribe", "orchestration:operate"),
    ("provider.install.start", "orchestration:operate"),
    ("provider.install.cancel", "orchestration:operate"),
    ("provider.install.subscribe", "orchestration:read"),
    ("provider.install.remove", "orchestration:operate"),
    ("server.updateServer", "orchestration:operate"),
    ("server.updateServerWithProgress", "orchestration:operate"),
    ("server.commitDesktopUpdate", "orchestration:operate"),
    ("server.upsertKeybinding", "orchestration:operate"),
    ("server.removeKeybinding", "orchestration:operate"),
    ("server.getSettings", "orchestration:read"),
    ("server.updateSettings", "orchestration:operate"),
    ("server.discoverSourceControl", "orchestration:read"),
    ("server.getTraceDiagnostics", "orchestration:read"),
    ("server.getProcessDiagnostics", "orchestration:read"),
    ("server.getHostResources", "orchestration:read"),
    ("server.getProcessResourceHistory", "orchestration:read"),
    ("server.getResourceTelemetryHistory", "orchestration:read"),
    ("server.retryResourceTelemetry", "orchestration:operate"),
    ("server.getUsageSummary", "orchestration:read"),
    ("server.refreshUsageRates", "orchestration:read"),
    ("server.signalProcess", "orchestration:operate"),
    ("server.reportClientActivity", "orchestration:read"),
    ("server.reportHostPowerState", "orchestration:operate"),
    ("server.getBackgroundPolicy", "orchestration:read"),
    ("cloud.getRelayClientStatus", "relay:read"),
    ("cloud.installRelayClient", "relay:write"),
    ("pullRequests.list", "orchestration:read"),
    ("pullRequests.listStats", "orchestration:read"),
    ("pullRequests.summary", "orchestration:read"),
    ("pullRequests.routing", "orchestration:read"),
    ("pullRequests.routingIdentity", "orchestration:read"),
    ("pullRequests.stack", "orchestration:read"),
    ("pullRequests.linkedThreads", "orchestration:read"),
    ("pullRequests.detail", "orchestration:read"),
    ("pullRequests.preview", "orchestration:read"),
    ("pullRequests.activity", "orchestration:read"),
    ("pullRequests.threadComments", "orchestration:read"),
    ("pullRequests.diffFileContents", "orchestration:read"),
    ("pullRequests.filesViewed", "orchestration:read"),
    ("pullRequests.runAction", "orchestration:operate"),
    ("pullRequests.update", "orchestration:operate"),
    ("pullRequests.comment", "orchestration:operate"),
    ("pullRequests.updateComment", "orchestration:operate"),
    ("pullRequests.submitReview", "orchestration:operate"),
    ("pullRequests.replyToThread", "orchestration:operate"),
    ("pullRequests.setThreadResolution", "orchestration:operate"),
    ("pullRequests.setReaction", "orchestration:operate"),
    ("pullRequests.setFilesViewed", "orchestration:operate"),
    ("pullRequests.invalidate", "orchestration:read"),
    ("pullRequests.subscribeRefreshes", "orchestration:read"),
    ("pullRequests.reviewerCandidates", "orchestration:read"),
    ("pullRequests.requestReviewers", "orchestration:operate"),
    ("pullRequests.labelCandidates", "orchestration:read"),
    ("pullRequests.setLabels", "orchestration:operate"),
    ("sourceControl.lookupRepository", "orchestration:read"),
    ("sourceControl.cloneRepository", "orchestration:operate"),
    ("sourceControl.publishRepository", "orchestration:operate"),
    ("projectClone.start", "orchestration:operate"),
    ("projectClone.cancel", "orchestration:operate"),
    ("projectClone.retry", "orchestration:operate"),
    ("subscribeProjectClones", "orchestration:read"),
    ("projects.listEntries", "orchestration:read"),
    ("projects.readFile", "orchestration:read"),
    ("projects.searchContents", "orchestration:read"),
    ("projects.searchEntries", "orchestration:read"),
    ("projects.writeFile", "orchestration:operate"),
    ("shell.openInEditor", "orchestration:operate"),
    ("filesystem.browse", "orchestration:read"),
    ("filesystem.mkdir", "orchestration:operate"),
    ("agentSessions.scan", "orchestration:read"),
    ("agentSessions.import", "orchestration:operate"),
    ("assets.createUrl", "orchestration:read"),
    ("attachments.createUploadUrl", "orchestration:operate"),
    ("attachments.delete", "orchestration:operate"),
    ("provider.uploadFeedback", "orchestration:operate"),
    ("subscribeVcsStatus", "orchestration:read"),
    ("subscribeWorktreeSetup", "orchestration:read"),
    ("worktreeSetup.cancel", "orchestration:operate"),
    ("subscribeResourceTelemetry", "orchestration:read"),
    ("vcs.refreshStatus", "orchestration:read"),
    ("vcs.pull", "orchestration:operate"),
    ("git.runStackedAction", "orchestration:operate"),
    ("git.resolvePullRequest", "orchestration:operate"),
    ("git.preparePullRequestThread", "orchestration:operate"),
    ("git.generateCommitMessage", "orchestration:operate"),
    ("vcs.listRefs", "orchestration:read"),
    ("vcs.createWorktree", "orchestration:operate"),
    ("vcs.removeWorktree", "orchestration:operate"),
    ("vcs.createRef", "orchestration:operate"),
    ("vcs.switchRef", "orchestration:operate"),
    ("vcs.init", "orchestration:operate"),
    ("review.getDiffPreview", "review:write"),
    ("review.getDiffFileContents", "review:write"),
    ("terminal.open", "terminal:operate"),
    ("terminal.attach", "terminal:operate"),
    ("terminal.write", "terminal:operate"),
    ("terminal.resize", "terminal:operate"),
    ("terminal.clear", "terminal:operate"),
    ("terminal.restart", "terminal:operate"),
    ("terminal.close", "terminal:operate"),
    ("subscribeTerminalEvents", "terminal:operate"),
    ("subscribeTerminalMetadata", "terminal:operate"),
    ("preview.open", "orchestration:operate"),
    ("preview.navigate", "orchestration:operate"),
    ("preview.resize", "orchestration:operate"),
    ("preview.refresh", "orchestration:operate"),
    ("preview.close", "orchestration:operate"),
    ("preview.list", "orchestration:read"),
    ("preview.reportStatus", "orchestration:operate"),
    ("previewAutomation.connect", "orchestration:operate"),
    ("previewAutomation.respond", "orchestration:operate"),
    ("previewAutomation.focusHost", "orchestration:operate"),
    ("subscribePreviewEvents", "orchestration:read"),
    ("subscribeDiscoveredLocalServers", "orchestration:read"),
    ("device.configure", "orchestration:operate"),
    ("device.testHost", "orchestration:operate"),
    ("device.list", "orchestration:read"),
    ("device.open", "orchestration:operate"),
    ("device.close", "orchestration:operate"),
    ("device.shutdown", "orchestration:operate"),
    ("device.detail", "orchestration:read"),
    ("device.action", "orchestration:operate"),
    ("subscribeDeviceState", "orchestration:read"),
    ("subscribeServerConfig", "orchestration:read"),
    ("subscribeServerLifecycle", "orchestration:read"),
    ("subscribeAuthAccess", "access:read"),
    ("subscribeBackgroundPolicy", "orchestration:read"),
    ("subscribeProviderRuntimeEvents", "orchestration:read"),
];

/// A method the table does not declare. The TypeScript throws a plain `Error`, i.e. a defect, so this is
/// the shape of the message that appears in the server log and never on the wire.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UndeclaredScope {
    pub method: String,
}

impl UndeclaredScope {
    /// Byte-for-byte `RpcAuthorization.ts:180`'s message, which `auth-golden.ts` recorded as
    /// `Error:RPC method no.such.method has no declared authorization scope.`
    #[must_use]
    pub fn message(&self) -> String {
        format!(
            "RPC method {} has no declared authorization scope.",
            self.method
        )
    }
}

/// The scope an rpc needs.
///
/// # Errors
///
/// [`UndeclaredScope`] when the method is not in the table, which the TypeScript treats as a defect.
pub fn required_scope(method: &str) -> Result<&'static str, UndeclaredScope> {
    RPC_REQUIRED_SCOPES
        .iter()
        .find(|(declared, _)| *declared == method)
        .map(|(_, scope)| *scope)
        .ok_or_else(|| UndeclaredScope {
            method: method.to_owned(),
        })
}

/// `input.retryHostId || input.updateTool` is JavaScript truthiness, so an empty string is "not there" and
/// decides `deviceList` alone, the one method whose scope depends on its payload.
#[must_use]
pub const fn required_scope_for_device_list(
    retry_host_id: Option<&str>,
    update_tool: Option<&str>,
) -> &'static str {
    let retrying = match retry_host_id {
        Some(value) => !value.is_empty(),
        None => false,
    };
    let updating = match update_tool {
        Some(value) => !value.is_empty(),
        None => false,
    };
    if retrying || updating {
        "orchestration:operate"
    } else {
        "orchestration:read"
    }
}

/// `scopes.includes(required)`: one exact name, no ordering, no implication between read and operate.
///
/// Generic over the element because the table's callers hold both `&[&str]` (a literal, in the tests) and
/// `&[String]` (the session's credentials, owned, on every request); a port that copied the array to a
/// `Vec<&str>` per request would be paying for a TypeScript convenience that only exists because its
/// scopes came out of JSON.
#[must_use]
pub fn grants<S: AsRef<str>>(scopes: &[S], required: &str) -> bool {
    scopes.iter().any(|scope| scope.as_ref() == required)
}

/// What `ws.ts:619-652` decided about one request, before its handler ran.
///
/// The order is the shipped one and it is the whole claim: `requiredScopeForRpcMethod(method)` is an
/// *argument* to `authorizeEffect`, so a method the table does not cover throws while the effect is being
/// built — the session's scopes are never consulted, and the throw is not a refusal.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Decision {
    /// The gate let the request through, which is the only branch that runs a handler.
    Granted,
    /// The credential is good and the scope is not: a typed failure, in the request's own answer.
    Refused { required: &'static str },
    /// The table has no entry, so `Error` was raised outside every request — the broadcast `Defect`, and
    /// with it the end of the connection's willingness to answer.
    Undeclared(UndeclaredScope),
}

impl Decision {
    /// Did the handler run?
    #[must_use]
    pub fn granted(&self) -> bool {
        matches!(self, Self::Granted)
    }
}

/// The gate for every method but one: look the scope up, then compare it against the session's.
#[must_use]
pub fn authorize<S: AsRef<str>>(scopes: &[S], method: &str) -> Decision {
    let required = match required_scope(method) {
        Err(undeclared) => return Decision::Undeclared(undeclared),
        Ok(required) => required,
    };
    if grants(scopes, required) {
        Decision::Granted
    } else {
        Decision::Refused { required }
    }
}

/// `ws.ts:3513-3529`, `device.list` — the one method whose scope comes out of its payload, and the only
/// branch in the whole dispatch that reaches a handler without passing the gate.
///
/// Three answers, in this order: `input.inspectOnly && !input.updateTool` returns early, so an
/// inspection needs no scope at all *unless* it also asked to update a tool; otherwise the payload decides
/// between read and operate ([`required_scope_for_device_list`]). `inspect_only` is a `bool` here rather
/// than a `Value` because the rpc declares `Schema.optional(Schema.Boolean)` and the contract layer has
/// already said what anything else decodes to; the `updateTool` test is JavaScript truthiness, so an empty
/// string is falsy and does not buy the early return.
#[must_use]
pub fn authorize_device_list<S: AsRef<str>>(
    scopes: &[S],
    inspect_only: bool,
    retry_host_id: Option<&str>,
    update_tool: Option<&str>,
) -> Decision {
    let updating = update_tool.is_some_and(|value| !value.is_empty());
    if inspect_only && !updating {
        return Decision::Granted;
    }
    let required = required_scope_for_device_list(retry_host_id, update_tool);
    if grants(scopes, required) {
        Decision::Granted
    } else {
        Decision::Refused { required }
    }
}

/// The body a client reads when the credential is good and the scope is not
/// (`packages/core/src/contracts/auth.ts`'s `EnvironmentAuthorizationError`). The message repeats the
/// scope, so both fields have to move together, and the three keys are in the order the schema's field
/// declaration writes them — which `scope-golden.ts` confirmed on the wire.
#[must_use]
pub fn authorization_error_value(required: &str) -> Value {
    let mut fields = serde_json::Map::new();
    fields.insert(
        "_tag".to_owned(),
        Value::String("EnvironmentAuthorizationError".to_owned()),
    );
    fields.insert(
        "message".to_owned(),
        Value::String(format!(
            "The authenticated token is missing required scope: {required}."
        )),
    );
    fields.insert(
        "requiredScope".to_owned(),
        Value::String(required.to_owned()),
    );
    Value::Object(fields)
}

/// The same body as JSON text, for a log line or a golden that compares strings.
#[must_use]
pub fn authorization_error(required: &str) -> String {
    crate::json::stringify(&authorization_error_value(required))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_table_is_the_measured_size_and_order() {
        assert_eq!(RPC_REQUIRED_SCOPES.len(), 147);
        assert_eq!(
            RPC_REQUIRED_SCOPES[0],
            ("orchestration.dispatchCommand", "orchestration:operate")
        );
        assert_eq!(
            *RPC_REQUIRED_SCOPES.last().unwrap(),
            ("subscribeProviderRuntimeEvents", "orchestration:read")
        );
    }

    /// Seven names, and `access:write` is not one of them even though the contract defines it.
    #[test]
    fn the_distinct_scopes_are_the_measured_seven() {
        let mut distinct: Vec<&str> = RPC_REQUIRED_SCOPES
            .iter()
            .map(|(_, scope)| *scope)
            .collect();
        distinct.sort_unstable();
        distinct.dedup();
        assert_eq!(
            distinct,
            [
                "access:read",
                "orchestration:operate",
                "orchestration:read",
                "relay:read",
                "relay:write",
                "review:write",
                "terminal:operate",
            ]
        );
    }

    #[test]
    fn an_unlisted_method_is_a_defect_with_the_measured_message() {
        assert_eq!(
            required_scope("no.such.method").unwrap_err().message(),
            "RPC method no.such.method has no declared authorization scope."
        );
        // `Object.hasOwn` is the gate, so a name inherited from `Object.prototype` is not a method.
        assert!(required_scope("toString").is_err());
    }

    #[test]
    fn device_list_escalates_only_on_a_non_empty_input() {
        use required_scope_for_device_list as scope;
        assert_eq!(scope(None, None), "orchestration:read");
        assert_eq!(scope(Some("host-1"), None), "orchestration:operate");
        assert_eq!(scope(None, Some("codex")), "orchestration:operate");
        assert_eq!(scope(Some(""), Some("")), "orchestration:read");
    }

    #[test]
    fn granting_is_exact() {
        assert!(grants(&["orchestration:operate"], "orchestration:operate"));
        assert!(!grants(&["orchestration:operate"], "orchestration:read"));
        let none: [&str; 0] = [];
        assert!(!grants(&none, "orchestration:read"));
    }

    /// Owned scopes reach the same answer, which is what lets a session call the gate without copying.
    #[test]
    fn granting_reads_an_owned_credential() {
        let scopes = vec!["orchestration:read".to_owned(), "relay:write".to_owned()];
        assert!(grants(&scopes, "relay:write"));
        assert!(!grants(&scopes, "orchestration:operate"));
    }

    #[test]
    fn the_gate_consults_the_table_first() {
        // A method the table does not cover is undeclared even for a session holding every scope, because
        // the lookup is an argument to the check and not a branch of it.
        let all = ["access:read", "orchestration:read", "orchestration:operate"];
        assert!(matches!(
            authorize(&all, "vcs.deleteBranch"),
            Decision::Undeclared(UndeclaredScope { method }) if method == "vcs.deleteBranch"
        ));
        assert_eq!(
            authorize(&all, "device.open"),
            Decision::Granted,
            "operate is declared for device.open"
        );
        assert_eq!(
            authorize(&["orchestration:read"], "device.open"),
            Decision::Refused {
                required: "orchestration:operate"
            },
        );
    }

    /// `inspectOnly` is the one path with no gate, and `updateTool` is what takes it away.
    #[test]
    fn device_list_bypasses_the_gate_only_alone() {
        let none: [&str; 0] = [];
        assert_eq!(
            authorize_device_list(&none, true, None, None),
            Decision::Granted,
        );
        assert_eq!(
            authorize_device_list(&none, true, None, Some("codex")),
            Decision::Refused {
                required: "orchestration:operate"
            },
            "an inspection that also updates a tool is an operation",
        );
        assert_eq!(
            authorize_device_list(&none, true, None, Some("")),
            Decision::Granted,
            "an empty updateTool is falsy, so the early return stands",
        );
        assert_eq!(
            authorize_device_list(&none, true, Some("host-1"), None),
            Decision::Granted,
            "the short-circuit is tested before the payload decides a scope",
        );
        assert_eq!(
            authorize_device_list(&["orchestration:read"], false, Some("host-1"), None),
            Decision::Refused {
                required: "orchestration:operate"
            },
        );
        assert_eq!(
            authorize_device_list(&["orchestration:read"], false, Some(""), Some("")),
            Decision::Granted,
        );
    }

    #[test]
    fn the_authorization_body_is_the_measured_json() {
        assert_eq!(
            authorization_error("orchestration:read"),
            r#"{"_tag":"EnvironmentAuthorizationError","message":"The authenticated token is missing required scope: orchestration:read.","requiredScope":"orchestration:read"}"#
        );
    }
}
