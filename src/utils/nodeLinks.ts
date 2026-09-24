import type { LocalNodeDraft, NodeConfig } from "../types/localNodes";

function decoded(text: string) { try { return decodeURIComponent(text); } catch { throw new Error("链接编码无效"); } }
function fingerprint(value: unknown) { return String(value).toLowerCase() === "ios" ? "iOS" : value; }
function base64(text: string): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/").replace(/\s/g, "")), c => c.charCodeAt(0))); }
  catch { throw new Error("链接的 Base64 内容无效"); }
}
function bool(value: string): boolean {
  if (!["0", "1", "true", "false"].includes(value)) throw new Error("布尔参数须为 0/1/true/false");
  return value === "1" || value === "true";
}
function port(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error("端口须为 1–65535");
  return Number(value);
}
function ssr(link: string): LocalNodeDraft {
  const body = base64(link.slice(6));
  const split = body.indexOf("/?");
  const main = split < 0 ? body : body.slice(0, split);
  const parts = main.match(/^(.*):(\d+):([^:]+):([^:]+):([^:]+):([^:]*)$/);
  if (!parts) throw new Error("SSR 链接内容无效");
  const config: NodeConfig = { type: "ssr", server: parts[1].replace(/^\[|\]$/g, ""), port: port(parts[2]), protocol: parts[3], cipher: parts[4], obfs: parts[5], password: base64(parts[6]), udp: true };
  const query = new URL(`https://parse.invalid/?${split < 0 ? "" : body.slice(split + 2)}`).searchParams;
  let name = `SSR ${config.server}`;
  const seen = new Set<string>();
  for (const [key, value] of query) {
    if (seen.has(key)) throw new Error("SSR 链接参数重复"); seen.add(key);
    if (key === "remarks") name = base64(value);
    else if (key === "obfsparam") config["obfs-param"] = base64(value);
    else if (key === "protoparam") config["protocol-param"] = base64(value);
    else if (key !== "group") throw new Error(`未支持的 SSR 参数：${key.slice(0, 40)}`);
    // group is subscription presentation metadata, not a node transport option.
  }
  return { name, config };
}
function mieru(link: string): LocalNodeDraft[] {
  const url = new URL(link);
  if (!url.hostname || url.port || url.pathname && url.pathname !== "/") throw new Error("Mieru 链接地址无效，端口须通过 port 参数填写");
  const ports = url.searchParams.getAll("port"), protocols = url.searchParams.getAll("protocol");
  if (!ports.length || ports.length !== protocols.length) throw new Error("Mieru port 与 protocol 须成对填写");
  const common: NodeConfig = { type: "mieru", server: url.hostname.replace(/^\[|\]$/g, ""), username: decoded(url.username), password: decoded(url.password), udp: true };
  const seen = new Set<string>();
  for (const [key, value] of url.searchParams) {
    if (["port", "protocol"].includes(key)) continue;
    if (seen.has(key)) throw new Error("Mieru 链接参数重复"); seen.add(key);
    if (["multiplexing", "handshake-mode", "traffic-pattern"].includes(key)) common[key] = value;
    else if (key !== "profile") throw new Error(`未支持的 Mieru 参数：${key.slice(0, 40)}`);
  }
  const name = decoded(url.hash.slice(1)) || url.searchParams.get("profile") || `Mieru ${common.server}`;
  return ports.map((value, i) => {
    const transport = protocols[i].toUpperCase();
    if (!["TCP", "UDP"].includes(transport)) throw new Error("Mieru 传输协议须为 TCP 或 UDP");
    const config: NodeConfig = { ...common, transport };
    if (value.includes("-")) {
      const range = value.split("-");
      if (range.length !== 2 || port(range[0]) > port(range[1])) throw new Error("Mieru 端口范围无效");
      config["port-range"] = value;
    } else config.port = port(value);
    return { name: ports.length === 1 ? name : `${name}:${value}/${transport}`, config };
  });
}
function vmess(link: string): LocalNodeDraft {
  let data: Record<string, unknown>;
  try { data = JSON.parse(base64(link.slice(8))); } catch { throw new Error("VMess 链接内容无效"); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("VMess 链接内容无效");
  const allowed = ["v", "ps", "add", "port", "id", "aid", "scy", "net", "type", "host", "path", "tls", "sni", "alpn", "fp"];
  if (Object.keys(data).some(k => !allowed.includes(k))) throw new Error("VMess 链接包含未支持字段，请改用节点 YAML 导入");
  const config: NodeConfig = { type: "vmess", server: data.add, port: Number(data.port), uuid: data.id, alterId: Number(data.aid ?? 0), cipher: data.scy || "auto" };
  if (data.tls) { if (data.tls !== "tls") throw new Error("VMess TLS 类型不支持"); config.tls = true; }
  if (data.sni) config.servername = data.sni;
  if (data.alpn) config.alpn = String(data.alpn).split(",");
  if (data.fp) config["client-fingerprint"] = fingerprint(data.fp);
  const net = String(data.net || "tcp");
  if (net === "ws") { config.network = "ws"; config["ws-opts"] = { path: data.path || "/", ...(data.host ? { headers: { Host: data.host } } : {}) }; }
  else if (net === "grpc") { config.network = "grpc"; config["grpc-opts"] = { "grpc-service-name": data.path || "" }; }
  else if (net !== "tcp" || (data.type && data.type !== "none") || data.host || data.path) throw new Error("此 VMess 传输选项请使用节点 YAML 导入");
  return { name: String(data.ps || data.add || "VMess 节点"), config };
}
function parseOne(link: string): LocalNodeDraft {
  if (link.startsWith("vmess://") && !link.slice(8).split(/[?#]/)[0].includes("@")) return vmess(link);
  if (link.startsWith("ssr://")) return ssr(link);
  let normalized = link;
  let hopping = "";
  if (/^(hysteria2|hy2)(\+realm)?:\/\//.test(link)) {
    // URL rejects port ranges; retain them separately before parsing the URI.
    normalized = link.replace(/^(\w+(?:\+realm)?:\/\/(?:[^/?#]*@)?(?:\[[^\]]+\]|[^:/?#]+)):([\d,-]+)(?=[/?#]|$)/, (all, head: string, ports: string) => {
      if (!/[-,]/.test(ports)) return all;
      for (const item of ports.split(",")) { const range = item.split("-"); if (range.length > 2 || range.some(n => !/^\d+$/.test(n)) || range.length === 2 && port(range[0]) > port(range[1])) throw new Error("Hysteria2 跳跃端口无效"); range.forEach(port); }
      hopping = ports; return `${head}:${ports.split(/[-,]/)[0]}`;
    });
  }
  if (link.startsWith("ss://") && !link.slice(5).split(/[?#]/)[0].includes("@")) {
    const [body, tail = ""] = link.slice(5).split("#", 2);
    const plain = base64(body); const at = plain.lastIndexOf("@");
    if (at < 1) throw new Error("Shadowsocks 链接缺少服务器");
    normalized = `ss://${encodeURIComponent(plain.slice(0, at))}@${plain.slice(at + 1)}${tail ? `#${tail}` : ""}`;
  }
  let url: URL;
  try { url = new URL(normalized); } catch { throw new Error("链接格式无效"); }
  const protocol = url.protocol.slice(0, -1);
  const type = ({ hy2: "hysteria2", "hy2+realm": "hysteria2", "hysteria2+realm": "hysteria2", socks: "socks5", socks5h: "socks5", https: "http" } as Record<string, string>)[protocol] || protocol;
  if (!["vmess", "vless", "ss", "trojan", "hysteria", "hysteria2", "socks5", "http", "tuic", "anytls"].includes(type)) throw new Error("此协议没有接入分享链接解析，请使用 Mihomo 节点 YAML / JSON；NaiveProxy 不支持");
  const realm = protocol.endsWith("+realm");
  if (!realm && url.pathname && url.pathname !== "/") throw new Error("链接含未支持的路径参数，请使用节点 YAML");
  const config: NodeConfig = { type, server: url.hostname.replace(/^\[|\]$/g, ""), port: port(url.port || (protocol === "http" ? "80" : ["https", "trojan", "hysteria", "hysteria2", "hy2", "anytls"].includes(protocol) || realm ? "443" : "0")) };
  if (hopping) config.ports = hopping;
  let user = decoded(url.username), password = decoded(url.password);
  if (type === "ss") {
    if (!password) { if (!user.includes(":")) user = base64(user); const colon = user.indexOf(":"); if (colon < 1) throw new Error("Shadowsocks 认证内容无效"); password = user.slice(colon + 1); user = user.slice(0, colon); }
    config.cipher = user; config.password = password;
  } else if (["vless", "vmess"].includes(type)) { config.uuid = user; if (type === "vmess") { config.alterId = 0; config.cipher = "auto"; } }
  else if (type === "tuic") { if (password) { config.uuid = user; config.password = password; } else config.token = user; }
  else if (["trojan", "hysteria2", "anytls"].includes(type)) config.password = password ? `${user}:${password}` : user;
  else if (type === "hysteria") { if (user || password) throw new Error("Hysteria 认证请使用 auth 参数"); }
  else { if (user && !password && !user.includes(":")) { try { const auth = base64(user), colon = auth.indexOf(":"); if (colon >= 0) { user = auth.slice(0, colon); password = auth.slice(colon + 1); } } catch { /* plain username is allowed */ } } if (user) config.username = user; if (password) config.password = password; }
  if (protocol === "https") config.tls = true;
  const seen = new Set<string>();
  for (const [key, value] of url.searchParams) {
    if (seen.has(key) && !(realm && key === "stun")) throw new Error("链接参数重复，请核对后导入"); seen.add(key);
    switch (key) {
      case "sni": case "peer": config[["vless", "vmess"].includes(type) ? "servername" : "sni"] = value; break;
      case "security": if (!["none", "tls", "reality"].includes(value)) throw new Error("链接安全类型不支持"); config.tls = value !== "none"; break;
      case "allowInsecure": case "insecure": config["skip-cert-verify"] = bool(value); break;
      case "alpn": config.alpn = value.split(","); break;
      case "fp": config["client-fingerprint"] = fingerprint(value); break;
      case "flow": config.flow = value; break;
      case "encryption": if (type === "vmess") config.cipher = value; else if (type === "vless") config.encryption = value; else throw new Error("此协议不支持 encryption 参数"); break;
      case "type": if (!["tcp", "ws", "grpc"].includes(value)) throw new Error("此传输类型请使用节点 YAML"); if (value !== "tcp") config.network = value; break;
      case "headerType": if (type !== "vless" || value !== "none" || ![null, "tcp"].includes(url.searchParams.get("type"))) throw new Error("此伪装头选项暂不支持，请核对传输类型"); break;
      case "path": case "host": case "serviceName": case "pbk": case "sid": break;
      case "auth": if (type === "hysteria") config["auth-str"] = value; else if (realm) config.password = value; else throw new Error("此协议不支持 auth 参数"); break;
      case "protocol": if (type !== "hysteria" || !["udp", "faketcp", "wechat-video"].includes(value)) throw new Error("Hysteria 传输协议无效"); config.protocol = value; break;
      case "obfsParam": if (type !== "hysteria" || url.searchParams.get("obfs") !== "xplus") throw new Error("obfsParam 须配合 Hysteria xplus"); break;
      case "upmbps": case "downmbps": if (type !== "hysteria" || !/^\d+(\.\d+)?$/.test(value)) throw new Error("Hysteria 带宽参数无效"); if (url.searchParams.has(key === "upmbps" ? "up" : "down")) throw new Error("带宽参数重复"); config[key === "upmbps" ? "up" : "down"] = `${value} Mbps`; break;
      case "pinSHA256": case "hpkp": case "pcs": config.fingerprint = value; break;
      case "congestion_control": config["congestion-controller"] = value; break;
      case "udp_relay_mode": config["udp-relay-mode"] = value; break;
      case "disable_sni": config["disable-sni"] = bool(value); break;
      case "stun": if (!realm) throw new Error("stun 参数须使用 Hysteria2 Realm 链接"); break;
      case "mport": if (type !== "hysteria2" || hopping) throw new Error("跳跃端口重复或协议不匹配"); config.ports = value; break;
      case "uot": case "udp-over-tcp": if (type !== "ss") throw new Error("此链接协议不支持 UDP over TCP"); config["udp-over-tcp"] = bool(value); break;
      case "obfs": case "obfs-password": case "up": case "down": case "congestion-controller": case "udp-relay-mode": config[key] = value; break;
      case "plugin": {
        if (type !== "ss") throw new Error("此协议不支持 plugin");
        const [name, ...parts] = value.split(";");
        if (!["obfs-local", "simple-obfs", "v2ray-plugin"].includes(name)) throw new Error("Shadowsocks 插件不支持");
        config.plugin = name === "v2ray-plugin" ? "v2ray-plugin" : "obfs";
        const opts: Record<string, unknown> = {};
        for (const part of parts) { const [k, ...v] = part.split("="); const mapped = ({ obfs: "mode", "obfs-host": "host" } as Record<string, string>)[k] || k; opts[mapped] = v.length ? v.join("=") : true; }
        config["plugin-opts"] = opts; break;
      }
      default: throw new Error(`未支持的链接参数：${key.slice(0, 40)}，请使用节点 YAML 导入`);
    }
  }
  if (type === "hysteria" && url.searchParams.get("obfs") === "xplus") {
    if (!url.searchParams.get("obfsParam")) throw new Error("Hysteria xplus 缺少 obfsParam 密码");
    config.obfs = url.searchParams.get("obfsParam");
  }
  if (realm) {
    if (!url.searchParams.has("auth")) delete config.password;
    config["realm-opts"] = { enable: true, "server-url": `https://${url.host}`, token: password ? `${user}:${password}` : user, "realm-id": decoded(url.pathname.replace(/^\//, "")), ...(url.searchParams.has("stun") ? { "stun-servers": url.searchParams.getAll("stun") } : {}) };
  }
  if (config.network !== "grpc" && url.searchParams.has("serviceName") || config.network !== "ws" && ["host", "path"].some(k => url.searchParams.has(k))) throw new Error("传输参数与协议不匹配");
  if (config.network === "ws") config["ws-opts"] = { path: url.searchParams.get("path") || "/", ...(url.searchParams.has("host") ? { headers: { Host: url.searchParams.get("host") } } : {}) };
  else if (config.network === "grpc") config["grpc-opts"] = { "grpc-service-name": url.searchParams.get("serviceName") || "" };
  else if (["host", "path", "serviceName"].some(k => url.searchParams.has(k))) throw new Error("传输参数与协议不匹配");
  if (url.searchParams.get("security") === "reality") {
    if (type !== "vless" || !url.searchParams.get("pbk")) throw new Error("REALITY 须使用 VLESS 并填写公钥");
    config["reality-opts"] = { "public-key": url.searchParams.get("pbk"), "short-id": url.searchParams.get("sid") || "" };
  } else if (url.searchParams.has("pbk") || url.searchParams.has("sid")) throw new Error("REALITY 参数缺少 security=reality");
  return { name: decoded(url.hash.slice(1)) || `${type.toUpperCase()} ${config.server}`, config };
}
export function parseNodeLinks(text: string): LocalNodeDraft[] {
  if (text.length > 1024 * 1024) throw new Error("导入内容不能超过 1 MB");
  let content = text.trim();
  if (content && !/^[a-z][a-z\d+.-]*:\/\//i.test(content)) {
    content = base64(content).trim();
    if (!/^[a-z][a-z\d+.-]*:\/\//i.test(content)) throw new Error("Base64 解码后须为节点链接列表，每行一个链接");
  }
  const lines = content.split(/\r\n|\r|\n/).map(s => s.trim()).filter(Boolean);
  if (!lines.length || lines.length > 256) throw new Error("请填写 1–256 条节点链接，每行一条");
  const nodes = lines.flatMap((line, i) => { try { return line.startsWith("mierus://") ? mieru(line) : [parseOne(line)]; } catch (e) { throw new Error(`第 ${i + 1} 条：${e instanceof Error ? e.message : "链接无效"}`); } });
  if (nodes.length > 256) throw new Error("展开后最多导入 256 个节点");
  return nodes;
}
