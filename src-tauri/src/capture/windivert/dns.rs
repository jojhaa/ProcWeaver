//! Validate DNS identity inside a process/flow-owned UDP or TCP relay. This does
//! not infer original app ownership from Windows DNS Client service traffic.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Question {
    pub id: u16,
    pub name: String,
    pub record_type: u16,
    pub class: u16,
}

fn question(message: &[u8], reply: bool) -> Option<Question> {
    if message.len() < 12 || message.len() > 65535 || (message[2] & 0x80 != 0) != reply
        || message[2] & 0x78 != 0 || message[4..6] != [0, 1] { return None; }
    let mut offset = 12usize;
    let mut labels = Vec::new();
    let mut length = 0;
    // Queries with compressed names are not used for matching. They can still
    // travel as ordinary opaque UDP; never guess a name or follow pointer cycles.
    for _ in 0..128 {
        let size = *message.get(offset)? as usize; offset += 1;
        if size == 0 {
            let tail = message.get(offset..offset + 4)?;
            return Some(Question { id:u16::from_be_bytes([message[0], message[1]]), name:labels.join("."),
                record_type:u16::from_be_bytes([tail[0], tail[1]]), class:u16::from_be_bytes([tail[2], tail[3]]) });
        }
        if size > 63 { return None; }
        let label = message.get(offset..offset + size)?; offset += size;
        if !label.iter().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_')) { return None; }
        length += size + 1; if length > 254 { return None; }
        labels.push(std::str::from_utf8(label).ok()?.to_ascii_lowercase());
    }
    None
}
impl Question {
    pub fn parse_query(message: &[u8]) -> Option<Self> { question(message, false) }
    pub fn matches_reply(&self, message: &[u8]) -> bool { question(message, true).as_ref() == Some(self) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn matches_id_question_type_class_and_response_direction() {
        let query = b"\x12\x34\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\x02pw\x07invalid\x00\x00\x01\x00\x01";
        let question = Question::parse_query(query).unwrap();
        assert_eq!(question.name, "pw.invalid"); assert!(!question.matches_reply(query));
        let mut response = query.to_vec(); response[2] |= 0x80;
        assert!(question.matches_reply(&response));
        for offset in [0, 1, 4, 5, 13, 24, 25, 26, 27] {
            let mut changed = response.clone(); changed[offset] ^= 1;
            assert!(!question.matches_reply(&changed), "{offset}");
        }
    }
    #[test]
    fn compressed_or_truncated_question_is_not_used_as_domain_evidence() {
        let compressed = b"\x12\x34\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\xc0\x0c\x00\x01\x00\x01";
        assert!(Question::parse_query(compressed).is_none());
        for length in 0..compressed.len() { assert!(Question::parse_query(&compressed[..length]).is_none()); }
    }
}
