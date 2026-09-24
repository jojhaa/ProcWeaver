import type { BusinessBundleDefinition } from "./businessBundle";

export interface BundleRepository {
  id: string;
  name: string;
  kind: "github" | "index";
  url: string;
  branch: string;
  directory: string;
  enabled: boolean;
}
export interface BundleRepositoryOrigin {
  repositoryId: string;
  repositoryName: string;
  repositoryKey: string;
  packageUrl: string;
}
export interface RepositoryPackage { key: string; definition: BusinessBundleDefinition; origin: BundleRepositoryOrigin }
export interface RepositoryCatalog { packages: RepositoryPackage[]; warnings: string[] }
export interface RepositoryStatus extends RepositoryCatalog { loading: boolean; fetched: boolean; error: string; updatedAt?: number }
export interface RepositorySnapshot { repositories: BundleRepository[]; statuses: Record<string, RepositoryStatus>; error: string }
