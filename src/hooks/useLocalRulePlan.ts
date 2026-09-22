import { useState } from "react";
import { fetchLocalRulePlan, setLocalRulePlanEnabled, LocalRulePlan } from "../api/mihomo";

export function useLocalRulePlan() {
  const [plan, setPlan] = useState<LocalRulePlan | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function reload() {
    try { setPlan(await fetchLocalRulePlan()); setError(""); }
    catch (cause) { setError(String(cause)); }
  }
  async function toggle() {
    if (!plan || saving) return false;
    setSaving(true);
    setError("");
    try { setPlan(await setLocalRulePlanEnabled(!plan.enabled)); return true; }
    catch (cause) { setError(String(cause)); return false; }
    finally { setSaving(false); }
  }
  return { plan, saving, error, reload, toggle };
}
