//! Product identity is a build-time boundary, never a user preference.
pub const PROCESS: bool = cfg!(feature = "process-edition");
pub const NAME: &str = if PROCESS { "ProcWeaver Process" } else { "ProcWeaver" };
pub const AUTOSTART: &str = if PROCESS { "ProcWeaverProcess" } else { "ProcWeaver" };
pub const COMPONENTS: &str = if PROCESS { "ProcWeaver Process Components" } else { "ProcWeaver Components" };

#[cfg(test)]
mod tests {
    #[test]
    fn process_build_is_always_coreless() {
        if super::PROCESS {
            assert!(!crate::function_mode::core_features_enabled());
            assert!(crate::function_mode::require_full().is_err());
            assert_ne!(super::AUTOSTART, "ProcWeaver");
            assert_ne!(super::COMPONENTS, "ProcWeaver Components");
        }
    }
}
