import { useEffect, useRef, useState } from "react";
import { profileSwitchApi, type BindingDecision, type ProfileSwitchPreview } from "../api/profileSwitch";
export interface ProfileSwitchState { preview: ProfileSwitchPreview | null; busy: boolean; error: string }
export function useProfileSwitch() {
  const [state, setState] = useState<ProfileSwitchState>({ preview: null, busy: false, error: "" });
  const pending = useRef<{ preview: ProfileSwitchPreview; resolve: (success: boolean) => void } | null>(null);
  const working = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; pending.current?.resolve(false); pending.current = null; };
  }, []);
  const finish = (success: boolean) => {
    const request = pending.current; pending.current = null;
    if (active.current) setState({ preview: null, busy: false, error: "" });
    request?.resolve(success);
  };
  const requestSwitch = async (id: string): Promise<boolean> => {
    if (working.current) return false;
    working.current = true;
    try {
      const preview = await profileSwitchApi.preview(id);
      if (!active.current) return false;
      if (!preview.affected.length) {
        if (!await profileSwitchApi.select(id)) throw new Error("订阅未能应用，请重试");
        return true;
      }
      return await new Promise<boolean>(resolve => {
        pending.current = { preview, resolve };
        setState({ preview, busy: false, error: "" });
      });
    } finally { working.current = false; }
  };
  const saving = useRef(false);
  const choose = async (mode: BindingDecision["mode"]) => {
    const request = pending.current;
    if (!request || saving.current || (mode === "keep" && !request.preview.canKeep)) return;
    saving.current = true; setState(previous => ({ ...previous, busy: true, error: "" }));
    try {
      if (!await profileSwitchApi.select(request.preview.profileId, {
        mode, revision: request.preview.revision, currentProfileId: request.preview.currentProfileId,
      })) throw new Error("订阅未能应用，请重试");
      finish(true);
    } catch (error) {
      if (active.current) setState(previous => ({ ...previous, busy: false, error: error instanceof Error ? error.message : String(error) }));
    } finally { saving.current = false; }
  };
  return { requestSwitch, state, actions: { choose, cancel: () => { if (!saving.current) finish(false); } } };
}
