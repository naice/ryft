import type { RyftApi } from '@shared/contracts';

declare global {
  interface Window {
    ryft: RyftApi;
  }
}

export const api: RyftApi = window.ryft;

/** Electron prefixes IPC rejections; users should only see our own message. */
export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '');
}
