export interface EmbeddingClient {
  embed(input: { model: string; texts: string[] }): Promise<number[][]>;
}

export class OpenAiEmbeddingClient implements EmbeddingClient {
  constructor(private readonly options: { fetcher?: typeof fetch; openaiApiKey: () => Promise<string | undefined> } = { openaiApiKey: async () => process.env.OPENAI_API_KEY?.trim() }) {}

  async embed(input: { model: string; texts: string[] }): Promise<number[][]> {
    const apiKey = await this.options.openaiApiKey();
    if (!apiKey) throw new Error("OPENAI_KEY_NOT_CONFIGURED");
    const response = await (this.options.fetcher || fetch)("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: input.model, input: input.texts }),
    });
    if (!response.ok) throw new Error(`OPENAI_EMBEDDING_HTTP_${response.status}`);
    const body = await response.json() as { data?: Array<{ index?: number; embedding?: number[] }> };
    const data = [...(body.data || [])].sort((left, right) => Number(left.index || 0) - Number(right.index || 0));
    if (data.length !== input.texts.length || data.some((item) => !Array.isArray(item.embedding) || !item.embedding.length)) throw new Error("OPENAI_EMBEDDING_INVALID");
    return data.map((item) => item.embedding!);
  }
}

export class OllamaEmbeddingClient implements EmbeddingClient {
  constructor(private readonly options: { fetcher?: typeof fetch; baseUrl?: string } = {}) {}

  async embed(input: { model: string; texts: string[] }): Promise<number[][]> {
    const baseUrl = (this.options.baseUrl || "http://localhost:11434").replace(/\/$/, "");
    const response = await (this.options.fetcher || fetch)(`${baseUrl}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: input.model, input: input.texts }),
    });
    if (!response.ok) throw new Error(`OLLAMA_EMBEDDING_HTTP_${response.status}`);
    const body = await response.json() as { embeddings?: unknown };
    if (!Array.isArray(body.embeddings) || body.embeddings.length !== input.texts.length || body.embeddings.some((embedding) => !Array.isArray(embedding) || !embedding.length)) throw new Error("OLLAMA_EMBEDDING_INVALID");
    return body.embeddings as number[][];
  }
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (!left.length || left.length !== right.length) return 0;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] ** 2;
    rightMagnitude += right[index] ** 2;
  }
  if (!leftMagnitude || !rightMagnitude) return 0;
  return Math.max(0, Math.min(1, dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude))));
}
