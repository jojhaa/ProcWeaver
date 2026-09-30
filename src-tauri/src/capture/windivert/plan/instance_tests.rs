use super::*;
use crate::routing_overrides::{model::{ProcessRule, BundleRoute, Target}, tracker::MonitorState};

fn rule(id: &str, path: &str) -> ProcessRule {
    ProcessRule { id: id.into(), label: id.into(), enabled: true, match_kind: "path".into(),
        match_value: path.into(), action: "proxy".into(), target: Some(Target { profile_id: "default".into(), kind: "group".into(), name: "ExitA".into() }),
        include_descendants: true, rule_mode: Some("strict".into()) }
}
fn bundle(id: &str) -> BundleRoute {
    BundleRoute { id: id.into(), name: id.into(), main_exe: format!("{id}.exe"), enabled: true,
        main_target: rule("", "").target, dns_target: None, port: 34000, mode: "strict".into(), domains: vec![], fallback: "rules".into() }
}
fn child(pid: u32, root: &str) -> ProcessEntry {
    ProcessEntry { identity: format!("{pid}:100"), pid, created_at: 100, parent_pid: 8, parent_identity: Some("8:90".into()),
        name: "node.exe".into(), executable_path: Some(r"C:\Shared\node.exe".into()),
        ancestors: vec![("8:90".into(), r"C:\Windows\System32\cmd.exe".into()), ("7:80".into(), r"C:\Shared\helper.exe".into()), ("1:10".into(), root.into())] }
}
fn state(entries: Vec<ProcessEntry>) -> TrackingStatus {
    TrackingStatus { generation: 1, subscribed: true, ready: true, error: None, entries,
        monitor_state: MonitorState::Current, unverified_names: vec![], derived: vec![], conflicts: vec![], warnings: vec![] }
}
fn fixture() -> (Overrides, BTreeMap<String, Value>) {
    let mut second = rule("bundle-b-root", r"C:\B\app.exe"); second.target.as_mut().unwrap().name = "ExitB".into();
    let config = Overrides { process_enabled: true, bundles: vec![bundle("a"), bundle("b")],
        process_rules: vec![rule("bundle-a-root", r"C:\A\app.exe"), second], ..Overrides::default() };
    let policies = BTreeMap::from([
        ("bundle:a".into(), serde_json::json!({"rules":["DOMAIN,excluded.test,DIRECT","MATCH,ExitA","MATCH,REJECT"]})),
        ("bundle:b".into(), serde_json::json!({"rules":["DOMAIN,excluded.test,DIRECT","MATCH,ExitB","MATCH,REJECT"]})),
    ]).into_iter().map(|(k,v)| (k, serde_yaml::to_value(v).unwrap())).collect();
    (config, policies)
}
#[test]
fn shared_executable_is_routed_by_owner_and_incarnation_without_new_listeners() {
    let (config, policies) = fixture();
    let raw = compose_with_policies("rules: ['MATCH,DIRECT']", &config, &policies).unwrap();
    let yaml: Value = serde_yaml::from_str(&raw).unwrap();
    let mut plan: Plan = serde_yaml::from_value(yaml[KEY].clone()).unwrap();
    assert_eq!(plan.entries.len(), 2);
    let entries = plan.entries.clone();
    let mut observation = state(vec![child(11, r"C:\A\app.exe"), child(12, r"C:\B\app.exe"), child(13, r"C:\Other\app.exe")]);
    plan.refresh_instances(&config, &observation).unwrap();
    let path = r"C:\Shared\node.exe";
    let a = plan.port_for(path, 11, 100).unwrap(); let b = plan.port_for(path, 12, 100).unwrap();
    assert_ne!(a, b);
    assert_eq!(plan.port_for(path, 13, 100), None);
    assert_eq!(plan.port_for(path, 11, 101), None);
    assert_eq!(plan.port_for(r"D:\node.exe", 11, 100), None);
    for (port, expected, forbidden) in [(a, "MATCH,ExitA", "MATCH,ExitB"), (b, "MATCH,ExitB", "MATCH,ExitA")] {
        let entry = plan.entries.iter().find(|e| e.port == port).unwrap();
        let rules = yaml["sub-rules"][format!("pw-wd-{}", entry.id().unwrap())].as_sequence().unwrap();
        assert!(rules.contains(&Value::from(expected))); assert!(!rules.contains(&Value::from(forbidden)));
    }
    // A previously unseen child path belongs to the already compiled otherwise class.
    observation.entries[0].executable_path = Some(r"D:\New\worker.exe".into());
    observation.entries[0].name = "worker.exe".into();
    observation.entries[0].created_at = 101;
    observation.entries[0].identity = "11:101".into();
    plan.refresh_instances(&config, &observation).unwrap();
    assert_eq!(plan.entries, entries);
    assert_eq!(plan.port_for(r"D:\New\worker.exe", 11, 101), Some(a));
    assert_eq!(plan.port_for(path, 11, 100), None);
    observation.entries.clear(); plan.refresh_instances(&config, &observation).unwrap();
    assert!(plan.instances.is_empty()); assert_eq!(plan.entries, entries);
}

