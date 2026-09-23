//! Read-only adapter inspection. No PowerShell process or localized netsh parsing.
use std::{ffi::CStr, net::Ipv4Addr};
use windows_sys::Win32::{Foundation::ERROR_BUFFER_OVERFLOW, NetworkManagement::IpHelper::*, Networking::WinSock::*};
use winreg::{enums::HKEY_LOCAL_MACHINE, RegKey};

pub(super) struct Adapter { pub alias: String, pub automatic: bool, pub servers: Vec<String> }

unsafe fn wide(pointer: *const u16) -> String {
    if pointer.is_null() { return String::new(); }
    let mut len = 0;
    while len < 32768 && *pointer.add(len) != 0 { len += 1; }
    String::from_utf16_lossy(std::slice::from_raw_parts(pointer, len))
}

pub(super) fn read(alias: Option<&str>) -> Result<Adapter, String> {
    // u64 supplies the alignment required by IP_ADAPTER_ADDRESSES. Retry when
    // adapters change between reads; never reuse a previous machine snapshot.
    let mut buffer = vec![0u64; 2048];
    for _ in 0..3 {
        let mut size = (buffer.len() * 8) as u32;
        let code = unsafe { GetAdaptersAddresses(AF_INET as u32, GAA_FLAG_INCLUDE_GATEWAYS | GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST,
            std::ptr::null(), buffer.as_mut_ptr().cast(), &mut size) };
        if code == ERROR_BUFFER_OVERFLOW {
            if size > 4 * 1024 * 1024 { return Err("网卡信息超过读取上限".into()); }
            buffer.resize((size as usize).div_ceil(8), 0); continue;
        }
        if code != 0 { return Err(format!("读取网卡 DNS 失败（系统代码 {code}）")); }
        unsafe {
            let mut pointer = buffer.as_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>();
            let mut selected: Option<&IP_ADAPTER_ADDRESSES_LH> = None;
            while let Some(item) = pointer.as_ref() {
                let matches = alias.map_or(item.OperStatus == 1 && !item.FirstGatewayAddress.is_null(), |name| wide(item.FriendlyName) == name);
                if matches && selected.is_none_or(|old| item.Ipv4Metric < old.Ipv4Metric) { selected = Some(item); }
                pointer = item.Next;
            }
            let item = selected.ok_or("未找到指定网卡或活跃上网网卡")?;
            if item.AdapterName.is_null() { return Err("网卡标识不可读".into()); }
            let id = CStr::from_ptr(item.AdapterName.cast()).to_str().map_err(|_| "网卡标识无效")?;
            let key = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(format!(r"SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces\{id}"))
                .map_err(|_| "无法读取网卡 DNS 配置来源，未修改系统设置")?;
            let configured: String = match key.get_value("NameServer") {
                Ok(value) => value,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
                Err(_) => return Err("无法核实网卡 DNS 配置来源，未修改系统设置".into()),
            };
            let mut servers = Vec::new();
            let mut dns = item.FirstDnsServerAddress;
            while let Some(entry) = dns.as_ref() {
                if !entry.Address.lpSockaddr.is_null() && entry.Address.iSockaddrLength as usize >= std::mem::size_of::<SOCKADDR_IN>() {
                    let address = &*entry.Address.lpSockaddr.cast::<SOCKADDR_IN>();
                    if address.sin_family == AF_INET { servers.push(Ipv4Addr::from(address.sin_addr.S_un.S_addr.to_ne_bytes()).to_string()); }
                }
                dns = entry.Next;
            }
            return Ok(Adapter { alias: wide(item.FriendlyName), automatic: configured.trim().is_empty(), servers });
        }
    }
    Err("网卡正在变化，请稍后重试".into())
}

#[cfg(test)]
mod tests {
    #[test]
    fn performance_native_adapter_query_is_read_only_and_returns_ipv4() {
        let adapter = super::read(None).expect("测试主机需要活跃 IPv4 网卡");
        assert!(!adapter.alias.is_empty());
        assert!(adapter.servers.iter().all(|ip| ip.parse::<std::net::Ipv4Addr>().is_ok()));
        let same = super::read(Some(&adapter.alias)).unwrap();
        assert_eq!(same.alias, adapter.alias);
    }
}
