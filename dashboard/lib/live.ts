import type { MemoryResponse, PluginInfo, StatusResponse } from "./generated.ts";

type Snapshot = { status: StatusResponse; memory: MemoryResponse; plugins: PluginInfo[] };
type Loader = <T>(path: string, init?: RequestInit) => Promise<T>;

export async function refreshBridge(load: Loader, signal: AbortSignal, publish: (snapshot: Snapshot) => void) {
  if (signal.aborted) return;
  try {
    const [status, memory, plugins] = await Promise.all([
      load<StatusResponse>("/api/v1/status", { signal }),
      load<MemoryResponse>("/api/v1/memory", { signal }),
      load<PluginInfo[]>("/api/v1/plugins", { signal }),
    ]);
    if (!signal.aborted) publish({ status, memory, plugins });
  } catch (error) {
    if (!signal.aborted) throw error;
  }
}
