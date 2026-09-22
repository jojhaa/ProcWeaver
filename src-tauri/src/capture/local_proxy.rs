//! Only the explicitly configured, enabled loopback system proxy is eligible.
use super::packet::Flow;
use std::{collections::HashMap, net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr}, time::{Duration, Instant}};

pub fn endpoints() -> Vec<SocketAddr> {
    use winreg::{enums::*, RegKey};
    let Ok(key) = RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(
        "Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", KEY_READ) else { return vec![]; };
    if key.get_value::<u32, _>("ProxyEnable").unwrap_or(0) == 0 { return vec![]; }
    parse(&key.get_value::<String, _>("ProxyServer").unwrap_or_default())
}
fn parse(text: &str) -> Vec<SocketAddr> {
    let mut result = vec![];
    for entry in text.split(';').take(16) {
        let address = match entry.split_once('=') { Some((kind,v)) if ["http","https","socks"].contains(&kind.trim().to_ascii_lowercase().as_str()) => v, Some(_) => continue, None => entry }.trim();
        if let Some(port) = address.to_ascii_lowercase().strip_prefix("localhost:").and_then(|v| v.parse::<u16>().ok()).filter(|p| *p != 0) {
            result.extend([SocketAddr::from(([127,0,0,1],port)), SocketAddr::from((Ipv6Addr::LOCALHOST,port))]);
        } else if let Ok(address) = address.parse::<SocketAddr>() {
            if address.ip().is_loopback() && address.port() != 0 { result.push(address); }
        }
    }
    result.sort(); result.dedup(); result
}
fn reverse(flow: Flow) -> Flow { Flow { source: flow.destination, destination: flow.source, protocol: flow.protocol } }
struct Entry { to: Flow, peer: Flow, touched: Instant, closed: bool, established: bool }
#[derive(Default)]
pub struct Nat { entries: HashMap<Flow, Entry> }
impl Nat {
    pub fn forget(&mut self, flow: Flow) {
        if let Some(entry) = self.entries.remove(&flow) { self.entries.remove(&entry.peer); }
    }
    pub fn translate(&mut self, flow: Flow, closed: bool, acknowledged: bool) -> Option<Flow> {
        let entry = self.entries.get_mut(&flow)?;
        entry.touched = Instant::now(); entry.closed |= closed; entry.established |= acknowledged;
        let (to, peer) = (entry.to, entry.peer);
        if let Some(other) = self.entries.get_mut(&peer) { other.touched = Instant::now(); other.closed |= closed; other.established |= acknowledged; }
        Some(to)
    }
    pub fn insert(&mut self, flow: Flow, port: u16) -> bool {
        if self.entries.len() >= 4096 { return false; }
        let ip: IpAddr = if flow.source.is_ipv4() { Ipv4Addr::LOCALHOST.into() } else { Ipv6Addr::LOCALHOST.into() };
        let translated = Flow { destination: SocketAddr::new(ip,port), ..flow };
        let peer = reverse(translated);
        // Never merge different original connections into the same local tuple.
        if self.entries.contains_key(&peer) || super::owner::lookup(translated).is_some() { return false; }
        self.entries.insert(flow, Entry { to: translated, peer, touched: Instant::now(), closed: false, established: false });
        self.entries.insert(peer, Entry { to: reverse(flow), peer: flow, touched: Instant::now(), closed: false, established: false });
        true
    }
    pub fn cleanup(&mut self) {
        self.entries.retain(|_, e| if !e.established { e.touched.elapsed() < Duration::from_secs(30) } else { !e.closed || e.touched.elapsed() < Duration::from_secs(60) });
    }
}
#[cfg(test)]
mod tests {
    #[test]
    fn system_proxy_endpoints_are_scoped() {
        let values=super::parse("http=localhost:10811;https=[::1]:7890;socks=127.0.0.1:9000;http=192.168.1.1:80;bad;127.0.0.1:0");
        assert_eq!(values.len(),4);
        assert!(values.iter().all(|v| v.ip().is_loopback() && v.port() != 0));
    }
    #[test]
    fn tuples_do_not_merge_and_closed_routes_are_reclaimed() {
        let source=std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let target=std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let flow=super::Flow{source:source.local_addr().unwrap(),destination:"127.0.0.1:10811".parse().unwrap(),protocol:6};
        let mut nat=super::Nat::default();
        assert!(nat.insert(flow,target.local_addr().unwrap().port()));
        assert!(!nat.insert(super::Flow{destination:"127.0.0.1:10812".parse().unwrap(),..flow},target.local_addr().unwrap().port()));
        let mapped=nat.translate(flow,false,false).unwrap();
        assert_eq!(nat.translate(super::reverse(mapped),false,true),Some(super::reverse(flow)));
        for entry in nat.entries.values_mut(){entry.touched=super::Instant::now()-super::Duration::from_secs(61);}
        nat.cleanup();assert_eq!(nat.entries.len(),2); // Idle established connections survive.
        for entry in nat.entries.values_mut(){entry.closed=true;}
        nat.cleanup();assert!(nat.entries.is_empty());
        assert!(nat.insert(flow,target.local_addr().unwrap().port()));
        nat.forget(flow);assert!(nat.entries.is_empty());
    }
}
