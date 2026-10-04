import { verifyBrowserEvidence, type BrowserEvidence } from "../../lib/verify-evidence";

self.onmessage = async (event: MessageEvent<{ path: string; modified: boolean }>) => {
  try {
    const response = await fetch(event.data.path, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Evidence download failed (HTTP ${response.status})`);
    if (typeof DecompressionStream === "undefined") throw new Error("This browser needs gzip decompression support. Use a current Chrome, Edge, Firefox or Safari.");
    const stream = response.body!.pipeThrough(new DecompressionStream("gzip"));
    const bundle = await new Response(stream).json() as BrowserEvidence;
    self.postMessage({ report: verifyBrowserEvidence(bundle, event.data.modified) });
  } catch (error) { self.postMessage({ error: error instanceof Error ? error.message : "Evidence verification failed" }); }
};
