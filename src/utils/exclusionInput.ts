/** 冒号和斜杠属于 IPv6/CIDR 内容，不能当作分隔符。 */
export function splitExclusionInput(text: string): string[] {
  return text.split(/[\s,，;；、]+/u).filter(Boolean);
}
