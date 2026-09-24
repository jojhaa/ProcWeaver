import type { BundleRepository, RepositorySnapshot, RepositoryStatus } from "../types/bundleRepository";
import { normalizeRepository, repositoryKey, validateRepositories, type RepositoryStorage } from "../services/bundleRepositories";
import type { RepositoryCatalog } from "../types/bundleRepository";

const emptyStatus = (): RepositoryStatus => ({ packages: [], warnings: [], loading: false, fetched: false, error: "" });
export function createRepositoryController(storage: RepositoryStorage, load: (repo: BundleRepository, signal: AbortSignal) => Promise<RepositoryCatalog>) {
  let state: RepositorySnapshot = { repositories: [], statuses: {}, error: "" };
  const listeners = new Set<() => void>(), pending = new Map<string, AbortController>();
  const publish = (next: RepositorySnapshot) => { state = next; listeners.forEach(listener => listener()); };
  const errorText = (e: unknown) => e instanceof Error ? e.message : "仓库操作失败，请重试";
  const status = (id: string, patch: Partial<RepositoryStatus>) => publish({ ...state, statuses: { ...state.statuses, [id]: { ...(state.statuses[id] || emptyStatus()), ...patch } } });
  const reload = () => {
    try {
      const repositories = storage.read(), statuses = { ...state.statuses };
      for (const previous of state.repositories) {
        const next = repositories.find(r => r.id === previous.id);
        if (!next || JSON.stringify(next) !== JSON.stringify(previous)) { pending.get(previous.id)?.abort(); pending.delete(previous.id); delete statuses[previous.id]; }
      }
      publish({ repositories, statuses, error: "" }); return true;
    } catch (e) { publish({ ...state, error: errorText(e) }); return false; }
  };
  reload();
  const save = (repositories: BundleRepository[]) => {
    try {
      const next = validateRepositories(repositories);
      storage.save(next, state.repositories);
      return reload();
    } catch (e) { publish({ ...state, error: errorText(e) }); return false; }
  };
  const refreshOne = async (id: string) => {
    const repo = state.repositories.find(r => r.id === id);
    if (!repo?.enabled || pending.has(id)) return;
    const controller = new AbortController(); pending.set(id, controller);
    const stillCurrent = () => !controller.signal.aborted && pending.get(id) === controller && state.repositories.some(r => r.id === id && r.enabled && repositoryKey(r) === repositoryKey(repo));
    status(id, { loading: true, error: "" });
    try { const catalog = await load(repo, controller.signal); if (stillCurrent()) status(id, { ...catalog, loading: false, fetched: true, error: "", updatedAt: Date.now() }); }
    catch (e) { if (stillCurrent()) status(id, { loading: false, fetched: true, error: errorText(e) }); }
    finally { if (pending.get(id) === controller) pending.delete(id); }
  };
  const refresh = async (onlyId?: string, missingOnly = false) => {
    const ids = state.repositories.filter(r => r.enabled && (!onlyId || r.id === onlyId) && (!missingOnly || !state.statuses[r.id]?.fetched)).map(r => r.id);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(2, ids.length) }, async () => { while (next < ids.length) await refreshOne(ids[next++]); }));
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    reload, refresh,
    upsert: (draft: BundleRepository) => {
      try { const repo = normalizeRepository(draft); return save(state.repositories.some(r => r.id === repo.id) ? state.repositories.map(r => r.id === repo.id ? repo : r) : [...state.repositories, repo]); }
      catch (e) { publish({ ...state, error: errorText(e) }); return false; }
    },
    toggle: (id: string) => save(state.repositories.map(r => r.id === id ? { ...r, enabled: !r.enabled } : r)),
    remove: (id: string) => save(state.repositories.filter(r => r.id !== id)),
    dispose: () => { pending.forEach(c => c.abort()); pending.clear(); listeners.clear(); },
  };
}
