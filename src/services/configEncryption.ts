const HEADER = "ProcWeaver encrypted configuration v1";
const MAX = 8 * 1024 * 1024;
const ITERATIONS = 600000;
const bytesToBase64 = (bytes: Uint8Array) => {
  let text = ""; for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
};
function base64ToBytes(text: string): Uint8Array<ArrayBuffer> {
  if (typeof text !== "string" || text.length > MAX) throw new Error("加密备份字段无效");
  const decoded = atob(text); return Uint8Array.from(decoded, c => c.charCodeAt(0));
}
async function key(password: string, salt: Uint8Array<ArrayBuffer>) {
  if (password.length < 12 || password.length > 1024) throw new Error("备份密码至少 12 个字符，最长 1024 个字符");
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" }, material,
    { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
export async function encryptConfiguration(value: unknown, password: string): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify(value));
  if (data.length > 6 * 1024 * 1024 - 1024) throw new Error("配置超过 6 MB 备份上限");
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(HEADER) }, await key(password, salt), data);
  return JSON.stringify({ format: HEADER, iterations: ITERATIONS, salt: bytesToBase64(salt), iv: bytesToBase64(iv), data: bytesToBase64(new Uint8Array(cipher)) });
}
export async function decryptConfiguration(raw: string, password: string): Promise<unknown> {
  if (raw.length > MAX) throw new Error("备份文件超过 8 MB");
  const parsed = JSON.parse(raw);
  if (parsed.format !== HEADER || parsed.iterations !== ITERATIONS) throw new Error("不支持的加密备份版本");
  const salt = base64ToBytes(parsed.salt), iv = base64ToBytes(parsed.iv), data = base64ToBytes(parsed.data);
  if (salt.length !== 16 || iv.length !== 12 || data.length < 16) throw new Error("加密备份格式无效");
  const derived = await key(password, salt);
  try {
    const decoded = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(HEADER) }, derived, data);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded));
  } catch { throw new Error("密码不正确或备份已损坏，未修改当前配置"); }
}
