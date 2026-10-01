use super::*;
use super::super::udp;
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::{TcpListener, UdpSocket}, sync::mpsc};

fn stun_success(id: &[u8; 12], ipv6: bool, fingerprint: bool) -> Vec<u8> {
    let mut packet = stun_request(id); packet[0] = 1; packet[1] = 1;
    let mut value = vec![0, if ipv6 { 2 } else { 1 }]; value.extend((54321u16 ^ 0x2112).to_be_bytes());
    let address = if ipv6 { "2001:db8::1".parse::<std::net::Ipv6Addr>().unwrap().octets().to_vec() } else { vec![192, 0, 2, 10] };
    let mask: Vec<_> = COOKIE.iter().chain(id.iter()).copied().collect();
    value.extend(address.iter().zip(mask.iter()).map(|(a, b)| a ^ b));
    packet.extend([0, 0x20, 0, value.len() as u8]); packet.extend(value);
    let len = packet.len() - 20 + if fingerprint { 8 } else { 0 };
    packet[2..4].copy_from_slice(&(len as u16).to_be_bytes());
    if fingerprint { let crc = crc32(&packet) ^ 0x5354554e; packet.extend([0x80, 0x28, 0, 4]); packet.extend(crc.to_be_bytes()); }
    packet
}

#[test]
fn stun_requires_matching_transaction_and_complete_mapped_address() {
    let id = [7; 12];
    for ipv6 in [false, true] {
        for fingerprint in [false, true] {
            let packet = stun_success(&id, ipv6, fingerprint);
            assert!(stun_reply(&packet, &id).unwrap().is_some());
            assert!(stun_reply(&packet, &[8; 12]).unwrap().is_none());
            for len in 0..packet.len() { assert!(!matches!(stun_reply(&packet[..len], &id), Ok(Some(_)))); }
            if fingerprint { let mut bad = packet.clone(); *bad.last_mut().unwrap() ^= 1; assert!(stun_reply(&bad, &id).unwrap_err().contains("指纹")); }
        }
    }
    let mut missing = stun_request(&id); missing[0] = 1;
    assert!(stun_reply(&missing, &id).unwrap_err().contains("映射地址"));
    let mut wrong = stun_success(&id, false, false); wrong[25] = 8;
    assert!(stun_reply(&wrong, &id).is_err());
}

#[test]
fn stun_errors_and_required_attributes_do_not_report_success() {
    let id = [1; 12]; let mut packet = stun_request(&id);
    packet[0..4].copy_from_slice(&[1, 0x11, 0, 8]); packet.extend([0, 9, 0, 4, 0, 0, 4, 3]);
    assert!(stun_reply(&packet, &id).unwrap_err().contains("403"));
    packet[21] = 0x33;
    assert!(stun_reply(&packet, &id).unwrap_err().contains("必需属性"));
}

#[test]
fn dns_probe_rejects_wrong_questions_and_malformed_record_envelopes() {
    let query = dns::query("example.test", 123).unwrap();
    let mut reply = dns::failure(&query, 0);
    assert_eq!(dns::probe_reply(&query, &reply).unwrap(), Some((0, false)));
    reply[2] |= 2;
    assert_eq!(dns::probe_reply(&query, &reply).unwrap(), Some((0, true)));
    reply[0] ^= 1; assert_eq!(dns::probe_reply(&query, &reply).unwrap(), None); reply[0] ^= 1;
    reply[7] = 1; assert!(dns::probe_reply(&query, &reply).is_err());
    reply.extend([0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 1, 0, 4, 192, 0, 2, 1]);
    assert!(dns::probe_reply(&query, &reply).unwrap().is_some());
    reply.pop(); assert!(dns::probe_reply(&query, &reply).is_err());
    let mut cyclic = dns::failure(&query, 0); cyclic[7] = 1; let at = cyclic.len();
    cyclic.extend([0xc0, at as u8]); assert!(dns::probe_reply(&query, &cyclic).is_err());
    assert!(dns::probe_reply(&query, &dns::failure(&dns::query("other.test", 123).unwrap(), 0)).unwrap().is_none());
    let mut interior = dns::failure(&query, 0); interior[7] = 1;
    // Offset 26 is the high (zero) byte of QTYPE, not a name label boundary.
    interior.extend([0xc0, (query.len() - 4) as u8, 0, 1, 0, 1, 0, 0, 0, 1, 0, 4, 192, 0, 2, 1]);
    assert!(dns::probe_reply(&query, &interior).is_err());
}

