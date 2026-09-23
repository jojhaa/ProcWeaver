//! Cache the expensive subscription projection, never the live routing state.
use super::{composer, model::Target};
use crate::commands::{local_rules, settings};
use std::{path::{Path, PathBuf}, sync::Mutex, time::{Duration, Instant, SystemTime}};

#[derive(Clone, Debug, PartialEq, Eq)]
struct Stamp { path: PathBuf, modified: Option<SystemTime>, len: u64 }
fn stamp(path: &Path) -> Result<Stamp, String> {
    match std::fs::metadata(path) {
        Ok(meta) => Ok(Stamp { path: path.to_owned(), modified: meta.modified().ok(), len: meta.len() }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Stamp { path: path.to_owned(), modified: None, len: 0 }),
        Err(_) => Err("读取出口配置状态失败".into()),
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct Key { profile: String, files: Vec<Stamp> }
#[derive(Default)]
struct Cache { values: Vec<(Key, Instant, Vec<Target>)> }
impl Cache {
    fn get(&self, key: &Key, now: Instant) -> Option<Vec<Target>> {
        self.values.iter().find(|(saved, time, _)| saved == key && now.duration_since(*time) < Duration::from_secs(30))
            .map(|(_, _, targets)| targets.clone())
    }
}
static CACHE: Mutex<Cache> = Mutex::new(Cache { values: Vec::new() });

pub(super) fn targets(profile: &str, source: &Path) -> Result<Vec<Target>, String> {
    let data = crate::storage::data_dir();
    let key = Key { profile: profile.into(), files: [source.to_owned(), data.join("config/preferences.json"), data.join("config/local-rules.json")]
        .iter().map(|path| stamp(path)).collect::<Result<_, _>>()? };
    let mut cache = CACHE.lock().map_err(|_| "出口缓存不可用")?;
    if let Some(value) = cache.get(&key, Instant::now()) { return Ok(value); }
    // Never serve an old projection after a failed rebuild. The periodic recheck also
    // covers external editors that deliberately preserve file size and timestamps.
    cache.values.retain(|(saved, time, _)| saved.profile != profile && time.elapsed() < Duration::from_secs(30));
    let value = if source.exists() {
        let raw = std::fs::read_to_string(source).map_err(|_| "读取当前订阅失败")?;
        let base = settings::prepare_with(&raw, &settings::get_general_settings()?)?;
        composer::targets(&local_rules::compose(&base, &local_rules::get_local_rule_plan()?)?, profile)?
    } else { vec![] };
    if cache.values.len() >= 8 { cache.values.remove(0); }
    cache.values.push((key, Instant::now(), value.clone()));
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn performance_projection_cache_tracks_profile_files_and_expiry() {
        let now = Instant::now();
        let key = Key { profile: "subscription-a".into(), files: vec![Stamp { path: "a.yaml".into(), modified: None, len: 7 }] };
        let cache = Cache { values: vec![(key.clone(), now, vec![])] };
        assert!(cache.get(&key, now + Duration::from_secs(5)).is_some());
        let mut changed = key.clone(); changed.profile = "subscription-b".into();
        assert!(cache.get(&changed, now).is_none());
        changed = key.clone(); changed.files[0].len += 1;
        assert!(cache.get(&changed, now).is_none());
        changed = key.clone(); changed.files[0].modified = Some(SystemTime::now());
        assert!(cache.get(&changed, now).is_none());
        assert!(cache.get(&key, now + Duration::from_secs(30)).is_none());
    }
}
