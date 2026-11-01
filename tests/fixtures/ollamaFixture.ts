import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface OllamaRequest {
  model: string;
  messages: { role: string; content: string }[];
}

/** Speaks just enough of the Ollama protocol, on a port of its own. */
export class OllamaFixture {
  readonly requests: OllamaRequest[] = [];
  models = ['tiny:1', 'other:2'];
  chunks: string[] = ['Hier ', 'der Befehl:\n```sh\n', 'echo ryft-from-model\n```\n'];
  /** Stops after the first chunk until the client goes away. */
  hang = false;
  redirectTo: string | null = null;
  errorStatus: number | null = null;
  clientGone = 0;
  private server: Server | null = null;
  private readonly open = new Set<ServerResponse>();

  get url(): string {
    return `http://127.0.0.1:${(this.server?.address() as AddressInfo).port}`;
  }

  async listen(): Promise<void> {
    this.server = createServer((request, response) => {
      if (this.redirectTo) {
        response.writeHead(302, { location: this.redirectTo }).end();
        return;
      }
      if (this.errorStatus) {
        response.writeHead(this.errorStatus, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'model not loaded' }));
        return;
      }
      if (request.url === '/api/tags') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ models: this.models.map((name) => ({ name, size: 1000, details: { family: 'fixture' } })) }));
        return;
      }
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      request.on('end', () => {
        this.requests.push(JSON.parse(body) as OllamaRequest);
        this.open.add(response);
        response.on('close', () => {
          if (this.open.delete(response) && !response.writableFinished) this.clientGone += 1;
        });
        response.writeHead(200, { 'content-type': 'application/x-ndjson' });
        const line = (content: string, done = false) => response.write(`${JSON.stringify({ message: { content }, done })}\n`);
        if (this.hang) {
          line('Denke nach');
          return;
        }
        for (const chunk of this.chunks) line(chunk);
        line('', true);
        response.end();
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
  }

  async close(): Promise<void> {
    for (const response of this.open) response.destroy();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}
