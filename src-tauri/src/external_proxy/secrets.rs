use base64::{engine::general_purpose::STANDARD, Engine};

// Scope is the current Windows account, not the machine. Moving the portable
// folder to another account requires entering the password again.
#[cfg(windows)]
fn crypt(bytes: &[u8], protect: bool) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::{Security::Cryptography::*, Foundation::LocalFree};
    let input = CRYPT_INTEGER_BLOB { cbData: bytes.len() as u32, pbData: bytes.as_ptr() as *mut u8 };
    let mut output: CRYPT_INTEGER_BLOB = unsafe { std::mem::zeroed() };
    let ok = unsafe {
        if protect { CryptProtectData(&input, std::ptr::null(), std::ptr::null(), std::ptr::null_mut(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output) }
        else { CryptUnprotectData(&input, std::ptr::null_mut(), std::ptr::null(), std::ptr::null_mut(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output) }
    };
    if ok == 0 { return Err("代理凭据不可读取，请在当前 Windows 账户重新输入密码".into()); }
    let value = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe { LocalFree(output.pbData.cast()); }
    Ok(value)
}
#[cfg(not(windows))]
fn crypt(_: &[u8], _: bool) -> Result<Vec<u8>, String> { Err("独立外部代理首期支持 Windows".into()) }
pub fn protect(value: &str) -> Result<String, String> {
    if value.is_empty() || value.len() > 255 || value.chars().any(char::is_control) { return Err("密码长度须为 1–255 字节且不含控制字符".into()); }
    Ok(STANDARD.encode(crypt(value.as_bytes(), true)?))
}
pub fn reveal(value: &str) -> Result<String, String> {
    if value.is_empty() { return Ok(String::new()); }
    let bytes = STANDARD.decode(value).map_err(|_| "代理凭据格式错误，请重新输入密码")?;
    String::from_utf8(crypt(&bytes, false)?).map_err(|_| "代理凭据解码失败".into())
}
#[cfg(all(test, windows))]
mod tests {
    #[test] fn secret_round_trip_is_not_plaintext() {
        let protected = super::protect("fixture-password").unwrap();
        assert!(!protected.contains("fixture-password"));
        assert_eq!(super::reveal(&protected).unwrap(), "fixture-password");
        assert!(super::reveal("broken").is_err());
    }
}
