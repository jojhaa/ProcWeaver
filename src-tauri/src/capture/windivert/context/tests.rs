use super::*;

fn source(rules: &[&str]) -> Value {
    serde_yaml::to_value(serde_json::json!({"rules":rules,"proxies":[],"mode":"rule","mixed-port":0})).unwrap()
}
fn identity(id: &str, name: &str) -> ProcessContext {
    ProcessContext { id: id.into(), executable_path: format!("C:\\Applications\\{name}") }
}
fn one(yaml: &Value, name: &str) -> CompiledContext { compile(yaml, &[identity("test", name)]).unwrap().remove(0) }

#[test]
fn original_process_and_domain_both_required_in_order() {
    let yaml = source(&[
        "DOMAIN,exclude.example,DIRECT",
        "AND,((PROCESS-NAME,codex.exe),(DOMAIN-SUFFIX,openai.com)),NodeA",
        "AND,((PROCESS-NAME,claude.exe),(DOMAIN-SUFFIX,openai.com)),NodeB",
        "MATCH,DIRECT",
    ]);
    assert_eq!(one(&yaml, "codex.exe").rules, ["DOMAIN,exclude.example,DIRECT", "DOMAIN-SUFFIX,openai.com,NodeA", "MATCH,DIRECT"]);
    assert_eq!(one(&yaml, "claude.exe").rules, ["DOMAIN,exclude.example,DIRECT", "DOMAIN-SUFFIX,openai.com,NodeB", "MATCH,DIRECT"]);
    assert_eq!(one(&yaml, "helper.exe").rules, ["DOMAIN,exclude.example,DIRECT", "MATCH,DIRECT"]);
}

#[test]
fn nested_boolean_and_windows_paths_preserve_meaning() {
    let yaml = source(&[
        "AND,((OR,((PROCESS-NAME,codex.exe),(PROCESS-NAME,claude.exe))),(NOT,((DOMAIN,private.example)))),NodeA",
        "PROCESS-PATH,C:\\applications\\CODEX.exe,NodeB",
        "IP-CIDR,192.0.2.0/24,DIRECT,no-resolve", "MATCH,REJECT",
    ]);
    assert_eq!(one(&yaml, "codex.exe").rules, ["NOT,((DOMAIN,private.example)),NodeA", "MATCH,NodeB", "IP-CIDR,192.0.2.0/24,DIRECT,no-resolve", "MATCH,REJECT"]);
    assert_eq!(one(&yaml, "other.exe").rules, ["IP-CIDR,192.0.2.0/24,DIRECT,no-resolve", "MATCH,REJECT"]);
}

#[test]
fn flat_and_wrapped_logic_groups_compile_identically() {
    let flat = source(&[
        "AND,(AND,(PROCESS-NAME,codex.exe),(NETWORK,TCP)),(NOT,((DOMAIN,private.example))),NodeA",
        "OR,(PROCESS-PATH,C:\\Applications\\claude.exe),(DOMAIN,allowed.example),NodeB",
        "IP-CIDR,192.0.2.0/24,DIRECT,no-resolve", "MATCH,REJECT",
    ]);
    let wrapped = source(&[
        "AND,((AND,((PROCESS-NAME,codex.exe),(NETWORK,TCP))),(NOT,((DOMAIN,private.example)))),NodeA",
        "OR,((PROCESS-PATH,C:\\Applications\\claude.exe),(DOMAIN,allowed.example)),NodeB",
        "IP-CIDR,192.0.2.0/24,DIRECT,no-resolve", "MATCH,REJECT",
    ]);
    assert_eq!(process_keys(&flat).unwrap(), process_keys(&wrapped).unwrap());
    for process in ["codex.exe", "claude.exe", "other.exe"] {
        assert_eq!(one(&flat, process).rules, one(&wrapped, process).rules, "{process}");
    }
    let mut sub = source(&["SUB-RULE,(OR,(PROCESS-NAME,codex.exe),(PROCESS-NAME,claude.exe)),nested", "MATCH,DIRECT"]);
    sub["sub-rules"] = serde_yaml::to_value(serde_json::json!({"nested":flat["rules"]})).unwrap();
    assert_eq!(process_keys(&sub).unwrap().len(), 3);
    assert_eq!(one(&sub, "codex.exe").sub_rules["pw-wd-test-nested"], one(&flat, "codex.exe").rules);
    assert!(one(&sub, "other.exe").sub_rules.is_empty());
}

