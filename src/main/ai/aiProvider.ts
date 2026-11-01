import type { AiMessage, AiModel } from '@shared/features/ai';

export class AiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiError';
  }
}

/**
 * What the assistant needs from a model runtime. There is intentionally no way to hand a provider
 * tools or callbacks into the app: all a model can ever produce is text for the user to read.
 */
export interface AiProvider {
  readonly id: string;
  listModels(signal: AbortSignal): Promise<AiModel[]>;
  chat(model: string, messages: AiMessage[], onText: (text: string) => void, signal: AbortSignal): Promise<void>;
}
