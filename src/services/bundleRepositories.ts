import type { BundleRepository, RepositoryCatalog, RepositoryPackage } from "../types/bundleRepository";
import { validateAndParseBundlePackage } from "./bundleStorage";

export const DEFAULT_REPOSITORY: BundleRepository = { id: "procweaver-default", name: "默认规则仓库", kind: "github", url: "https://github.com/jojhaa/procweaver-rules", branch: "main", directory: "Business-Rules", enabled: true };
export const REPOSITORY_STORAGE_KEY = "procweaver_bundle_repositories_v1";
const MAX_REPOSITORIES = 20, MAX_PACKAGES = 100;

export function httpsUrl(value: string, base?: string): string {
  let url: URL;
  try { url = new URL(value, base); } catch { throw new Error("请填写有效的 HTTPS 地址"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.href.length > 2048) throw new Error("仓库地址须为 HTTPS，不能包含账号、密码或片段");
  return url.href;
}
export function normalizeRepository(input: BundleRepository): BundleRepository {
  if (!input || typeof input.id !== "string" || !/^[\w-]{1,80}$/.test(input.id) || typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 80 || typeof input.enabled !== "boolean") throw new Error("仓库名称或配置无效");
  if (input.kind !== "github" && input.kind !== "index") throw new Error("不支持的仓库类型");
  if (typeof input.url !== "string" || typeof input.branch !== "string" || typeof input.directory !== "string") throw new Error("仓库地址配置无效");
  let url = input.url.trim(), branch = input.branch.trim(), directory = input.directory.trim().replace(/^\/+|\/+$/g, "");
  if (input.kind === "github") {
    if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url}`;
    const parsed = new URL(httpsUrl(url));
    if (parsed.hostname !== "github.com" || parsed.port || parsed.search) throw new Error("GitHub 仓库请填写 github.com 仓库或目录地址");
    const parts = parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts.length < 2 || !parts.slice(0, 2).every(p => /^[\w.-]+$/.test(p) && p !== "." && p !== "..")) throw new Error("GitHub 地址缺少所有者或仓库名称");
    if (parts.length > 2) {
      if (parts[2] !== "tree" || !parts[3]) throw new Error("请使用 GitHub 仓库或 tree 目录链接");
      branch = branch || parts[3];
      directory = directory || parts.slice(4).join("/");
    }
    url = `https://github.com/${parts[0].toLowerCase()}/${parts[1].replace(/\.git$/i, "").toLowerCase()}`;
    if (branch.length > 200 || /[\s\\?#\x00-\x1f]/.test(branch) || branch.split("/").some(s => s === "." || s === "..")) throw new Error("分支或标签格式无效");
    if (directory.length > 400 || /[\\?#\x00-\x1f]/.test(directory) || directory.split("/").some(s => s === "." || s === "..")) throw new Error("仓库目录格式无效");
  } else { url = httpsUrl(url); branch = ""; directory = ""; }
  return { id: input.id, name: input.name.trim(), kind: input.kind, url, branch, directory, enabled: input.enabled };
}
export const repositoryKey = (repo: BundleRepository) => JSON.stringify([repo.kind, repo.url, repo.branch, repo.directory]);
export function repositoryPage(repo: BundleRepository): string {
  return repo.kind === "github" && repo.branch ? `${repo.url}/tree/${encodeURIComponent(repo.branch)}/${repo.directory.split("/").map(encodeURIComponent).join("/")}` : repo.url;
}
export function validateRepositories(list: BundleRepository[]): BundleRepository[] {
  if (!Array.isArray(list) || !list.length || list.length > MAX_REPOSITORIES) throw new Error(`最多配置 ${MAX_REPOSITORIES} 个仓库`);
  const normalized = list.map(normalizeRepository), ids = new Set<string>(), keys = new Set<string>();
  for (const repo of normalized) {
    const key = repositoryKey(repo);
    if (ids.has(repo.id) || keys.has(key)) throw new Error("此仓库地址、分支与目录已添加");
    ids.add(repo.id); keys.add(key);
  }
  const builtin = normalized.find(r => r.id === DEFAULT_REPOSITORY.id);
  if (!builtin || repositoryKey(builtin) !== repositoryKey(DEFAULT_REPOSITORY) || builtin.name !== DEFAULT_REPOSITORY.name) throw new Error("默认仓库可停用，但不能删除或改写地址");
  return normalized;
}
export interface RepositoryStorage { read(): BundleRepository[]; save(next: BundleRepository[], expected: BundleRepository[]): void }
export function repositoryStorage(storage: Pick<Storage, "getItem" | "setItem">): RepositoryStorage {
  const read = () => {
    const raw = storage.getItem(REPOSITORY_STORAGE_KEY);
    if (raw === null) return [{ ...DEFAULT_REPOSITORY }];
    try { const data = JSON.parse(raw); if (data.version !== 1) throw new Error(); return validateRepositories(data.repositories); }
    catch { throw new Error("仓库配置读取失败，未覆盖原数据；请修复配置后重新加载"); }
  };
  return { read, save(next, expected) {
    const normalized = validateRepositories(next);
    if (JSON.stringify(read()) !== JSON.stringify(expected)) throw new Error("仓库配置已在其他窗口修改，请重新加载后重试");
    try { storage.setItem(REPOSITORY_STORAGE_KEY, JSON.stringify({ version: 1, repositories: normalized })); }
    catch { throw new Error("仓库配置保存失败，请检查存储空间"); }
  } };
}

export type RepositoryRequest = (url: string, signal: AbortSignal, maxBytes: number) => Promise<string>;
function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { throw new Error("仓库返回的内容不是有效 JSON"); }
}
function packageDefinition(value: unknown) {
  const checked = validateAndParseBundlePackage(JSON.stringify(value));
  if (!checked.valid || !checked.bundle) throw new Error("规则包结构无效");
  const d = checked.bundle;
  const raw = value as Record<string, unknown>;
  const rawBundle = (raw?.bundle || raw) as Record<string, unknown>;
  if (typeof rawBundle?.packageId !== "string" || !/^[\w][\w.-]{0,127}$/.test(rawBundle.packageId)) throw new Error("仓库规则包须提供稳定的 packageId");
  for (const [v, max] of [[d.packageName, 160], [d.packageVersion, 64], [d.description, 4000], [d.icon, 32]] as const) if (typeof v !== "string" || v.length > max) throw new Error("规则包展示信息无效或过长");
  if (d.processes.some(p => p.exe.length > 260 || p.description.length > 512) || d.domains?.some(d => d.length > 253) || d.additionalExes && (d.additionalExes.length > 100 || d.additionalExes.some(e => e.length > 260))) throw new Error("规则包进程或域名信息过长");
  if (!Array.isArray(d.slots) || !d.slots.length || d.slots.length > 2 || !d.slots.some(s => s?.id === "main") || new Set(d.slots.map(s => s?.id)).size !== d.slots.length || d.slots.some(s => !s || !["main", "dns"].includes(s.id) || typeof s.name !== "string" || typeof s.description !== "string" || typeof s.required !== "boolean" || s.followSlotId !== undefined && s.followSlotId !== "main")) throw new Error("规则包出口插槽无效");
  if (d.additionalExes?.some(e => !e.trim() || /[/\\]/.test(e) || e.includes("..") || /^\d+$/.test(e))) throw new Error("规则包协同进程无效");
  return d;
}
export async function loadRepository(repo: BundleRepository, request: RepositoryRequest, signal: AbortSignal): Promise<RepositoryCatalog> {
  const check = () => { if (signal.aborted) throw new Error("请求已取消"); };
  const fileLimit = 1024 * 1024, reservations = new Set<Promise<void>>();
  let available = 5 * fileLimit;
  const get = async (url: string) => {
    check();
    // Reserve bytes before starting concurrent transfers; refund only known unused bytes.
    while (available < fileLimit && reservations.size) { await Promise.race(reservations); check(); }
    if (available <= 0) throw new Error("仓库内容超过 5 MB 上限");
    const limit = Math.min(fileLimit, available); available -= limit;
    let release!: () => void;
    const reservation = new Promise<void>(resolve => { release = resolve; }); reservations.add(reservation);
    try {
      const text = await request(httpsUrl(url), signal, limit); check();
      const bytes = new TextEncoder().encode(text).byteLength;
      if (bytes > limit) throw new Error(limit === fileLimit ? "仓库文件超过 1 MB 上限" : "仓库内容超过 5 MB 上限");
      available += limit - bytes;
      return parseJson(text);
    } finally { reservations.delete(reservation); release(); }
  };
  let files: { url: string; inline?: unknown }[];
  if (repo.kind === "github") {
    const slug = new URL(repo.url).pathname.slice(1);
    const listing = `https://api.github.com/repos/${slug}/contents/${repo.directory.split("/").map(encodeURIComponent).join("/")}${repo.branch ? `?ref=${encodeURIComponent(repo.branch)}` : ""}`;
    const data = await get(listing);
    if (!Array.isArray(data)) throw new Error("GitHub 地址须指向包含规则包的目录");
    if (data.length >= 1000) throw new Error("GitHub 目录过大，请指定较小的规则包目录");
    files = data.filter(f => f && f.type === "file" && typeof f.name === "string" && f.name.endsWith(".pwpack.json")).map(f => {
      const url = httpsUrl(f.download_url);
      if (new URL(url).hostname !== "raw.githubusercontent.com") throw new Error("GitHub 返回的下载地址无效");
      return { url };
    });
  } else {
    const data = await get(repo.url) as Record<string, unknown>;
    if (data && !Array.isArray(data) && (data.bundle || data.packageId)) files = [{ url: repo.url, inline: data }];
    else {
      const entries = Array.isArray(data) ? data : data?.packages;
      if (!Array.isArray(entries)) throw new Error("索引须包含 packages 数组，或直接提供 .pwpack.json");
      if (entries.length > MAX_PACKAGES) throw new Error(`单仓库最多 ${MAX_PACKAGES} 个规则包`);
      files = entries.map((entry, i) => {
        if (typeof entry === "string") return { url: httpsUrl(entry, repo.url) };
        if (entry && typeof entry === "object" && typeof entry.url === "string") return { url: httpsUrl(entry.url, repo.url) };
        if (entry && typeof entry === "object" && (entry.bundle || entry.packageId)) return { url: `${repo.url}#item-${i}`, inline: entry };
        throw new Error(`索引第 ${i + 1} 项无效`);
      });
    }
  }
  if (files.length > MAX_PACKAGES) throw new Error(`单仓库最多 ${MAX_PACKAGES} 个规则包`);
  const results: ({ item: RepositoryPackage } | { warning: string })[] = new Array(files.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => {
    while (cursor < files.length) {
      check(); const index = cursor++, file = files[index];
      try {
        const definition = packageDefinition(file.inline ?? await get(file.url)); check();
        const origin = { repositoryId: repo.id, repositoryName: repo.name, repositoryKey: repositoryKey(repo), packageUrl: file.url };
        results[index] = { item: { key: `${repo.id}:${definition.packageId}`, definition, origin } };
      } catch { check(); results[index] = { warning: `第 ${index + 1} 个规则包下载或校验失败` }; }
    }
  }));
  check();
  const packages: RepositoryPackage[] = [], warnings: string[] = [], ids = new Set<string>();
  for (const result of results) {
    if ("warning" in result) { warnings.push(result.warning); continue; }
    if (ids.has(result.item.definition.packageId)) { warnings.push(`同一仓库包含重复 packageId：${result.item.definition.packageId}`); continue; }
    ids.add(result.item.definition.packageId); packages.push(result.item);
  }
  if (files.length && !packages.length) throw new Error("仓库包含规则包文件，但全部下载或校验失败");
  return { packages, warnings };
}
