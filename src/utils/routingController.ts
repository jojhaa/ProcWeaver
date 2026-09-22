import type { RoutingApi } from "../api/routingOverrides";
import type { RoutingView, RoutingOverrides, ProcessEntry, ProcessSelection, DnsDiagnostic } from "../types/routingOverrides";
import type { ProcessRule, RoutingTarget } from "../types/routingOverrides";
import { previewSelection, splitDomains } from "./processTree";
export interface RoutingState { view: RoutingView | null; draft: RoutingOverrides | null; tree: ProcessEntry[]; selections: ProcessSelection[]; loading: boolean; saving: boolean; dirty: boolean; error: string; notice: string; diagnostic: DnsDiagnostic | null; preview: ReturnType<typeof previewSelection> | null }
export function createRoutingController(api: RoutingApi) {
  let state: RoutingState = { view: null, draft: null, tree: [], selections: [], loading: true, saving: false, dirty: false, error: "", notice: "", diagnostic: null, preview: null };
  const listeners = new Set<() => void>(); let sequence = 0;
  const emit = (patch: Partial<RoutingState>) => { state = { ...state, ...patch }; listeners.forEach(f => f()); };
  const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
  return {
    subscribe: (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; },
    getSnapshot: () => state,
    async refresh(discard = false) {
      if (state.saving) return; const token = ++sequence;
      try { const view = await api.read(); if (token !== sequence) return;
        emit({ view, loading: false, ...(discard || !state.dirty ? { draft: structuredClone(view.config), dirty: false, selections: [], error: "" } : {}) });
      } catch (e) { if (token === sequence) emit({ loading: false, error: errorText(e) }); }
    },
    edit(draft: RoutingOverrides, selections = state.selections) { if (!state.saving) emit({ draft, selections: selections.filter(s => draft.processRules.some(r => r.matchKind === "path" && r.matchValue === s.executablePath)), dirty: true, notice: "", diagnostic: null, preview: null }); },
    async save(): Promise<{ success: boolean; error?: string }> {
      if (!state.draft) return { success: false, error: "分流配置未初始化" };
      if (state.saving) return { success: false, error: "正在保存中，请稍候" };
      ++sequence; emit({ saving: true, error: "", notice: "" });
      try {
        const view = await api.save(state.draft, state.selections);
        emit({ view, draft: structuredClone(view.config), dirty: false, selections: [], notice: view.running ? "已保存并应用；新连接使用新规则，已有连接不会迁移。" : "已保存，核心下次启动时应用。" });
        return { success: true };
      } catch (e) {
        const msg = errorText(e);
        emit({ error: msg });
        return { success: false, error: msg };
      } finally {
        emit({ saving: false });
      }
    },
    async tree() { try { emit({ tree: await api.tree(), error: "", preview: null }); } catch (e) { emit({ error: errorText(e) }); } },
    async browse() { try { return await api.browse(); } catch (e) { emit({ error: errorText(e) }); return null; } },
    process(input: Omit<ProcessRule, "id"> & { id?: string }) {
      if (!state.draft || state.saving) return false;
      if (!input.matchValue.trim() || (input.action === "proxy" && !input.target)) { emit({ error: "请填写程序并选择出口" }); return false; }
      const rule: ProcessRule = { ...input, id: input.id || crypto.randomUUID(), matchValue: input.matchValue.trim(), target: input.action === "proxy" ? input.target : null };
      if (state.draft.processRules.some(r => r.id !== rule.id && r.matchKind === rule.matchKind && r.matchValue.toLowerCase() === rule.matchValue.toLowerCase())) { emit({ error: "此程序已有规则，请编辑已有项" }); return false; }
      const rules = state.draft.processRules.some(r => r.id === rule.id) ? state.draft.processRules.map(r => r.id === rule.id ? rule : r) : [...state.draft.processRules, rule];
      emit({ draft: { ...state.draft, processRules: rules }, dirty: true, error: "", notice: "已加入待保存规则" }); return true;
    },
    dns(input: { id?: string; domains: string; domainKind: "exact" | "suffix"; resolverUrl: string; target: RoutingTarget | null; enabled: boolean }) {
      if (!state.draft || state.saving) return false;
      const domains = splitDomains(input.domains);
      if (!input.target || !domains.length || !input.resolverUrl) { emit({ error: "请填写域名、DNS 地址并选择查询出口" }); return false; }
      const existing = state.draft.dnsRules.filter(r => r.id !== input.id);
      if (domains.some(domain => existing.some(r => r.domain === domain && r.domainKind === input.domainKind))) { emit({ error: "域名条件重复，请编辑已有项" }); return false; }
      const rules = domains.map((domain, i) => ({ id: i === 0 && input.id ? input.id : crypto.randomUUID(), enabled: input.enabled, domainKind: input.domainKind, domain, resolverUrl: input.resolverUrl.trim(), target: input.target! }));
      emit({ draft: { ...state.draft, dnsRules: [...existing, ...rules] }, dirty: true, error: "", notice: "已加入待保存规则" }); return true;
    },
    preview(selected: Set<string>, action: ProcessRule["action"], target: RoutingTarget | null, includeDescendants: boolean) {
      if (!state.draft || state.saving) return;
      if (action === "proxy" && !target) { emit({ error: "请选择出口" }); return; }
      emit({ preview: previewSelection(state.tree, selected, state.draft.processRules, action, action === "proxy" ? target : null, includeDescendants) });
    },
    acceptPreview() {
      if (!state.draft || !state.preview || state.preview.errors.length || state.saving) return;
      emit({ draft: { ...state.draft, processRules: [...state.draft.processRules, ...state.preview.rules] }, selections: [...state.selections, ...state.preview.selections], dirty: true, preview: null, notice: "已加入待保存规则；保存时重新核对进程身份" });
    },
    async diagnose(id: string) { try { emit({ diagnostic: await api.diagnose(id), error: "" }); } catch (e) { emit({ error: errorText(e) }); } },
  };
}
