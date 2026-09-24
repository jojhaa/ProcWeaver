import { useEffect, useSyncExternalStore } from "react";
import { requestRepository } from "../api/bundleRepositories";
import { loadRepository, repositoryStorage, REPOSITORY_STORAGE_KEY } from "../services/bundleRepositories";
import { createRepositoryController } from "../utils/bundleRepositoryController";

let controller: ReturnType<typeof createRepositoryController> | undefined;
export function useBundleRepositories(active: boolean) {
  controller ||= createRepositoryController(repositoryStorage(localStorage), (repo, signal) => loadRepository(repo, requestRepository, signal));
  const current = controller;
  const state = useSyncExternalStore(current.subscribe, current.getSnapshot);
  useEffect(() => { if (active) void current.refresh(undefined, true); }, [active, current, state.repositories]);
  useEffect(() => {
    const refresh = (event: StorageEvent) => { if (event.key === null || event.key === REPOSITORY_STORAGE_KEY) current.reload(); };
    window.addEventListener("storage", refresh);
    return () => window.removeEventListener("storage", refresh);
  }, [current]);
  return { state, actions: current };
}
