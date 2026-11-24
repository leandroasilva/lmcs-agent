//! The authorization table: which scope each rpc demands, and what a token without it is told.
//!
//! Ported from `apps/server/src/auth/RpcAuthorization.ts:24-193`. The table is `as const satisfies
//! Record<WsRpcMethod, AuthEnvironmentScope>`, so TypeScript already guarantees every rpc of the group is
//! listed; what this module has to keep is the **listing order** (which is what the golden compares) and
//! the rule that a method absent from it is a `throw`, not a refusal.
//!
//! That throw is worth stating plainly, because it is the one entry in this file a client cannot receive
//! as data: `requiredScopeForRpcMethod` raises a plain `Error` (`RpcAuthorization.ts:180`), which in
//! Effect is a **defect** — it does not match `Effect.catchTags`, so it kills the handler instead of
//! answering the call. A port that returns a typed "unknown method" here would be inventing a response the
//! TypeScript never sends. `Object.hasOwn` is the gate, which is why the inherited name `toString` throws
//! too, and why a Rust lookup in a fixed array reproduces the whole rule for free.
//!
//! The scopes themselves are plain strings, not an enum, for a measured reason: the union reachable through
//! the table is seven names and `access:write` is **not** among them, while the contract's
//! `AuthEnvironmentScope` admits more. The predicate is `scopes.includes(required)`
//! (`EnvironmentAuth.ts`'s check), with no hierarchy — holding `orchestration:operate` buys nothing
//! towards `orchestration:read`.

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
#[must_use]
pub fn grants(scopes: &[&str], required: &str) -> bool {
    scopes.contains(&required)
}

/// The body a client reads when the credential is good and the scope is not
/// (`packages/core/src/contracts/auth.ts`'s `EnvironmentAuthorizationError`). The message repeats the
/// scope, so both fields have to move together.
#[must_use]
pub fn authorization_error(required: &str) -> String {
    format!(
        r#"{{"_tag":"EnvironmentAuthorizationError","message":"The authenticated token is missing required scope: {required}.","requiredScope":{}}}"#,
        crate::json::quote(required),
    )
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
        assert!(!grants(&[], "orchestration:read"));
    }

    #[test]
    fn the_authorization_body_is_the_measured_json() {
        assert_eq!(
            authorization_error("orchestration:read"),
            r#"{"_tag":"EnvironmentAuthorizationError","message":"The authenticated token is missing required scope: orchestration:read.","requiredScope":"orchestration:read"}"#
        );
    }
}
