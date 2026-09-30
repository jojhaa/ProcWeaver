import { invoke } from "@tauri-apps/api/core";
import { addProfile } from "./index";
import type { ProfileItem } from "../types";

export const profileImportApi = {
  native: (action: "takeImport" | "readDocument" | "scanQr" | "readQrImage") => invoke<{ content?: string; cancelled: boolean }>("android_mobile_action", { action }),
  file: (name: string, content: string) => invoke<ProfileItem>("import_profile_content", { name, content }),
  subscription: addProfile,
};
