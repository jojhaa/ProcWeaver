use super::*;
use crate::routing_overrides::model::{DnsRule, Overrides, Target};

fn rules() -> Overrides {
    Overrides { dns_enabled: true, dns_rules: vec![DnsRule {
        id: "dns-test".into(), enabled: true, domain_kind: "suffix".into(), domain: "example.test".into(),
        resolver_url: "https://resolver.test/dns-query".into(),
        target: Target { profile_id: "test".into(), kind: "proxy".into(), name: "test".into() },
    }], ..Default::default() }
}

const RAW: &str = "mixed-port: 7890\ndns:\n  enable: true\n  listen: '127.0.0.1:1053'\n  nameserver: ['192.0.2.1']\nrules: ['MATCH,DIRECT']\n";

fn plan(raw: &str, config: &Overrides, mode: Option<DnsListenerMode>, guard: bool, last: Option<u16>) -> Result<Value, String> {
    let settings = DnsSettings { listener_mode: mode, ..Default::default() };
    serde_yaml::from_str(&compose_with(raw, config, &settings, guard, last, false)?).map_err(|e| e.to_string())
}

#[test]
fn migration_preserves_old_preferences_and_new_windows_default_is_auto() {
    let legacy: DnsSettings = serde_json::from_str("{}").unwrap();
    assert_eq!(legacy.listener_mode, None);
    assert_eq!(DnsSettings::default().listener_mode, Some(DnsListenerMode::Auto));
    assert_eq!(plan(RAW, &Overrides::default(), None, false, None).unwrap()["dns"]["listen"], "127.0.0.1:1053");
}

#[test]
fn internal_dns_does_not_require_listener_or_change_upstreams() {
    for mode in [DnsListenerMode::Auto, DnsListenerMode::Off] {
        let yaml = plan(RAW, &Overrides::default(), Some(mode), false, None).unwrap();
        assert_eq!(yaml["dns"]["enable"], true);
        assert_eq!(yaml["dns"]["listen"], "");
        assert_eq!(yaml["dns"]["nameserver"][0], "192.0.2.1");
        assert_eq!(yaml["mixed-port"], 7890);
    }
    assert!(plan(RAW, &rules(), Some(DnsListenerMode::Off), false, None).unwrap_err().contains("接管"));
}

#[test]
fn automatic_policy_reuses_success_and_avoids_configured_ports() {
    let yaml = plan(RAW, &rules(), Some(DnsListenerMode::Auto), false, Some(45061)).unwrap();
    assert_eq!(yaml["dns"]["listen"], "127.0.0.1:45061");
    let raw = format!("{}\nlisteners: [{{name: occupied, type: mixed, port: '45053-45056'}}]\n", RAW.replace("7890", "45057"));
    let yaml = plan(&raw, &rules(), Some(DnsListenerMode::Auto), false, Some(45057)).unwrap();
    assert_eq!(yaml["dns"]["listen"], "127.0.0.1:45058");
    assert_eq!(yaml["mixed-port"], 45057);
}

#[test]
fn guard_port_53_and_lan_are_never_silently_moved() {
    let yaml = plan(RAW, &rules(), Some(DnsListenerMode::Auto), true, Some(45061)).unwrap();
    assert_eq!(yaml["dns"]["listen"], "127.0.0.1:53");
    assert_eq!(yaml[KEY]["movable"], false);
    for listen in ["127.0.0.1:53", "0.0.0.0:1053", "192.0.2.5:1053"] {
        let yaml = plan(&RAW.replace("127.0.0.1:1053", listen), &rules(), Some(DnsListenerMode::Auto), false, None).unwrap();
        assert_eq!(yaml["dns"]["listen"], listen);
        assert_eq!(yaml[KEY]["movable"], false);
    }
    for mode in [DnsListenerMode::Off, DnsListenerMode::Fixed] {
        assert!(plan(RAW, &Overrides::default(), Some(mode), true, None).is_err());
    }
    assert!(plan("dns: {enable: false}", &rules(), Some(DnsListenerMode::Auto), true, None).is_err());
}

#[test]
fn fixed_listener_obeys_lan_boundary() {
    let config = Overrides::default();
    let mut settings = DnsSettings { listener_mode: Some(DnsListenerMode::Fixed), ..Default::default() };
    let yaml: Value = serde_yaml::from_str(&compose_with(RAW, &config, &settings, false, None, false).unwrap()).unwrap();
    assert_eq!(yaml["dns"]["listen"], "127.0.0.1:1053");
    settings.listen = "192.0.2.5:1053".into();
    assert!(compose_with(RAW, &config, &settings, false, None, false).is_err());
    assert!(compose_with(RAW, &config, &settings, false, None, true).is_ok());
}

#[test]
fn runtime_allocator_checks_tcp_udp_and_updates_capture_destination() {
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        // Each transport alone must prevent allocation of that address.
        let tcp = crate::storage::reserve_test_mixed_port();
        let tcp_addr = tcp.local_addr().unwrap();
        let udp = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        let udp_addr = udp.local_addr().unwrap();
        for addr in [tcp_addr, udp_addr] {
            let raw = format!("dns: {{enable: true, listen: '{addr}'}}\n{KEY}: {{movable: true}}\nnetbox-capture: {{dns_port: {}}}\nmixed-port: {FIRST_PORT}\n", addr.port());
            let yaml: Value = serde_yaml::from_str(&resolve_for_apply(&raw, 0).await.unwrap()).unwrap();
            let actual = super::super::dns_runtime::parse_listen(yaml["dns"]["listen"].as_str().unwrap()).unwrap();
            assert_ne!(actual.port(), addr.port());
            assert_ne!(actual.port(), FIRST_PORT);
            assert_eq!(yaml["netbox-capture"]["dns_port"].as_u64(), Some(actual.port() as u64));
            assert_eq!(yaml["mixed-port"], FIRST_PORT);
        }
        // The active core's port can be reused without needless reload/allocation.
        let raw = format!("dns: {{enable: true, listen: '{tcp_addr}'}}\n{KEY}: {{movable: true}}\n");
        let yaml: Value = serde_yaml::from_str(&resolve_for_apply(&raw, std::process::id()).await.unwrap()).unwrap();
        assert_eq!(yaml["dns"]["listen"], tcp_addr.to_string());
        let fixed = RAW.replace("127.0.0.1:1053", &tcp_addr.to_string());
        assert_eq!(resolve_for_apply(&fixed, 0).await.unwrap(), fixed);
        assert!(super::super::dns_runtime::preflight(&fixed, 0).await.is_err());
    });
}
