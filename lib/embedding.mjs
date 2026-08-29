export class EmbeddingClient {
  constructor(cfg, logger = console) {
    this.cfg = cfg;
    this.logger = logger;
    this.baseUrl = cfg.embeddingBaseUrl.replace(/\/+$/, "");
  }

  async embedOne(text, signal) {
    const vectors = await this.embedMany([text], signal);
    return vectors[0];
  }

  async embedMany(texts, signal) {
    const inputs = texts.map((text) => String(text ?? "").trim()).filter(Boolean);
    if (inputs.length === 0) return [];
    const timeout = signal ? undefined : this.cfg.embeddingTimeoutMs;
    const controller = signal ? null : new AbortController();
    const effectiveSignal = signal ?? controller?.signal;
    if (controller) {
      const timer = setTimeout(() => controller.abort(new Error("embedding timeout")), timeout);
      controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
    }
    try {
      const batches = [];
      for (let i = 0; i < inputs.length; i += this.cfg.embeddingBatchSize) {
        batches.push(inputs.slice(i, i + this.cfg.embeddingBatchSize));
      }
      const vectors = [];
      for (const batch of batches) {
        const response = await fetch(`${this.baseUrl}/embeddings`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.cfg.embeddingApiKey
              ? { authorization: `Bearer ${this.cfg.embeddingApiKey}` }
              : {}),
          },
          body: JSON.stringify({
            model: this.cfg.embeddingModel,
            input: batch,
          }),
          signal: effectiveSignal,
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(
            `embedding endpoint ${this.baseUrl} returned ${response.status}: ${
              payload?.error?.message || payload?.message || "unknown error"
            }`,
          );
        }
        const data = Array.isArray(payload?.data) ? payload.data : [];
        if (data.length !== batch.length) {
          throw new Error(
            `embedding endpoint returned ${data.length} vectors for ${batch.length} input(s)`,
          );
        }
        for (let i = 0; i < batch.length; i += 1) {
          const raw = data[i]?.embedding;
          if (!Array.isArray(raw) || raw.length === 0) {
            throw new Error(`embedding endpoint returned an empty vector for input #${i + 1}`);
          }
          vectors.push(normalizeVector(new Float32Array(raw)));
        }
      }
      return vectors;
    } finally {
      if (controller) controller.abort();
    }
  }
}

export function normalizeVector(vector) {
  if (!(vector instanceof Float32Array)) vector = new Float32Array(vector);
  let sum = 0;
  for (let i = 0; i < vector.length; i += 1) sum += vector[i] * vector[i];
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm) || norm === 0) return vector;
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) out[i] = vector[i] / norm;
  return out;
}

export function cosineScore(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return Math.max(0, dot);
}
