import { GeoConfig, GeoResource } from "../types";
import { isTauri } from "./index";

async function invokeTauri<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(cmd, args);
  }
  throw new Error("NOT_IN_TAURI");
}

export async function fetchGeoConfig(): Promise<GeoConfig> {
  if (isTauri()) {
    try {
      return await invokeTauri<GeoConfig>("get_geo_config");
    } catch (err) {
      console.error("获取本地 Geo 真实配置失败:", err);
      throw new Error(`获取本地 Geo 数据库配置失败: ${err}`);
    }
  }

  // 仅在非桌面纯浏览器开发隔离预览时使用初始空模板，绝不伪造已存在状态 (D05)
  return {
    autoUpdate: true,
    updateIntervalHours: 24,
    resources: [
      {
        id: "mmdb",
        name: "MMDB",
        fileName: "geoip.metadb",
        url: "https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip.metadb",
        fileSizeBytes: 0,
        fileSizeFormatted: "0 B",
        updatedAtRelative: "未就绪",
        exists: false,
      },
      {
        id: "asn",
        name: "ASN",
        fileName: "GeoLite2-ASN.mmdb",
        url: "https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/GeoLite2-ASN.mmdb",
        fileSizeBytes: 0,
        fileSizeFormatted: "0 B",
        updatedAtRelative: "未就绪",
        exists: false,
      },
      {
        id: "geoip",
        name: "GEOIP",
        fileName: "geoip.dat",
        url: "https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip.dat",
        fileSizeBytes: 0,
        fileSizeFormatted: "0 B",
        updatedAtRelative: "未就绪",
        exists: false,
      },
      {
        id: "geosite",
        name: "GEOSITE",
        fileName: "geosite.dat",
        url: "https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geosite.dat",
        fileSizeBytes: 0,
        fileSizeFormatted: "0 B",
        updatedAtRelative: "未就绪",
        exists: false,
      },
    ],
  };
}

export async function saveGeoConfig(config: GeoConfig): Promise<boolean> {
  if (isTauri()) {
    return await invokeTauri<boolean>("save_geo_config", { config });
  }
  return true;
}

export async function syncGeoResource(id: string, customUrl?: string): Promise<GeoResource | null> {
  try {
    if (isTauri()) {
      return await invokeTauri<GeoResource>("sync_geo_resource", {
        id,
        customUrl: customUrl || null,
      });
    }
  } catch (err) {
    console.error(`同步 Geo 资源 [${id}] 失败:`, err);
    throw err;
  }
  return null;
}

export async function syncAllGeoResources(): Promise<GeoConfig | null> {
  try {
    if (isTauri()) {
      return await invokeTauri<GeoConfig>("sync_all_geo_resources");
    }
  } catch (err) {
    console.error("一键同步全部 Geo 资源失败:", err);
    throw err;
  }
  return null;
}
