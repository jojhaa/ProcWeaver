import { invoke } from "@tauri-apps/api/core";
import { TrafficSnapshot } from "../utils/trafficCounter";

export function fetchTrafficSnapshot(): Promise<TrafficSnapshot> {
  return invoke("get_traffic_snapshot");
}
