use super::*;
    #[test]
    fn composed_contexts_merge_case_variants_and_preserve_capture_targets() {
        use crate::routing_overrides::model::{Overrides, ProcessRule};
        let rule = |id: &str, kind: &str, value: &str| ProcessRule {
            id: id.into(), enabled: true, label: id.into(),
            match_kind: kind.into(), match_value: value.into(),
            action: "direct".into(), target: None, include_descendants: false, rule_mode: None,
        };
        let config = Overrides {
            process_enabled: true,
            process_rules: vec![rule("name", "name", "codex.EXE"), rule("path", "path", r"c:\apps\other.EXE")],
            ..Overrides::default()
        };
        let rules = ["PROCESS-NAME,CoDeX.exe,DIRECT", "AND,(PROCESS-NAME,codex.exe),(DOMAIN,example.invalid),REJECT",
            r"PROCESS-PATH,C:\Apps\Other.exe,DIRECT", r"PROCESS-PATH,c:\apps\other.exe,REJECT", "MATCH,REJECT"];
        let raw = serde_yaml::to_string(&serde_json::json!({"rules":rules})).unwrap();
        let result: Value = serde_yaml::from_str(&compose(&raw, &config).unwrap()).unwrap();
        assert_eq!(result["rules"], serde_yaml::to_value(rules).unwrap());
        let plan: Plan = serde_yaml::from_value(result[KEY].clone()).unwrap();
        assert_eq!(plan.entries.len(), 2);
        assert_eq!(plan.targets.len(), 2);
        assert_eq!(result["listeners"].as_sequence().unwrap().len(), 2);
        plan.validate().unwrap();
        for path in [r"C:\Apps\CODEX.exe", r"C:\APPS\OTHER.exe"] {
            assert!(plan.port_for(path, 1, 1).is_some());
        }
        assert!(plan.port_for(r"C:\Unrelated\other.exe", 1, 1).is_none());
        let lower = serde_yaml::to_string(&serde_json::json!({"rules":[
            "PROCESS-NAME,codex.exe,DIRECT", r"PROCESS-PATH,c:\apps\other.exe,DIRECT", "MATCH,REJECT"
        ]})).unwrap();
        let second: Value = serde_yaml::from_str(&compose(&lower, &config).unwrap()).unwrap();
        let second: Plan = serde_yaml::from_value(second[KEY].clone()).unwrap();
        for entry in &plan.entries {
            assert!(second.entries.iter().any(|other| other.kind == entry.kind
                && other.value.eq_ignore_ascii_case(&entry.value) && other.port == entry.port));
        }
    }

    #[test]
    fn inherited_restart_updates_revision_but_unrelated_process_does_not() {
        use crate::routing_overrides::{
            model::{Overrides, ProcessRule},
            tracker::{MonitorState, ProcessEntry, TrackingStatus},
        };
        let rule = |id: &str, kind: &str, value: &str| ProcessRule {
            id: id.into(),
            enabled: true,
            label: id.into(),
            match_kind: kind.into(),
            match_value: value.into(),
            action: "direct".into(),
            target: None,
            include_descendants: true,
            rule_mode: None,
        };
        let config = Overrides {
            process_enabled: true,
            process_rules: vec![rule("root", "name", "target.exe")],
            ..Overrides::default()
        };
        let child = ProcessEntry {
            identity: "7:99".into(),
            pid: 7,
            parent_pid: 1,
            name: "node.exe".into(),
            created_at: 99,
            executable_path: Some(r"C:\tools\node.exe".into()),
            parent_identity: Some("1:10".into()),
            ancestors: vec![("1:10".into(), r"C:\app\target.exe".into())],
        };
        let mut state = TrackingStatus {
            generation: 1,
            subscribed: true,
            ready: true,
            error: None,
            entries: vec![child],
            monitor_state: MonitorState::Current,
            unverified_names: vec![],
            derived: vec![rule("child", "path", r"C:\tools\node.exe")],
            conflicts: vec![],
            warnings: vec![],
        };
        let old = instance_revision(&config, &state);
        state.entries[0].pid = 8;
        state.entries[0].created_at = 100;
        state.entries[0].identity = "8:100".into();
        let restarted = instance_revision(&config, &state);
        assert_ne!(old, restarted);
        let mut other = state.entries[0].clone();
        other.pid = 9;
        other.created_at = 101;
        other.identity = "9:101".into();
        other.ancestors.clear();
        state.entries.push(other);
        assert_eq!(restarted, instance_revision(&config, &state));
        state.entries.remove(0);
        assert_eq!(instance_revision(&config, &state), "[]");
    }
    #[test]
    fn scope_does_not_capture_other_processes_and_paths_precede_names() {
        let entries = vec![
            Entry {
                owner: String::new(),
                kind: "name".into(),
                value: "chrome.exe".into(),
                port: 61001,
            },
            Entry {
                owner: String::new(),
                kind: "path".into(),
                value: r"C:\one\chrome.exe".into(),
                port: 61002,
            },
        ];
        let plan = Plan {
            targets: vec![entries[0].clone()],
            entries,
            instances: vec![],
        };
        plan.validate().unwrap();
        assert_eq!(plan.port_for(r"C:\one\chrome.exe", 1, 1), Some(61002));
        assert_eq!(plan.port_for(r"D:\two\chrome.exe", 1, 1), Some(61001));
        assert_eq!(plan.port_for(r"C:\node.exe", 1, 1), None);
    }
    #[test]
    fn inherited_shared_binary_is_scoped_to_one_process_incarnation() {
        let entry = Entry {
            owner: String::new(),
            kind: "path".into(),
            value: r"C:\node.exe".into(),
            port: 61001,
        };
        let plan = Plan {
            entries: vec![entry],
            targets: vec![],
            instances: vec![Instance {
                owner: String::new(),
                pid: 7,
                created_at: 99,
                path: r"C:\node.exe".into(),
            }],
        };
        assert_eq!(plan.port_for(r"C:\node.exe", 7, 99), Some(61001));
        assert_eq!(plan.port_for(r"C:\node.exe", 7, 100), None);
        assert_eq!(plan.port_for(r"C:\node.exe", 8, 99), None);
    }
