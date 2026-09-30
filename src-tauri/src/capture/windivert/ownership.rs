//! Bounded socket-event attribution for NEW flows. This index does not claim
//! SOCKET events always arrive before NETWORK, or infer an app behind Dnscache.
use std::{collections::{BTreeSet, HashMap, HashSet}, net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr}};
use super::driver::Address;

const MAX_ENDPOINTS: usize = 8192;

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct Identity { pub pid: u32, pub created_at: u64, pub path: String }
impl Identity {
    /// Inspect only a candidate process, never scan all processes per packet.
    pub fn inspect(pid: u32) -> Option<Self> {
        let entry = crate::routing_overrides::native::inspect(pid, 0, String::new());
        (entry.created_at != 0).then_some(Self { pid, created_at:entry.created_at, path:entry.executable_path? })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind { Bind, Connect, Close }
#[derive(Clone, Debug)]
pub struct Event {
    pub kind: Kind,
    pub timestamp: i64,
    pub endpoint: u64,
    pub pid: u32,
    pub local: SocketAddr,
    pub remote: SocketAddr,
    pub protocol: u8,
}

fn address(words: &[u8], v6: bool) -> Option<IpAddr> {
    let words: Vec<u32> = words.chunks_exact(4).map(|v| u32::from_ne_bytes(v.try_into().unwrap())).collect();
    if words.len() != 4 { return None; }
    // WinDivert stores the entire IPv6 integer in host byte order; IPv4 is
    // represented by the low word of its mapped address. Verified by native lab.
    if !v6 { return Some(Ipv4Addr::from(words[0]).into()); }
    let mut bytes = [0; 16];
    for (output, word) in bytes.chunks_exact_mut(4).zip(words.iter().rev()) { output.copy_from_slice(&word.to_be_bytes()); }
    Some(Ipv6Addr::from(bytes).into())
}
impl Event {
    pub(crate) fn decode(source: &Address) -> Option<Self> {
        if source.flags & 255 != 3 { return None; } // SOCKET only, not FLOW_ESTABLISHED.
        let kind = match (source.flags >> 8) & 255 { 3 => Kind::Bind, 4 => Kind::Connect, 7 => Kind::Close, _ => return None };
        let mut bytes = [0; 64];
        for (output, word) in bytes.chunks_exact_mut(8).zip(source.data) { output.copy_from_slice(&word.to_ne_bytes()); }
        let v6 = source.flags & (1 << 20) != 0;
        let result = Self { kind, timestamp:source.timestamp, endpoint:u64::from_ne_bytes(bytes[..8].try_into().ok()?),
            pid:u32::from_ne_bytes(bytes[16..20].try_into().ok()?),
            local:SocketAddr::new(address(&bytes[20..36], v6)?, u16::from_ne_bytes(bytes[52..54].try_into().ok()?)),
            remote:SocketAddr::new(address(&bytes[36..52], v6)?, u16::from_ne_bytes(bytes[54..56].try_into().ok()?)), protocol:bytes[56] };
        (result.endpoint != 0 && result.pid != 0 && matches!(result.protocol, 6 | 17)).then_some(result)
    }
}

type Bucket = (bool, u8, u16);
fn bucket(local: SocketAddr, protocol: u8) -> Bucket { (local.is_ipv6(), protocol, local.port()) }
struct Entry { event: Event, identity: Option<Identity> }

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Owner { pub endpoint: u64, pub observed_at: i64, pub identity: Identity }

pub struct Index {
    entries: HashMap<u64, Entry>,
    buckets: HashMap<Bucket, HashSet<u64>>,
    closed: HashMap<u64, i64>,
    closed_order: BTreeSet<(i64, u64)>,
    discarded_before: i64,
    // Lost events can hide a shared UDP socket. Capacity failure invalidates
    // attribution until the caller rebuilds, rather than evicting another owner.
    healthy: bool,
}
impl Default for Index {
    fn default() -> Self { Self { entries:HashMap::new(), buckets:HashMap::new(), closed:HashMap::new(), closed_order:BTreeSet::new(), discarded_before:0, healthy:true } }
}
impl Index {
    pub fn current(&self, owner: &Owner) -> bool {
        self.healthy && self.entries.get(&owner.endpoint).is_some_and(|e|e.event.timestamp==owner.observed_at&&e.identity.as_ref()==Some(&owner.identity))
    }
    pub fn len(&self) -> usize { self.entries.len() }
    pub fn is_empty(&self) -> bool { self.entries.is_empty() }
    pub fn invalidate(&mut self) { self.healthy = false; }
    fn remember_close(&mut self, endpoint: u64, timestamp: i64) {
        if let Some(previous) = self.closed.insert(endpoint, timestamp) { self.closed_order.remove(&(previous, endpoint)); }
        self.closed_order.insert((timestamp, endpoint));
        if self.closed.len() > MAX_ENDPOINTS {
            if let Some((oldest, endpoint)) = self.closed_order.pop_first() {
                self.closed.remove(&endpoint); self.discarded_before = self.discarded_before.max(oldest);
            }
        }
    }
    fn remove(&mut self, endpoint: u64) {
        if let Some(entry) = self.entries.remove(&endpoint) {
            let key = bucket(entry.event.local, entry.event.protocol);
            if let Some(ids) = self.buckets.get_mut(&key) {
                ids.remove(&endpoint);
                if ids.is_empty() { self.buckets.remove(&key); }
            }
        }
    }
    pub fn apply(&mut self, event: Event, identity: Option<Identity>) -> Result<(), &'static str> {
        if !self.healthy { return Err("连接事件索引需重建"); }
        if event.endpoint == 0 || event.pid == 0 || event.timestamp <= 0 || !matches!(event.protocol, 6 | 17)
            || event.local.is_ipv6() != event.remote.is_ipv6() { return Err("连接事件无效"); }
        if event.timestamp <= self.discarded_before || self.closed.get(&event.endpoint).is_some_and(|stamp| *stamp >= event.timestamp) { return Ok(()); }
        if self.entries.get(&event.endpoint).is_some_and(|old| old.event.timestamp >= event.timestamp) { return Ok(()); }
        if event.kind == Kind::Close {
            // A late close for an older PID cannot erase a newer endpoint owner.
            if self.entries.get(&event.endpoint).is_none_or(|old| old.event.pid == event.pid) {
                self.remove(event.endpoint); self.remember_close(event.endpoint, event.timestamp);
            }
            return Ok(());
        }
        if event.local.port() == 0 { return Ok(()); }
        if !self.entries.contains_key(&event.endpoint) && self.entries.len() >= MAX_ENDPOINTS {
            self.invalidate(); return Err("连接事件超过容量限制，身份核验已降级");
        }
        let identity = identity.filter(|id| id.pid == event.pid && id.created_at != 0 && !id.path.is_empty());
        self.remove(event.endpoint);
        self.buckets.entry(bucket(event.local, event.protocol)).or_default().insert(event.endpoint);
        self.entries.insert(event.endpoint, Entry { event, identity });
        Ok(())
    }
    /// Called once when establishing a new flow, not on each packet. The caller
    /// supplies a fresh identity read to reject PID reuse and unreadable targets.
    pub fn resolve(&self, local: SocketAddr, remote: SocketAddr, protocol: u8, packet_timestamp: i64,
        mut inspect: impl FnMut(u32) -> Option<Identity>) -> Option<Owner> {
        if !self.healthy || local.is_ipv6() != remote.is_ipv6() { return None; }
        // SOCKET metadata lacks an interface scope. Do not merge scoped IPv6.
        if [local, remote].iter().any(|v| match v { SocketAddr::V6(v) => v.scope_id() != 0 || v.ip().is_unicast_link_local(), _ => false }) { return None; }
        let candidates = self.buckets.get(&bucket(local, protocol))?;
        let mut selected = None;
        for endpoint in candidates {
            let entry = self.entries.get(endpoint)?;
            let event = &entry.event;
            if event.timestamp > packet_timestamp || (event.local.ip() != local.ip() && !event.local.ip().is_unspecified()) { continue; }
            if protocol == 6 && (event.kind != Kind::Connect || event.remote != remote) { continue; }
            if protocol == 17 && event.kind == Kind::Connect && event.remote != remote { continue; }
            // Even an unverified competing socket makes UDP attribution unsafe.
            let identity = entry.identity.as_ref()?;
            if inspect(identity.pid).as_ref() != Some(identity) || selected.is_some() { return None; }
            selected = Some(Owner { endpoint:*endpoint, observed_at:event.timestamp, identity:identity.clone() });
        }
        selected
    }
}

#[cfg(test)]
mod tests;
