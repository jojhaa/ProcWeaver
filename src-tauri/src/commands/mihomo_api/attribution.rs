//! Preserve core metadata. Label relay context separately so the UI never
//! mistakes the WinDivert helper for the original application or a verified PID.
use serde_json::{json, Value};
use std::collections::HashMap;

pub(super) fn annotate(connections: &mut Value, core_pid: Option<u32>) {
    if !connections["connections"].as_array().is_some_and(|items| items.iter().any(|c|
        c["metadata"]["inboundName"].as_str().is_some_and(|s| s.starts_with("pw-wd-")))) { return; }
    #[cfg(windows)]
    let labels = core_pid.map(crate::capture::windivert::session::observation_entries).unwrap_or_default().into_iter().filter_map(|entry| {
        Some((format!("pw-wd-{}", entry.id().ok()?), (entry.kind, entry.value, entry.owner)))
    }).collect();
    #[cfg(not(windows))]
    let labels = { let _ = core_pid; HashMap::new() };
    apply(connections, &labels);
}

fn apply(connections: &mut Value, labels: &HashMap<String, (String, String, String)>) {
    for item in connections["connections"].as_array_mut().into_iter().flatten() {
        let Some(metadata) = item["metadata"].as_object_mut() else { continue; };
        let Some(name) = metadata.get("inboundName").and_then(Value::as_str).filter(|s| s.starts_with("pw-wd-")) else { continue; };
        let (kind, value, owner) = labels.get(name).map(|(k, v, o)| (k.as_str(), v.as_str(), o.as_str())).unwrap_or(("unknown", "", ""));
        metadata.insert("processContext".into(), json!({"source":"windivert_context", "kind":kind, "value":value, "owner":owner}));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn relay_context_is_separate_and_unknown_never_becomes_helper_identity() {
        let mut data = json!({"connections":[
            {"metadata":{"inboundName":"pw-wd-path", "process":"helper.exe", "host":"example.test"}},
            {"metadata":{"inboundName":"pw-wd-name"}},
            {"metadata":{"inboundName":"pw-wd-old", "processPath":"C:/helper.exe"}},
            {"metadata":{"inboundName":"mixed", "processPath":"C:/reader.exe"}}
        ]});
        apply(&mut data, &HashMap::from([
            ("pw-wd-path".into(), ("path".into(), "C:/reader.exe".into(), "bundle:reader".into())),
            ("pw-wd-name".into(), ("name".into(), "reader.exe".into(), String::new()))
        ]));
        assert_eq!(data["connections"][0]["metadata"]["processContext"]["value"], "C:/reader.exe");
        assert_eq!(data["connections"][0]["metadata"]["process"], "helper.exe");
        assert_eq!(data["connections"][1]["metadata"]["processContext"]["kind"], "name");
        assert_eq!(data["connections"][2]["metadata"]["processContext"]["kind"], "unknown");
        assert!(data["connections"][3]["metadata"].get("processContext").is_none());
    }
}
