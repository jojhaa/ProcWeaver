//! Bounded, passive identification. Never decrypt TLS or replace the destination IP.
use super::transport::Destination;
pub(super) enum Found {
    NeedMore,
    Done(Option<String>),
}
fn host(value: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(value).ok()?;
    let host = if text.starts_with('[') {
        text.split(']').next()?.trim_start_matches('[')
    } else {
        text.split(':').next()?
    };
    Destination::new(host.trim(), 443).ok().map(|d| d.host)
}
fn word(data: &[u8], at: usize) -> Option<usize> {
    Some(u16::from_be_bytes(data.get(at..at + 2)?.try_into().ok()?) as usize)
}
fn client_hello(data: &[u8]) -> Option<String> {
    if *data.first()? != 1 {
        return None;
    }
    let size =
        ((*data.get(1)? as usize) << 16) | ((*data.get(2)? as usize) << 8) | *data.get(3)? as usize;
    let data = data.get(4..4 + size)?;
    let mut at = 34;
    at += 1 + *data.get(at)? as usize;
    at += 2 + word(data, at)?;
    at += 1 + *data.get(at)? as usize;
    let end = at + 2 + word(data, at)?;
    at += 2;
    let data = data.get(..end)?;
    while at + 4 <= end {
        let kind = word(data, at)?;
        let len = word(data, at + 2)?;
        at += 4;
        let ext = data.get(at..at + len)?;
        at += len;
        if kind != 0 {
            continue;
        }
        let names = ext.get(2..2 + word(ext, 0)?)?;
        let mut n = 0;
        while n + 3 <= names.len() {
            let kind = names[n];
            let size = word(names, n + 1)?;
            n += 3;
            let value = names.get(n..n + size)?;
            n += size;
            if kind == 0 {
                return host(value);
            }
        }
    }
    None
}
pub(super) fn inspect(data: &[u8]) -> Found {
    if data.len() > 32768 {
        return Found::Done(None);
    }
    if data.first() == Some(&22) {
        let mut at = 0;
        let mut hello = Vec::new();
        while at < data.len() {
            if data.len() - at < 5 {
                return Found::NeedMore;
            }
            if data[at] != 22 || data[at + 1] != 3 {
                return Found::Done(None);
            }
            let len = word(data, at + 3).unwrap();
            if len > 18432 {
                return Found::Done(None);
            }
            let Some(record) = data.get(at + 5..at + 5 + len) else {
                return Found::NeedMore;
            };
            hello.extend_from_slice(record);
            at += 5 + len;
            if hello.len() >= 4 {
                let len =
                    ((hello[1] as usize) << 16) | ((hello[2] as usize) << 8) | hello[3] as usize;
                if len > 32764 {
                    return Found::Done(None);
                }
                if hello.len() >= 4 + len {
                    return Found::Done(client_hello(&hello));
                }
            }
        }
        return Found::NeedMore;
    }
    if data
        .iter()
        .take(8)
        .any(|b| !b.is_ascii_graphic() && *b != b' ')
    {
        return Found::Done(None);
    }
    let Some(end) = data.windows(4).position(|s| s == b"\r\n\r\n") else {
        return Found::NeedMore;
    };
    let Ok(text) = std::str::from_utf8(&data[..end]) else {
        return Found::Done(None);
    };
    if !text
        .lines()
        .next()
        .is_some_and(|l| l.ends_with(" HTTP/1.1") || l.ends_with(" HTTP/1.0"))
    {
        return Found::Done(None);
    }
    let values: Vec<_> = text
        .lines()
        .skip(1)
        .filter_map(|l| l.split_once(':'))
        .filter(|(k, _)| k.eq_ignore_ascii_case("host"))
        .collect();
    Found::Done(if values.len() == 1 {
        host(values[0].1.trim().as_bytes())
    } else {
        None
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn http_bounded_incomplete_and_conflicting_hosts() {
        assert!(
            matches!(inspect(b"GET / HTTP/1.1\r\nHoST: Example.test:80\r\n\r\n"),Found::Done(Some(v)) if v=="example.test")
        );
        assert!(matches!(
            inspect(b"GET / HTTP/1.1\r\nHost: a.test\r\n"),
            Found::NeedMore
        ));
        assert!(matches!(
            inspect(b"GET / HTTP/1.1\r\nHost: a.test\r\nHost: b.test\r\n\r\n"),
            Found::Done(None)
        ));
        assert!(matches!(inspect(&vec![b'x'; 32769]), Found::Done(None)));
    }
    #[test]
    fn tls_fragments_and_invalid_lengths() {
        let name = b"example.test";
        let mut ext = vec![0, 0];
        ext.extend(((name.len() + 5) as u16).to_be_bytes());
        ext.extend(((name.len() + 3) as u16).to_be_bytes());
        ext.push(0);
        ext.extend((name.len() as u16).to_be_bytes());
        ext.extend(name);
        let mut body = vec![3, 3];
        body.extend([0; 32]);
        body.extend([0, 0, 2, 0x13, 1, 1, 0]);
        body.extend((ext.len() as u16).to_be_bytes());
        body.extend(ext);
        let mut hello = vec![1, 0, 0, body.len() as u8];
        hello.extend(body);
        let mut records = Vec::new();
        for part in hello.chunks(27) {
            records.extend([22, 3, 3]);
            records.extend((part.len() as u16).to_be_bytes());
            records.extend(part);
        }
        for cut in 1..records.len() {
            assert!(matches!(inspect(&records[..cut]), Found::NeedMore));
        }
        assert!(matches!(inspect(&records),Found::Done(Some(v)) if v=="example.test"));
        records[3] = 255;
        assert!(matches!(inspect(&records), Found::Done(None)));
    }
}
