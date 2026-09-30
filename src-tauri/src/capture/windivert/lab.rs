//! Resource guard for explicitly invoked native fixture tests only.
use super::driver::Device;
use std::{io, sync::Arc, thread::JoinHandle};

pub struct Capture {
    device: Option<Arc<Device>>,
    worker: Option<JoinHandle<io::Result<()>>>,
}
impl Capture {
    pub fn new(device: Arc<Device>, worker: JoinHandle<io::Result<()>>) -> Self { Self { device: Some(device), worker: Some(worker) } }
    pub fn stop(&mut self) -> io::Result<()> {
        if let Some(device) = self.device.take() {
            device.shutdown();
            let result = self.worker.take().map(|worker| worker.join().map_err(|_| io::Error::other("capture worker panicked")))
                .transpose()?.unwrap_or(Ok(()));
            let closed = device.close();
            result.and(closed)?;
        }
        Ok(())
    }
}
impl Drop for Capture { fn drop(&mut self) { let _ = self.stop(); } }
