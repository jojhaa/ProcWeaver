import { createContext, useContext } from "react";
import type { PlatformCapabilities } from "../types/platform";
export const PlatformContext = createContext<PlatformCapabilities | null>(null);
export function usePlatform(): PlatformCapabilities {
  const value = useContext(PlatformContext);
  if (!value) throw new Error("缺少平台能力上下文");
  return value;
}
