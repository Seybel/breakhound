/**
 * The model `breakhound fix` asks for edits: the developer's own API key
 * (Anthropic, or anything that speaks OpenAI's chat completions) or a local
 * Ollama model. breakhound has no service and no key of its own.
 */

export type Provider = 'anthropic' | 'openai' | 'ollama';

export const PROVIDERS: readonly Provider[] = ['anthropic', 'openai', 'ollama'];

export interface ModelClient {
  provider: Provider;
  model: string;
  /** Where requests go, to tell the developer before any code is sent. */
  endpoint: string;
  complete(system: string, prompt: string): Promise<string>;
}

export interface ModelOptions {
  provider?: Provider;
  model?: string;
  env?: NodeJS.ProcessEnv;
  /** Per request, in milliseconds. Local models can be slow. */
  timeoutMs?: number;
}

const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';
const MAX_TOKENS = 8192;

async function post(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
) {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason =
      error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : String(error);
    throw new Error(`Could not reach ${new URL(url).origin}: ${reason}`);
  }
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } | string };
      message =
        typeof parsed.error === 'string' ? parsed.error : (parsed.error?.message ?? message);
    } catch {
      // Not JSON; the start of the body says enough.
    }
    throw new Error(`The model API answered HTTP ${res.status}: ${message}`);
  }
  return JSON.parse(text) as unknown;
}

function anthropic(key: string, model: string, base: string, timeoutMs: number): ModelClient {
  const endpoint = `${base.replace(/\/+$/, '')}/v1/messages`;
  return {
    provider: 'anthropic',
    model,
    endpoint,
    async complete(system, prompt) {
      const data = (await post(
        endpoint,
        { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        { model, max_tokens: MAX_TOKENS, system, messages: [{ role: 'user', content: prompt }] },
        timeoutMs,
      )) as { content?: { type: string; text?: string }[] };
      return (data.content ?? [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('');
    },
  };
}

/** OpenAI's chat completions, which Ollama and most other providers also speak. */
function chat(
  provider: Provider,
  key: string | null,
  model: string,
  base: string,
  timeoutMs: number,
): ModelClient {
  const endpoint = `${base.replace(/\/+$/, '')}/chat/completions`;
  return {
    provider,
    model,
    endpoint,
    async complete(system, prompt) {
      const data = (await post(
        endpoint,
        key ? { authorization: `Bearer ${key}` } : {},
        {
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
        },
        timeoutMs,
      )) as { choices?: { message?: { content?: string } }[] };
      return data.choices?.[0]?.message?.content ?? '';
    },
  };
}

function ollamaBase(env: NodeJS.ProcessEnv): string {
  const host = env.OLLAMA_HOST?.trim() || 'http://127.0.0.1:11434';
  return /^https?:\/\//.test(host) ? host.replace(/\/+$/, '') : `http://${host}`;
}

/** The models pulled into a local Ollama, or null when Ollama isn't running. */
async function ollamaModels(base: string): Promise<string[] | null> {
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { models?: { name: string }[] };
    return (data.models ?? []).map((m) => m.name);
  } catch {
    return null;
  }
}

const SETUP = `breakhound fix needs a model to write the fixes. Use one of:
  ANTHROPIC_API_KEY=...  (your Anthropic key; uses ${DEFAULT_ANTHROPIC_MODEL} unless you pass --model)
  OPENAI_API_KEY=... with --model <name>  (OpenAI, or any compatible API via OPENAI_BASE_URL)
  Ollama running locally, free: https://ollama.com, then for example: ollama pull qwen2.5-coder
Or skip it: breakhound prompt --copy, and paste the prompt into your coding agent.`;

/**
 * Picks the model: the provider asked for, or else the first one set up, in
 * this order: an Anthropic key, an OpenAI key, a local Ollama.
 */
export async function resolveModel(options: ModelOptions = {}): Promise<ModelClient> {
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? 300_000;
  const model = options.model ?? env.BREAKHOUND_MODEL;
  let provider = options.provider;
  if (!provider) {
    if (env.ANTHROPIC_API_KEY) provider = 'anthropic';
    else if (env.OPENAI_API_KEY) provider = 'openai';
    else provider = 'ollama';
  }

  if (provider === 'anthropic') {
    const key = env.ANTHROPIC_API_KEY;
    if (!key) throw new Error(`ANTHROPIC_API_KEY isn't set.\n\n${SETUP}`);
    const base = env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
    return anthropic(key, model || DEFAULT_ANTHROPIC_MODEL, base, timeoutMs);
  }
  if (provider === 'openai') {
    const key = env.OPENAI_API_KEY;
    if (!key) throw new Error(`OPENAI_API_KEY isn't set.\n\n${SETUP}`);
    if (!model) throw new Error('Say which OpenAI model to use, e.g. --model <name>.');
    return chat(
      'openai',
      key,
      model,
      env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      timeoutMs,
    );
  }

  const base = ollamaBase(env);
  const pulled = await ollamaModels(base);
  if (!pulled) {
    throw new Error(
      options.provider
        ? `Ollama isn't running at ${base}.\n\n${SETUP}`
        : `No model is set up.\n\n${SETUP}`,
    );
  }
  const chosen = model || pulled[0];
  if (!chosen)
    throw new Error('Ollama has no models yet. Pull one, e.g.: ollama pull qwen2.5-coder');
  return chat('ollama', null, chosen, `${base}/v1`, timeoutMs);
}
