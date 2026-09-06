const DEFAULT_TIMEOUT_MS = 15_000;

export async function withTimeout<T>(promise: Promise<T>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("UPSTREAM_TIMEOUT")), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function fetchWithTimeout(fetcher: typeof fetch, input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetcher(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("UPSTREAM_TIMEOUT");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function readResponseText(response: Response, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  return withTimeout(response.text(), timeoutMs);
}

export async function readResponseJson<T>(response: Response, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  return withTimeout(response.json() as Promise<T>, timeoutMs);
}

export async function readResponseBytes(response: Response, maxBytes: number, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Uint8Array> {
  const declaredSize = Number(response.headers.get("content-length") || 0);
  if (declaredSize > maxBytes) throw new Error("PDF_TOO_LARGE");
  if (!response.body) {
    const bytes = new Uint8Array(await withTimeout(response.arrayBuffer(), timeoutMs));
    if (bytes.byteLength > maxBytes) throw new Error("PDF_TOO_LARGE");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await withTimeout(reader.read(), timeoutMs);
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("PDF_TOO_LARGE");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
