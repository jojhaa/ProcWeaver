/// KERN_PROCARGS2 格式的 argv 区域。环境变量不进入返回值。
pub fn parse_process_arguments(bytes: &[u8]) -> Result<Vec<String>, String> {
    let count = i32::from_ne_bytes(bytes.get(..4).ok_or("进程参数无效")?.try_into().map_err(|_| "进程参数无效")?);
    if !(1..=4096).contains(&count) { return Err("进程参数数量无效".into()); }
    let mut offset = 4 + bytes[4..].iter().position(|b| *b == 0).ok_or("进程路径无效")? + 1;
    while bytes.get(offset) == Some(&0) { offset += 1; }
    let mut args = Vec::new();
    for _ in 0..count {
        let tail = bytes.get(offset..).ok_or("进程参数被截断")?;
        let end = tail.iter().position(|b| *b == 0).ok_or("进程参数被截断")?;
        args.push(std::str::from_utf8(&tail[..end]).map_err(|_| "进程参数编码无效")?.to_owned());
        offset += end + 1;
    }
    Ok(args)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn argv_preserves_spaces_empty_arguments_and_excludes_environment() {
        let mut bytes = 3i32.to_ne_bytes().to_vec();
        bytes.extend_from_slice(b"/Applications/Example App.app/Contents/MacOS/Example\0\0Example\0\0--user-data-dir=/tmp/test profile\0PRIVATE_TOKEN=never-return\0");
        assert_eq!(parse_process_arguments(&bytes).unwrap(), vec!["Example", "", "--user-data-dir=/tmp/test profile"]);
        assert!(parse_process_arguments(&[0, 0, 0]).is_err());
        assert!(parse_process_arguments(&4097i32.to_ne_bytes()).is_err());
    }
}