#[test]
fn flat_logic_still_rejects_invalid_children_and_multiple_not_operands() {
    for rule in [
        "AND,(PROCESS-NAME,codex.exe),invalid,DIRECT",
        "AND,(PROCESS-NAME,codex.exe),,DIRECT",
        "AND,(PROCESS-NAME,codex.exe),(NETWORK,TCP),DIRECT,unsupported",
        "NOT,(PROCESS-NAME,codex.exe),(NETWORK,TCP),DIRECT",
        "AND,(PROCESS-NAME,codex.exe),(NETWORK,TCP)),DIRECT",
    ] {
        assert!(process_keys(&source(&[rule])).is_err(), "{rule}");
        assert!(compile(&source(&[rule]), &[identity("a", "codex.exe")]).is_err(), "{rule}");
    }
}

#[test]
fn process_path_matches_core_strings_not_filesystem_aliases() {
    for path in [r"C:/Applications/codex.exe", r"\\?\C:\Applications\codex.exe", r"C:\Applications\sub\..\codex.exe"] {
        let yaml = source(&[&format!("PROCESS-PATH,{path},NodeA"), "MATCH,DIRECT"]);
        assert_eq!(one(&yaml, "codex.exe").rules, ["MATCH,DIRECT"]);
    }
    let yaml = source(&["PROCESS-NAME,Σ.exe,NodeA", "MATCH,DIRECT"]);
    assert!(compile(&yaml, &[identity("a", "ς.exe")]).is_err());
}

#[test]
fn boolean_truth_table_and_shared_subrule_references() {
    let yaml = source(&[
        "OR,((PROCESS-NAME,codex.exe),(DOMAIN,a.example)),DIRECT",
        "NOT,((OR,((PROCESS-NAME,codex.exe),(DOMAIN,b.example)))),REJECT",
        "AND,((NOT,((PROCESS-NAME,codex.exe))),(IP-CIDR6,2001:db8::/32)),DIRECT",
        "MATCH,REJECT",
    ]);
    assert_eq!(one(&yaml, "codex.exe").rules, ["MATCH,DIRECT"]);
    assert_eq!(one(&yaml, "other.exe").rules, ["DOMAIN,a.example,DIRECT", "NOT,((DOMAIN,b.example)),REJECT", "IP-CIDR6,2001:db8::/32,DIRECT", "MATCH,REJECT"]);
    let contexts = (0..64).map(|i| identity(&format!("c{i}"), "codex.exe")).collect::<Vec<_>>();
    assert_eq!(compile(&yaml, &contexts).unwrap().len(), 64);
}

#[test]
fn subrules_are_specialized_and_never_shared_between_processes() {
    let mut yaml = source(&["SUB-RULE,(PROCESS-NAME,codex.exe),nested", "MATCH,DIRECT"]);
    yaml["sub-rules"] = serde_yaml::to_value(serde_json::json!({"nested":["PROCESS-NAME,codex.exe,NodeA","MATCH,REJECT"]})).unwrap();
    let context = one(&yaml, "codex.exe");
    assert_eq!(context.rules[0], "SUB-RULE,(OR,((NETWORK,TCP),(NETWORK,UDP))),pw-wd-test-nested");
    assert_eq!(context.sub_rules["pw-wd-test-nested"], ["MATCH,NodeA", "MATCH,REJECT"]);
    assert!(one(&yaml, "claude.exe").sub_rules.is_empty());
    yaml["sub-rules"]["nested"] = serde_yaml::to_value(["SUB-RULE,(NETWORK,TCP),nested"]).unwrap();
    assert!(compile(&yaml, &[identity("test", "codex.exe")]).is_err());
}

