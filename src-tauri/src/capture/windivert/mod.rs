//! Optional, explicitly selected Windows capture backend. Legacy `windivert`
//! preferences never opt into the versioned mode or extract/load components.
pub mod assets;
pub mod plan;
pub mod ports;
pub mod runtime;
pub mod session;
pub mod context;
pub mod preflight;
pub mod helper;
pub mod udp;
pub mod dns;
pub mod ownership;
#[path = "../driver.rs"]
pub(crate) mod driver;
#[path = "../packet.rs"]
#[allow(dead_code)] // The TCP lab deliberately does not exercise legacy UDP helpers.
mod packet;
#[path = "../socks.rs"]
pub(crate) mod socks;
#[path = "../owner.rs"]
mod owner;
/// Read-only endpoint ownership; does not extract, load or open WinDivert.
pub(crate) fn tcp_owner(source: std::net::SocketAddr, destination: std::net::SocketAddr) -> Option<u32> {
    owner::lookup(packet::Flow { source, destination, protocol: 6 })
}
/// IP Helper lookup only; no driver dependency or extraction.
pub(crate) fn udp_owner(source: std::net::SocketAddr) -> Option<u32> {
    owner::lookup(packet::Flow { source, destination: source, protocol: 17 })
}
#[cfg(test)]
mod tcp_lab;
#[cfg(test)]
mod udp_lab;
#[cfg(test)]
mod lab;
