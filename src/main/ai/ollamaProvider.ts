import type { AiMessage, AiModel } from '@shared/features/ai';
import { AiError, type AiProvider } from './aiProvider';

interface TagsResponse {
  models?: { name?: unknown; size?: unknown; details?: { family?: unknown } }[];
}

interface ChatLine {
  message?: { content?: unknown };
  error?: unknown;
  done?: unknown;
}

const MAX_ERROR_CHARS = 300;

/** Speaks the HTTP API of Ollama. Redirects are refused, since one could lead away from the checked address. */
export class OllamaProvider implements AiProvider {
  readonly id = 'ollama';

  constructor(private readonly endpoint: string) {}

  async listModels(signal: AbortSignal): Promise<AiModel[]> {
    const response = await this.request('/api/tags', { method: 'GET', signal });
    let body: TagsResponse;
    try {
      body = (await response.json()) as TagsResponse;
    } catch {
      throw new AiError(`${this.endpoint} antwortet nicht wie Ollama.`);
    }
    return (body.models ?? [])
      .filter((model) => typeof model.name === 'string')
      .map((model) => ({
        name: model.name as string,
        sizeBytes: typeof model.size === 'number' ? model.size : null,
        family: typeof model.details?.family === 'string' ? model.details.family : null
      }));
  }

  async chat(model: string, messages: AiMessage[], onText: (text: string) => void, signal: AbortSignal): Promise<void> {
    const response = await this.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true }),
      signal
    });
    if (!response.body) throw new AiError('Ollama hat keine Antwort geliefert.');
    const decoder = new TextDecoder();
    let pending = '';
    const handle = (line: string) => {
      if (!line.trim()) return;
      let parsed: ChatLine;
      try {
        parsed = JSON.parse(line) as ChatLine;
      } catch {
        throw new AiError('Ollama hat eine unlesbare Antwort geliefert.');
      }
      if (typeof parsed.error === 'string') throw new AiError(`Ollama meldet: ${parsed.error.slice(0, MAX_ERROR_CHARS)}`);
      if (typeof parsed.message?.content === 'string' && parsed.message.content) onText(parsed.message.content);
    };
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) handle(line);
    }
    handle(pending);
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(new URL(path, this.endpoint), { ...init, redirect: 'error' });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      throw new AiError(`Ollama unter ${this.endpoint} ist nicht erreichbar. Läuft der Dienst?`);
    }
    if (response.ok) return response;
    const detail = await response.text().catch(() => '');
    let message = detail;
    try {
      const parsed = JSON.parse(detail) as { error?: unknown };
      if (typeof parsed.error === 'string') message = parsed.error;
    } catch {
      // Not JSON; the text itself is the best there is.
    }
    throw new AiError(`Ollama meldet ${response.status}: ${message.slice(0, MAX_ERROR_CHARS)}`.trim());
  }
}