#[test]
fn never_silently_reinterprets_source_or_dynamic_process_predicates() {
    for rule in ["SRC-PORT,1234,DIRECT", "SRC-IP-CIDR,192.0.2.0/24,DIRECT", "IN-NAME,original,DIRECT",
        "PROCESS-NAME-REGEX,.*codex.*,NodeA", "UID,100,DIRECT", "RULE-SET,dynamic,NodeA",
        "AND,((PROCESS-NAME,codex.exe),(DST-PORT,443)),NodeA,unsupported"] {
        assert!(compile(&source(&[rule]), &[identity("test", "codex.exe")]).is_err(), "{rule}");
    }
    let mut yaml = source(&["RULE-SET,domains,NodeA", "MATCH,DIRECT"]);
    yaml["rule-providers"] = serde_yaml::to_value(serde_json::json!({"domains":{"behavior":"domain","type":"inline","payload":["+.example.com"]}})).unwrap();
    assert_eq!(one(&yaml, "codex.exe").rules[0], "RULE-SET,domains,NodeA");
}

#[test]
fn invalid_contexts_and_capacity_are_rejected() {
    let yaml = source(&["MATCH,DIRECT"]);
    assert!(compile(&yaml, &[ProcessContext { id:"a".into(), executable_path:"codex.exe".into() }]).is_err());
    assert!(compile(&yaml, &[identity("a", "x.exe"), identity("a", "y.exe")]).is_err());
    let contexts = (0..65).map(|i| identity(&format!("c{i}"), "x.exe")).collect::<Vec<_>>();
    assert!(compile(&yaml, &contexts).is_err());
    for rule in ["AND,((PROCESS-NAME,codex.exe),),DIRECT", "NOT,((DOMAIN,a),(DOMAIN,b)),DIRECT", "MATCH", "MATCH,"] {
        assert!(compile(&source(&[rule]), &[identity("a", "x.exe")]).is_err(), "{rule}");
    }
}

#[test]
fn attaching_is_atomic_and_never_overwrites_existing_listeners() {
    let yaml = source(&["PROCESS-NAME,codex.exe,DIRECT", "MATCH,REJECT"]);
    let contexts = compile(&yaml, &[identity("a", "codex.exe")]).unwrap();
    let candidate = attach(&yaml, &contexts, &[36100]).unwrap();
    assert!(yaml["listeners"].is_null());
    assert_eq!(candidate["listeners"][0]["udp"], true);
    assert!(attach(&candidate, &contexts, &[36100]).is_err());
    let mut occupied = yaml.clone(); occupied["dns"]["listen"] = "127.0.0.1:36100".into();
    assert!(attach(&occupied, &contexts, &[36100]).is_err());
}

#[test]
fn real_mihomo_validates_context_and_boolean_subrules() {
    use std::os::windows::process::CommandExt;
    let mut yaml = source(&["SUB-RULE,(PROCESS-NAME,codex.exe),nested", "MATCH,REJECT"]);
    yaml["sub-rules"] = serde_yaml::to_value(serde_json::json!({"nested":["AND,((PROCESS-NAME,codex.exe),(NOT,((DOMAIN,private.example)))),DIRECT","IP-CIDR,192.0.2.0/24,DIRECT,no-resolve","MATCH,REJECT"]})).unwrap();
    let contexts = compile(&yaml, &[identity("a", "codex.exe")]).unwrap();
    let directory = std::env::temp_dir().join(format!("pw-wd-context-core-{}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(directory.join("config.yaml"), serde_yaml::to_string(&attach(&yaml, &contexts, &[36100]).unwrap()).unwrap()).unwrap();
    let result = std::process::Command::new(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries/mihomo-compatible.exe"))
        .args(["-t", "-d"]).arg(&directory).creation_flags(0x08000000).output().unwrap();
    let _ = std::fs::remove_dir_all(&directory);
    assert!(result.status.success(), "{} {}", String::from_utf8_lossy(&result.stdout), String::from_utf8_lossy(&result.stderr));
}
