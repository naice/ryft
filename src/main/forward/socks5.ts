import type { Socket } from 'node:net';

const MAX_GREETING_BYTES = 600;
const HANDSHAKE_TIMEOUT_MS = 10_000;

export class SocksError extends Error {
  /** The reply code to send before closing; null when nothing sensible can be answered. */
  constructor(
    message: string,
    readonly reply: number | null
  ) {
    super(message);
    this.name = 'SocksError';
  }
}

export interface SocksRequest {
  host: string;
  port: number;
  /** Bytes a client sent ahead of the reply. */
  rest: Buffer;
}

/** Parses as far as the buffer allows. Returns null when more bytes are needed. */
export function parseSocksGreeting(data: Buffer): { methods: number[]; consumed: number } | null {
  if (data.length < 2) return null;
  if (data[0] !== 5) throw new SocksError('Nur SOCKS5 wird unterstützt.', null);
  const count = data[1] as number;
  if (data.length < 2 + count) return null;
  return { methods: [...data.subarray(2, 2 + count)], consumed: 2 + count };
}

export function parseSocksConnect(data: Buffer): { host: string; port: number; consumed: number } | null {
  if (data.length < 4) return null;
  if (data[0] !== 5) throw new SocksError('Ungültige SOCKS-Anfrage.', 1);
  // Only CONNECT: BIND and UDP ASSOCIATE would open listeners nobody configured.
  if (data[1] !== 1) throw new SocksError('Nur CONNECT wird unterstützt.', 7);
  const addressType = data[3];
  let offset = 4;
  let host: string;
  if (addressType === 1) {
    if (data.length < offset + 6) return null;
    host = [...data.subarray(offset, offset + 4)].join('.');
    offset += 4;
  } else if (addressType === 3) {
    if (data.length < offset + 1) return null;
    const length = data[offset] as number;
    if (length === 0) throw new SocksError('Leerer Hostname.', 1);
    if (data.length < offset + 1 + length + 2) return null;
    host = data.subarray(offset + 1, offset + 1 + length).toString('utf8');
    offset += 1 + length;
  } else if (addressType === 4) {
    if (data.length < offset + 18) return null;
    const groups: string[] = [];
    for (let index = 0; index < 16; index += 2) groups.push(data.readUInt16BE(offset + index).toString(16));
    host = groups.join(':');
    offset += 16;
  } else {
    throw new SocksError('Unbekannter Adresstyp.', 8);
  }
  return { host, port: data.readUInt16BE(offset), consumed: offset + 2 };
}

export function writeSocksReply(socket: Socket, code: number): void {
  if (socket.destroyed) return;
  socket.write(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]));
}

/** Runs the handshake of a client connection, without authentication since the listener is local. */
export function readSocksRequest(socket: Socket): Promise<SocksRequest> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let greeted = false;
    const finish = (settle: () => void): void => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('close', onClose);
      settle();
    };
    const onClose = (): void => finish(() => reject(new SocksError('Verbindung vor dem Handshake geschlossen.', null)));
    const timer = setTimeout(
      () => finish(() => reject(new SocksError('Zeitüberschreitung im SOCKS-Handshake.', null))),
      HANDSHAKE_TIMEOUT_MS
    );
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        if (buffer.length > MAX_GREETING_BYTES) throw new SocksError('SOCKS-Anfrage zu groß.', null);
        if (!greeted) {
          const greeting = parseSocksGreeting(buffer);
          if (!greeting) return;
          if (!greeting.methods.includes(0)) {
            socket.write(Buffer.from([5, 0xff]));
            throw new SocksError('Der Client bietet keine Verbindung ohne Anmeldung an.', null);
          }
          greeted = true;
          buffer = buffer.subarray(greeting.consumed);
          socket.write(Buffer.from([5, 0]));
        }
        const request = parseSocksConnect(buffer);
        if (!request) return;
        // No more reading until the channel exists; the pipe takes over from there.
        socket.pause();
        finish(() => resolve({ host: request.host, port: request.port, rest: buffer.subarray(request.consumed) }));
      } catch (error) {
        finish(() => reject(error as Error));
      }
    };
    socket.on('data', onData);
    socket.on('close', onClose);
  });
}
