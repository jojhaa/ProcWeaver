import { invoke } from "@tauri-apps/api/core";
import { getProfiles, isTauri, selectProfile } from "./index";
import type { RoutingTarget } from "../types/routingOverrides";
export interface BindingDecision { mode: "keep" | "hold"; revision: number; currentProfileId: string }
export interface ProfileSwitchPreview {
  profileId: string; profileName: string; currentProfileId: string; revision: number;
  affected: { target: RoutingTarget; subscriptionName: string }[]; canKeep: boolean; keepError: string | null;
}
export const profileSwitchApi = {
  preview: async (id: string): Promise<ProfileSwitchPreview> => {
    if (isTauri()) return invoke("preview_profile_switch", { id });
    const profiles = await getProfiles();
    const profile = profiles.find(item => item.id === id);
    if (!profile) throw new Error("订阅不存在");
    return { profileId: id, profileName: profile.name, currentProfileId: profiles.find(p => p.isSelected)?.id || "default", revision: 0, affected: [], canKeep: true, keepError: null };
  },
  select: selectProfile,
};