#[test]
fn nearest_root_explicit_child_and_independent_service_have_clear_priority() {
    let (mut config, _) = fixture();
    let mut p = child(11, r"C:\A\app.exe");
    assert_eq!(ownership::key(ownership::select(&config, &p).unwrap(), &config), "bundle:a");
    p.ancestors.insert(0, ("9:95".into(), r"C:\B\app.exe".into()));
    assert_eq!(ownership::key(ownership::select(&config, &p).unwrap(), &config), "bundle:b");
    let mut shared = rule("bundle-a-node", "node.exe"); shared.match_kind = "name".into();
    config.process_rules.insert(0, shared);
    assert_eq!(ownership::key(ownership::select(&config, &p).unwrap(), &config), "bundle:b");
    let mut direct = rule("explicit-node", r"C:\Shared\node.exe"); direct.action = "direct".into(); direct.target = None;
    config.process_rules.push(direct);
    assert_eq!(ownership::select(&config, &p).unwrap().id, "explicit-node");
    config.process_rules.pop();
    p.ancestors.clear(); assert!(ownership::select(&config, &p).is_none());
    p.name = "service.exe".into(); p.executable_path = Some(r"C:\Service\service.exe".into());
    assert!(ownership::select(&config, &p).is_none());
    config.process_rules.push(rule("bundle-a-service", r"C:\Service\service.exe"));
    assert_eq!(ownership::key(ownership::select(&config, &p).unwrap(), &config), "bundle:a");
    config.bundles[0].enabled = false; assert!(ownership::select(&config, &p).is_none());
}

#[test]
fn sandbox_contexts_keep_original_process_rules_and_do_not_merge_paths() {
    let (config, mut policies) = fixture();
    policies.insert("bundle:a".into(), serde_yaml::to_value(serde_json::json!({"rules":[
        "DOMAIN,excluded.test,DIRECT", "DOMAIN,selected.test,ExitA", "DOMAIN,selected.test,REJECT",
        r"PROCESS-PATH,C:\Special\node.exe,REJECT", "PROCESS-NAME,node.exe,ExitB", "MATCH,DIRECT"
    ]})).unwrap());
    let yaml: Value = serde_yaml::from_str(&compose_with_policies("rules: ['MATCH,DIRECT']", &config, &policies).unwrap()).unwrap();
    let mut plan: Plan = serde_yaml::from_value(yaml[KEY].clone()).unwrap();
    let mut special = child(12, r"C:\A\app.exe"); special.executable_path = Some(r"C:\Special\node.exe".into());
    let mut generic = child(13, r"C:\A\app.exe"); generic.executable_path = Some(r"C:\Other\worker.exe".into());
    plan.refresh_instances(&config, &state(vec![child(11, r"C:\A\app.exe"), special, generic])).unwrap();
    for (pid, path, expected) in [(11, r"C:\Shared\node.exe", "MATCH,ExitB"), (12, r"C:\Special\node.exe", "MATCH,REJECT"), (13, r"C:\Other\worker.exe", "MATCH,DIRECT")] {
        let port = plan.port_for(path, pid, 100).unwrap();
        let e = plan.entries.iter().find(|e| e.port == port).unwrap();
        let rules = yaml["sub-rules"][format!("pw-wd-{}", e.id().unwrap())].as_sequence().unwrap();
        assert_eq!(rules[0], "DOMAIN,excluded.test,DIRECT");
        assert_eq!(rules[1], "DOMAIN,selected.test,ExitA");
        assert!(rules.contains(&Value::from(expected)));
    }
}

#[test]
fn instance_plan_rejects_duplicate_pid_unknown_owner_and_missing_policy() {
    let (config, policies) = fixture();
    let yaml: Value = serde_yaml::from_str(&compose_with_policies("rules: ['MATCH,DIRECT']", &config, &policies).unwrap()).unwrap();
    let mut plan: Plan = serde_yaml::from_value(yaml[KEY].clone()).unwrap();
    plan.refresh_instances(&config, &state(vec![child(11, r"C:\A\app.exe")])).unwrap();
    plan.instances.push(plan.instances[0].clone()); assert!(plan.validate().is_err()); plan.instances.pop();
    plan.instances[0].owner = "bundle:unknown".into(); assert!(plan.validate().is_err());
    assert!(compose_with_policies("rules: ['MATCH,DIRECT']", &config, &BTreeMap::new()).is_err());
}
