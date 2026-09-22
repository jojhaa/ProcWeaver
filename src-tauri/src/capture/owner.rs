use super::packet::Flow;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
#[link(name = "iphlpapi")]
extern "system" {
    fn GetExtendedTcpTable(
        table: *mut std::ffi::c_void,
        size: *mut u32,
        order: i32,
        family: u32,
        class: i32,
        reserved: u32,
    ) -> u32;
    fn GetExtendedUdpTable(
        table: *mut std::ffi::c_void,
        size: *mut u32,
        order: i32,
        family: u32,
        class: i32,
        reserved: u32,
    ) -> u32;
}
/// The TCP SYN is held at NETWORK while consulting the owning endpoint table.
/// Unlike an asynchronously rebuilt PROCESS-PATH list, this also covers a child
/// that opens its first connection immediately after creation.
pub fn lookup(flow: Flow) -> Option<u32> {
    let v6 = flow.source.is_ipv6();
    let tcp = flow.protocol == 6;
    let call = if tcp {
        GetExtendedTcpTable
    } else {
        GetExtendedUdpTable
    };
    let mut size = 0;
    unsafe {
        call(
            std::ptr::null_mut(),
            &mut size,
            0,
            if v6 { 23 } else { 2 },
            if tcp { 5 } else { 1 },
            0,
        );
    }
    for _ in 0..3 {
        if size > 16 * 1024 * 1024 || size < 4 {
            return None;
        }
        let mut memory = vec![0u64; (size as usize + 7) / 8];
        let result = unsafe {
            call(
                memory.as_mut_ptr().cast(),
                &mut size,
                0,
                if v6 { 23 } else { 2 },
                if tcp { 5 } else { 1 },
                0,
            )
        };
        if result == 122 {
            continue;
        }
        if result != 0 {
            return None;
        }
        let bytes =
            unsafe { std::slice::from_raw_parts(memory.as_ptr().cast::<u8>(), size as usize) };
        let count = u32::from_ne_bytes(bytes[..4].try_into().ok()?) as usize;
        let row_size = match (tcp, v6) {
            (true, false) => 24,
            (true, true) => 56,
            (false, false) => 12,
            (false, true) => 28,
        };
        if count > (bytes.len() - 4) / row_size {
            return None;
        }
        let mut owner = None;
        for row in bytes[4..4 + count * row_size].chunks_exact(row_size) {
            let ip = |offset| -> Option<IpAddr> {
                Some(if v6 {
                    Ipv6Addr::from(<[u8; 16]>::try_from(&row[offset..offset + 16]).ok()?).into()
                } else {
                    Ipv4Addr::from(<[u8; 4]>::try_from(&row[offset..offset + 4]).ok()?).into()
                })
            };
            let local = if tcp && !v6 { 4 } else { 0 };
            let port = if v6 {
                20
            } else if tcp {
                8
            } else {
                4
            };
            if u16::from_be_bytes([row[port], row[port + 1]]) != flow.source.port() {
                continue;
            }
            let address = ip(local)?;
            if address != flow.source.ip() && !address.is_unspecified() {
                continue;
            }
            if tcp {
                let remote = if v6 { 24 } else { 12 };
                let remote_port = if v6 { 44 } else { 16 };
                if ip(remote)? != flow.destination.ip()
                    || u16::from_be_bytes([row[remote_port], row[remote_port + 1]])
                        != flow.destination.port()
                {
                    continue;
                }
            }
            let pid = u32::from_ne_bytes(row[row_size - 4..].try_into().ok()?);
            if owner.is_some_and(|old| old != pid) {
                return None;
            } // shared UDP port: do not guess.
            owner = Some(pid);
        }
        return owner;
    }
    None
}
