import { invoke } from "@tauri-apps/api/core";
import type { LocalNodeDraft, LocalNodesView } from "../types/localNodes";
export const localNodesApi = {
  read: () => invoke<LocalNodesView>("get_local_nodes"),
  detail: (id: string) => invoke<LocalNodeDraft>("get_local_node", { id }),
  preview: (text: string) => invoke<LocalNodeDraft[]>("preview_local_nodes", { text }),
  save: (expectedRevision: number, upserts: LocalNodeDraft[], deletes: string[] = []) =>
    invoke<LocalNodesView>("save_local_nodes", { expectedRevision, upserts, deletes }),
};