#[test]
fn dns_probe_accepts_address_records_compressed_to_prior_cname_target() {
    let query = dns::query("example.test", 124).unwrap();
    let mut reply = dns::failure(&query, 0); reply[7] = 2;
    reply.extend([0xc0, 12, 0, 5, 0, 1, 0, 0, 0, 60, 0, 8]);
    let alias = reply.len(); reply.extend([5, b'a', b'l', b'i', b'a', b's', 0xc0, 20]);
    reply.extend([0xc0, alias as u8, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 192, 0, 2, 1]);
    assert_eq!(dns::probe_reply(&query, &reply).unwrap(), Some((0, false)));
}

#[derive(Clone, Copy)]
enum Reply { Dns(u8, bool), Stun, Silent, Reject, DropFirst }
struct Lab { endpoint: Endpoint, task: tokio::task::JoinHandle<()>, events: mpsc::UnboundedReceiver<(u8, Destination, Vec<u8>)> }
impl Drop for Lab { fn drop(&mut self) { self.task.abort(); } }
async fn lab(response: Reply, auth: bool) -> Lab {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap(); let port = listener.local_addr().unwrap().port();
    let (send, events) = mpsc::unbounded_channel();
    let task = tokio::spawn(async move {
        let mut children = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                Some(_) = children.join_next(), if !children.is_empty() => {},
                accepted = listener.accept() => {
                    let (mut tcp, _) = accepted.unwrap(); let send = send.clone();
                    children.spawn(async move {
                        let mut hello = [0; 3]; tcp.read_exact(&mut hello).await.unwrap();
                        assert_eq!(hello, [5, 1, if auth { 2 } else { 0 }]); tcp.write_all(&[5, hello[2]]).await.unwrap();
                        if auth {
                            assert_eq!(tcp.read_u8().await.unwrap(), 1);
                            for expected in [b"user".as_slice(), b"pass".as_slice()] {
                                let len = tcp.read_u8().await.unwrap(); let mut bytes = vec![0; len as usize]; tcp.read_exact(&mut bytes).await.unwrap(); assert_eq!(bytes, expected);
                            }
                            tcp.write_all(&[1, 0]).await.unwrap();
                        }
                        let mut head = [0; 4]; tcp.read_exact(&mut head).await.unwrap();
                        let target = transport::read_address(&mut tcp, head[3]).await.unwrap();
                        send.send((head[1], target, vec![])).unwrap();
                        if matches!(response, Reply::Reject) { tcp.write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0]).await.unwrap(); return; }
                        if head[1] == 1 { tcp.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await.unwrap(); let _ = tcp.read_u8().await; return; }
                        assert_eq!(head[1], 3);
                        let udp = UdpSocket::bind("127.0.0.1:0").await.unwrap();
                        let mut bind = vec![5, 0, 0, 1, 127, 0, 0, 1]; bind.extend(udp.local_addr().unwrap().port().to_be_bytes()); tcp.write_all(&bind).await.unwrap();
                        let mut buffer = vec![0; 65535]; let mut packets = 0;
                        loop {
                            tokio::select! {
                                _ = tcp.read_u8() => { let _ = send.send((255, Destination::new("127.0.0.1", 1).unwrap(), vec![])); break; },
                                received = udp.recv_from(&mut buffer) => {
                                    let (len, source) = received.unwrap(); let (target, data) = udp::decode(&buffer[..len]).unwrap();
                                    send.send((17, target.clone(), data.to_vec())).unwrap(); packets += 1;
                                    if matches!(response, Reply::Silent) || matches!(response, Reply::DropFirst) && packets == 1 { continue; }
                                    let mut packet = match response {
                                        Reply::Dns(code, tc) => { let mut v = dns::failure(data, code); if tc { v[2] |= 2; } v },
                                        _ => stun_success(data[8..20].try_into().unwrap(), true, true),
                                    };
                                    // A reply from a different transaction must be ignored.
                                    packet[if matches!(response, Reply::Dns(..)) { 0 } else { 8 }] ^= 1;
                                    udp.send_to(&udp::encode(&target, &packet).unwrap(), source).await.unwrap();
                                    packet[if matches!(response, Reply::Dns(..)) { 0 } else { 8 }] ^= 1;
                                    udp.send_to(&udp::encode(&target, &packet).unwrap(), source).await.unwrap();
                                }
                            }
                        }
                    });
                }
            }
        }
    });
    Lab { endpoint: Endpoint { id: "fixture".into(), name: "fixture".into(), protocol: "socks5".into(), host: "127.0.0.1".into(), port,
        username: if auth { "user".into() } else { String::new() }, secret: if auth { super::super::secrets::protect("pass").unwrap() } else { String::new() } }, task, events }
}
async fn events_until_closed(lab: &mut Lab) -> Vec<(u8, Destination, Vec<u8>)> {
    tokio::time::timeout(Duration::from_secs(2), async {
        let mut events = vec![];
        while let Some(event) = lab.events.recv().await { let closed = event.0 == 255; events.push(event); if closed { break; } }
        events
    }).await.unwrap()
}

