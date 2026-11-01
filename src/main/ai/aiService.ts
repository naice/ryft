import { randomUUID } from 'node:crypto';
import { buildAiMessages, isLocalEndpoint, type AiChunkEvent, type AiModel, type AiRunInput } from '@shared/features/ai';
import { AiError, type AiProvider } from './aiProvider';
import { OllamaProvider } from './ollamaProvider';

const MODEL_LIST_TIMEOUT_MS = 8_000;

export interface AiEventSink {
  aiChunk(event: AiChunkEvent): void;
}

export interface AiSettings {
  aiEnabled: boolean;
  aiEndpoint: string;
  aiModel: string | null;
}

interface RunningRequest {
  ownerId: number;
  controller: AbortController;
}

export class AiService {
  private readonly running = new Map<string, RunningRequest>();

  constructor(
    private readonly settings: () => AiSettings,
    private readonly sink: AiEventSink,
    private readonly createProvider: (endpoint: string) => AiProvider = (endpoint) => new OllamaProvider(endpoint)
  ) {}

  async models(): Promise<AiModel[]> {
    const signal = AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS);
    try {
      return await this.provider().listModels(signal);
    } catch (error) {
      if (signal.aborted) throw new AiError(`${this.settings().aiEndpoint} hat nicht rechtzeitig geantwortet.`);
      throw error;
    }
  }

  /** Resolves when the answer is complete or cancelled. Text arrives through the sink meanwhile. */
  async run(ownerId: number, input: AiRunInput): Promise<'done' | 'cancelled'> {
    const provider = this.provider();
    const { aiModel } = this.settings();
    if (!aiModel) throw new AiError('Wähle zuerst ein Modell.');
    const controller = new AbortController();
    this.running.set(input.requestId, { ownerId, controller });
    try {
      await provider.chat(
        aiModel,
        buildAiMessages(input, randomUUID()),
        (text) => this.sink.aiChunk({ requestId: input.requestId, text }),
        controller.signal
      );
      return 'done';
    } catch (error) {
      if (controller.signal.aborted) return 'cancelled';
      if (error instanceof AiError) throw error;
      throw new AiError('Die Antwort des Modells wurde unterbrochen.');
    } finally {
      this.running.delete(input.requestId);
    }
  }

  cancel(ownerId: number, requestId: string): void {
    const request = this.running.get(requestId);
    if (request?.ownerId === ownerId) request.controller.abort();
  }

  activeRequests(): number {
    return this.running.size;
  }

  disposeOwner(ownerId: number): void {
    for (const request of this.running.values()) {
      if (request.ownerId === ownerId) request.controller.abort();
    }
  }

  disposeAll(): void {
    for (const request of this.running.values()) request.controller.abort();
  }

  /** Checked on every use: a preference could have been changed, and an old value restored from a backup. */
  private provider(): AiProvider {
    const { aiEnabled, aiEndpoint } = this.settings();
    if (!aiEnabled) throw new AiError('Der KI-Assistent ist ausgeschaltet.');
    if (!isLocalEndpoint(aiEndpoint)) throw new AiError('Nur lokale Adressen sind erlaubt.');
    return this.createProvider(aiEndpoint);
  }
}
