//! Runtime ownership is selected before reducing process rules to executable paths.
use super::{bundles, model::{Overrides, ProcessRule}, tracker::ProcessEntry};

pub fn key(rule: &ProcessRule, config: &Overrides) -> String {
    bundles::owner(&rule.id, &config.bundles).map(|b| format!("bundle:{}", b.id))
        .unwrap_or_else(|| format!("rule:{}", rule.id))
}

pub fn standalone(rule: &ProcessRule, config: &Overrides) -> bool {
    rule.enabled && !bundles::owner(&rule.id, &config.bundles).is_some_and(|b| !b.enabled)
        && !(rule.match_kind == "name" && bundles::owner(&rule.id, &config.bundles).is_some()
            && matches!(rule.match_value.to_ascii_lowercase().as_str(), "node.exe" | "cmd.exe" | "powershell.exe" | "pwsh.exe"))
}

fn matches(rule: &ProcessRule, path: &str) -> bool {
    crate::platform::same_path(&rule.match_value, if rule.match_kind == "path" { path }
        else { path.rsplit(['\\', '/']).next().unwrap_or("") })
}

/// Explicit paths precede names; the closest confirmed ancestor wins inheritance.
/// Shared bundled interpreters are companions, never global roots by basename.
pub fn select<'a>(config: &'a Overrides, process: &ProcessEntry) -> Option<&'a ProcessRule> {
    if !config.process_enabled || process.identity.is_empty() || process.created_at == 0 { return None; }
    let path = process.executable_path.as_deref()?;
    for kind in ["path", "name"] {
        if let Some(rule) = config.process_rules.iter().find(|r| standalone(r, config) && r.match_kind == kind && matches(r, path)) { return Some(rule); }
    }
    process.ancestors.iter().find_map(|(_, path)| {
        ["path", "name"].into_iter().find_map(|kind| config.process_rules.iter()
            .find(|r| standalone(r, config) && r.include_descendants && r.match_kind == kind && matches(r, path)))
    })
}