#[tokio::test]
async fn dns_uses_explicit_target_and_query_with_no_tcp_retry_even_when_truncated() {
    let mut fixture = lab(Reply::Dns(0, true), true).await;
    let target = Destination::new("2001:db8::53", 5353).unwrap();
    let message = run(&fixture.endpoint, target.clone(), "udp_dns", Some("example.test"), 2000, &[]).await.unwrap();
    assert!(message.contains("截断"));
    let events = events_until_closed(&mut fixture).await;
    assert!(!events.iter().any(|e| e.0 == 1));
    let udp = events.iter().find(|e| e.0 == 17).unwrap();
    assert_eq!(udp.1.authority(), target.authority()); assert_eq!(dns::question(&udp.2).unwrap().name, "example.test");
}

#[tokio::test]
async fn dns_negative_answer_distinguishes_reachability_from_resolution_failure() {
    for (code, success) in [(3, true), (2, false), (5, false)] {
        let fixture = lab(Reply::Dns(code, false), false).await;
        let result = run(&fixture.endpoint, Destination::new("192.0.2.53", 53).unwrap(), "udp_dns", Some("missing.test"), 2000, &[]).await;
        assert_eq!(result.is_ok(), success);
        if success { assert!(result.unwrap().contains("NXDOMAIN")); } else { assert!(result.unwrap_err().contains("RCODE")); }
    }
}

#[tokio::test]
async fn udp_stun_roundtrip_keeps_domain_remote_and_recovers_one_lost_packet() {
    for response in [Reply::Stun, Reply::DropFirst] {
        let mut fixture = lab(response, false).await;
        let target = Destination::new("unresolved.fixture.invalid", 3478).unwrap();
        assert!(run(&fixture.endpoint, target.clone(), "udp_stun", None, 3000, &[]).await.unwrap().contains("往返成功"));
        let events = events_until_closed(&mut fixture).await;
        let sent: Vec<_> = events.iter().filter(|e| e.0 == 17).collect();
        assert_eq!(sent.len(), if matches!(response, Reply::DropFirst) { 2 } else { 1 });
        assert!(sent.iter().all(|e| e.1.authority() == target.authority()));
        if sent.len() == 2 { assert_eq!(sent[0].2, sent[1].2); }
    }
}

#[tokio::test]
async fn udp_timeout_drops_association_and_never_succeeds_from_handshake_alone() {
    let mut fixture = lab(Reply::Silent, false).await;
    let result = run(&fixture.endpoint, Destination::new("192.0.2.1", 3478).unwrap(), "udp_stun", None, 1000, &[]).await;
    assert!(result.unwrap_err().contains("超时"));
    let events = events_until_closed(&mut fixture).await;
    assert!(events.iter().any(|e| e.0 == 255)); assert!(!events.iter().any(|e| e.0 == 1));
}

#[tokio::test]
async fn tcp_connect_and_udp_rejection_remain_distinct() {
    let fixture = lab(Reply::Stun, false).await;
    assert!(run(&fixture.endpoint, Destination::new("example.test", 443).unwrap(), "tcp", None, 2000, &[]).await.unwrap().contains("TCP"));
    let fixture = lab(Reply::Reject, false).await;
    assert!(run(&fixture.endpoint, Destination::new("example.test", 53).unwrap(), "udp_dns", Some("example.test"), 2000, &[]).await.unwrap_err().contains("拒绝 UDP"));
}

#[tokio::test]
async fn invalid_probe_arguments_and_http_udp_fail_before_network() {
    let mut fixture = lab(Reply::Stun, false).await; let target = Destination::new("example.test", 443).unwrap();
    assert!(run(&fixture.endpoint, target.clone(), "bad", None, 1000, &[]).await.is_err());
    assert!(run(&fixture.endpoint, target.clone(), "tcp", None, 0, &[]).await.is_err());
    assert!(run(&fixture.endpoint, target.clone(), "tcp", None, 30001, &[]).await.is_err());
    assert!(run(&fixture.endpoint, target.clone(), "udp_dns", None, 1000, &[]).await.is_err());
    assert!(run(&fixture.endpoint, target.clone(), "udp_dns", Some("192.0.2.1"), 1000, &[]).await.is_err());
    fixture.endpoint.protocol = "http".into();
    assert!(run(&fixture.endpoint, target, "udp_stun", None, 1000, &[]).await.unwrap_err().contains("SOCKS5"));
    assert!(fixture.events.try_recv().is_err());
}
