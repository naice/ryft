import { connect, type Socket } from 'node:net';
import type { ProxyConfig } from '@shared/contracts';
import { SessionFailure } from '../sessions/types';

const MAX_REPLY_BYTES = 16 * 1024;

/** Reads from a socket until `complete` says how much of the buffer belongs to the handshake. */
function readHandshake(socket: Socket, complete: (data: Buffer) => number | null): Promise<void> {
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0);
    const finish = (error?: Error): void => {
      socket.off('data', onData);
      socket.off('error', onFailure);
      socket.off('close', onClose);
      if (error) reject(error);
      else resolve();
    };
    const onData = (chunk: Buffer): void => {
      received = Buffer.concat([received, chunk]);
      try {
        const used = complete(received);
        if (used !== null) {
          socket.pause();
          // Whatever follows the handshake already belongs to the tunnelled protocol.
          if (used < received.length) socket.unshift(received.subarray(used));
          finish();
        } else if (received.length > MAX_REPLY_BYTES) {
          finish(new Error('Antwort des Proxys ist zu lang.'));
        }
      } catch (error) {
        finish(error as Error);
      }
    };
    const onFailure = (error: Error): void => finish(error);
    const onClose = (): void => finish(new Error('Der Proxy hat die Verbindung beendet.'));
    socket.on('data', onData);
    socket.once('error', onFailure);
    socket.once('close', onClose);
  });
}

async function socks5Connect(socket: Socket, host: string, port: number): Promise<void> {
  const name = Buffer.from(host);
  if (name.length > 255) throw new Error('Hostname ist für SOCKS5 zu lang.');
  socket.write(Buffer.from([5, 1, 0]));
  await readHandshake(socket, (data) => {
    if (data.length < 2) return null;
    if (data[0] !== 5 || data[1] !== 0) throw new Error('Der SOCKS5-Proxy verlangt eine Anmeldung.');
    return 2;
  });
  socket.resume();
  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(port);
  socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, portBytes]));
  await readHandshake(socket, (data) => {
    if (data.length < 5) return null;
    if (data[1] !== 0) throw new Error(`Der SOCKS5-Proxy lehnt das Ziel ab (Code ${data[1]}).`);
    const addressLength = data[3] === 1 ? 4 : data[3] === 4 ? 16 : data[3] === 3 ? 1 + (data[4] as number) : -1;
    if (addressLength < 0) throw new Error('Ungültige Antwort des SOCKS5-Proxys.');
    const total = 4 + addressLength + 2;
    return data.length >= total ? total : null;
  });
}

async function httpConnect(socket: Socket, host: string, port: number): Promise<void> {
  const authority = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  await readHandshake(socket, (data) => {
    const end = data.indexOf('\r\n\r\n');
    if (end === -1) return null;
    const status = /^HTTP\/1\.[01] (\d{3})/.exec(data.subarray(0, end).toString('latin1'));
    if (status?.[1] !== '200') throw new Error(`Der HTTP-Proxy lehnt das Ziel ab (${status?.[1] ?? 'ungültig'}).`);
    return end + 4;
  });
}

/** Opens a socket to `host:port` through a proxy. Proxy authentication is not supported. */
export function openProxySocket(
  proxy: Exclude<ProxyConfig, { type: 'none' }>,
  host: string,
  port: number,
  signal: AbortSignal
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: proxy.host, port: proxy.port });
    const fail = (error: Error): void => {
      signal.removeEventListener('abort', onAbort);
      socket.destroy();
      reject(new SessionFailure('CONNECTION_REFUSED', `Proxy ${proxy.host}:${proxy.port}: ${error.message}`));
    };
    const onAbort = (): void => fail(new Error('Verbindungsaufbau abgebrochen.'));
    signal.addEventListener('abort', onAbort, { once: true });
    socket.once('error', fail);
    socket.once('connect', () => {
      socket.off('error', fail);
      const handshake = proxy.type === 'socks5' ? socks5Connect(socket, host, port) : httpConnect(socket, host, port);
      handshake.then(() => {
        signal.removeEventListener('abort', onAbort);
        resolve(socket);
      }, fail);
    });
  });
}
