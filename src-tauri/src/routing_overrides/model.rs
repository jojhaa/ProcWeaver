use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Target { pub profile_id: String, pub kind: String, pub name: String }

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessRule {
    pub id: String, pub enabled: bool, pub label: String,
    pub match_kind: String, pub match_value: String,
    pub action: String, pub target: Option<Target>, pub include_descendants: bool,
    #[serde(default)] pub rule_mode: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DnsRule {
    pub id: String, pub enabled: bool, pub domain_kind: String,
    pub domain: String, pub resolver_url: String, pub target: Target,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BundleRoute {
    pub id: String, pub name: String, pub main_exe: String, pub enabled: bool,
    pub main_target: Option<Target>, pub dns_target: Option<Target>,
    #[serde(default)] pub port: u16,
    #[serde(default)] pub mode: String,
    #[serde(default)] pub domains: Vec<String>,
    #[serde(default = "default_bundle_fallback")] pub fallback: String,
}
fn default_bundle_fallback() -> String { "rules".into() }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Overrides {
    pub schema_version: u32, pub revision: u64,
    pub process_enabled: bool, pub dns_enabled: bool,
    pub process_rules: Vec<ProcessRule>, pub dns_rules: Vec<DnsRule>,
    #[serde(default)] pub bundles: Vec<BundleRoute>,
    #[serde(default = "first_bundle_port")] pub next_bundle_port: u16,
}
fn first_bundle_port() -> u16 { 34000 }
impl Default for Overrides {
    fn default() -> Self { Self { schema_version: 1, revision: 0, process_enabled: false,
        dns_enabled: false, process_rules: vec![], dns_rules: vec![], bundles: vec![], next_bundle_port: first_bundle_port() } }
}

pub fn safe_atom(value: &str) -> bool {
    !value.is_empty() && value.len() <= 1024 && !value.chars().any(|c| c.is_control() || matches!(c, ',' | '(' | ')' | '#' | '&' | '='))
}
pub fn domain(value: &str) -> bool {
    !value.is_empty() && value.len() <= 253 && value.contains('.') && value.parse::<std::net::IpAddr>().is_err()
        && value.split('.').all(|s| !s.is_empty() && s.len() <= 63 && !s.starts_with('-') && !s.ends_with('-')
            && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
}
pub fn normalize(mut config: Overrides) -> Result<Overrides, String> {
    if config.schema_version != 1 { return Err("不支持的规则版本，请升级客户端".into()); }
    if config.process_rules.len() > 256 || config.dns_rules.len() > 512 { return Err("进程规则最多 256 条，DNS 规则最多 512 条".into()); }
    if config.bundles.len() > 128 { return Err("业务包最多 128 个".into()); }
    let mut bundle_ids = std::collections::HashSet::new();
    for bundle in &mut config.bundles {
        if bundle.id.is_empty() || bundle.id.len() > 64 || !bundle.id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
            || !bundle_ids.insert(bundle.id.clone()) || bundle.name.is_empty() || bundle.name.len() > 200
            || !safe_atom(&bundle.main_exe) || !bundle.main_exe.to_ascii_lowercase().ends_with(".exe")
            || !matches!(bundle.mode.as_str(), "strict" | "sandbox")
            || !matches!(bundle.fallback.as_str(), "rules" | "system" | "direct") {
            return Err("业务包标识、主程序、模式或未命中策略无效".into());
        }
        for target in [&bundle.main_target, &bundle.dns_target].into_iter().flatten() { validate_target(target)?; }
        if bundle.enabled && bundle.main_target.is_none() { return Err("业务包启用前须绑定出口".into()); }
        if bundle.domains.len()>512 { return Err("每个业务包最多 512 个域名".into()); }
        for pattern in &mut bundle.domains {
            *pattern=pattern.trim().trim_end_matches('.').to_ascii_lowercase();
            if pattern.starts_with('.') { *pattern=format!("*{pattern}"); }
            if !domain(pattern.strip_prefix("*.").unwrap_or(pattern)) { return Err("业务包域名无效，请使用纯域名、*.域名或 Punycode".into()); }
        }
        bundle.domains.sort(); bundle.domains.dedup();
    }
    let mut ids = std::collections::HashSet::new();
    let mut matches = std::collections::HashSet::new();
    for r in &mut config.process_rules {
        if !safe_atom(&r.id) || r.id.len() > 100 || !ids.insert(r.id.clone()) || r.label.len() > 120 { return Err("进程规则 ID 重复或名称过长".into()); }
        r.match_value = r.match_value.trim().to_string();
        if !safe_atom(&r.match_value) || r.match_value.contains(['*', '?']) { return Err("程序匹配值无效，不支持通配符或规则分隔符".into()); }
        match r.match_kind.as_str() {
            "path" if std::path::Path::new(&r.match_value).is_absolute() => {},
            "name" if !r.match_value.contains(['/', '\\', ':']) => {},
            _ => return Err("程序匹配值无效，路径必须为绝对路径，名称不能包含路径分隔符".into()),
        }
        if r.match_kind == "path" { r.match_value = r.match_value.replace('/', "\\"); }
        if !matches.insert((r.match_kind.clone(), r.match_value.to_lowercase())) { return Err("程序匹配条件重复，请编辑已有规则".into()); }
        match r.action.as_str() {
            "proxy" => {
                let target = r.target.as_mut().ok_or("请选择节点或策略组")?;
                if target.profile_id.trim().is_empty() {
                    target.profile_id = crate::routing_overrides::current_source().0;
                }
                validate_target(target)?;
            }
            "direct" | "reject" => r.target = None,
            _ => return Err("进程动作无效".into()),
        }
        if let Some(ref m) = r.rule_mode {
            if !matches!(m.as_str(), "inherit" | "strict") {
                return Err("规则穿透模式无效，仅支持 inherit 或 strict".into());
            }
        }
    }
    let mut domains = std::collections::HashSet::new();
    for r in &mut config.dns_rules {
        if !safe_atom(&r.id) || r.id.len() > 100 || !ids.insert(r.id.clone()) { return Err("DNS 规则 ID 无效或重复".into()); }
        r.domain = r.domain.trim().trim_end_matches('.').to_ascii_lowercase();
        if !domain(&r.domain) || !matches!(r.domain_kind.as_str(), "exact" | "suffix") { return Err("域名无效，请使用纯域名或 Punycode".into()); }
        if !domains.insert((r.domain_kind.clone(), r.domain.clone())) { return Err("域名匹配条件重复".into()); }
        if r.target.profile_id.trim().is_empty() {
            r.target.profile_id = crate::routing_overrides::current_source().0;
        }
        validate_target(&r.target)?;
        let u = reqwest::Url::parse(&r.resolver_url).map_err(|_| "DNS 地址无效")?;
        if r.resolver_url.len() > 1024 || !matches!(u.scheme(), "https" | "tls") || u.host_str().is_none()
            || u.fragment().is_some() || !u.username().is_empty() || u.password().is_some() || u.query().is_some()
            || (u.scheme() == "tls" && !matches!(u.path(), "" | "/")) {
            return Err("DNS 仅支持无凭据、无查询参数和无片段的 HTTPS / TLS 地址".into());
        }
    }
    Ok(config)
}
fn validate_target(t: &Target) -> Result<(), String> {
    let profile_id = if t.profile_id.trim().is_empty() { "default" } else { t.profile_id.as_str() };
    if !safe_atom(&t.name) || !safe_atom(profile_id) || !matches!(t.kind.as_str(), "node" | "group")
        || matches!(t.name.as_str(), "DIRECT" | "REJECT" | "GLOBAL" | "RULES") { return Err("节点绑定无效或名称包含保留字符".into()); }
    Ok(())
}
