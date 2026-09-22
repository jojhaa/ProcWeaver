export interface TrafficSnapshot {
  epoch: number | null;
  uploadTotal: number;
  downloadTotal: number;
  connections: { id: string; upload: number; download: number; proxied: boolean }[];
}
export interface TrafficReading { upload: number; download: number; upSpeed: number; downSpeed: number }

export function createTrafficCounter() {
  let previous: TrafficSnapshot | null = null;
  let timestamp = 0;
  let proxyUpload = 0, proxyDownload = 0;
  let entries = new Map<string, { upload: number; download: number }>();
  return (snapshot: TrafficSnapshot, now: number): { all: TrafficReading; proxy: TrafficReading } => {
    if (previous && (snapshot.epoch !== previous.epoch || snapshot.uploadTotal < previous.uploadTotal || snapshot.downloadTotal < previous.downloadTotal)) {
      previous = null; entries.clear(); proxyUpload = 0; proxyDownload = 0;
    }
    const seconds = previous ? Math.max((now - timestamp) / 1000, 0.001) : 0;
    let uploadDelta = 0, downloadDelta = 0;
    const current = new Map<string, { upload: number; download: number }>();
    for (const connection of snapshot.connections) {
      if (!connection.proxied) continue;
      const old = entries.get(connection.id);
      uploadDelta += Math.max(0, connection.upload - (old?.upload ?? 0));
      downloadDelta += Math.max(0, connection.download - (old?.download ?? 0));
      current.set(connection.id, connection);
    }
    proxyUpload += uploadDelta; proxyDownload += downloadDelta;
    const all = { upload: snapshot.uploadTotal, download: snapshot.downloadTotal,
      upSpeed: seconds ? Math.max(0, snapshot.uploadTotal - previous!.uploadTotal) / seconds : 0,
      downSpeed: seconds ? Math.max(0, snapshot.downloadTotal - previous!.downloadTotal) / seconds : 0 };
    const proxy = { upload: proxyUpload, download: proxyDownload,
      upSpeed: seconds ? uploadDelta / seconds : 0, downSpeed: seconds ? downloadDelta / seconds : 0 };
    entries = current; previous = snapshot; timestamp = now;
    return { all, proxy };
  };
}
