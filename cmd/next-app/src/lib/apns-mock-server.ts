import http2 from 'node:http2';
import type net from 'node:net';

// Test-only cleartext HTTP/2 stand-in for APNs; production origins stay hard-coded to Apple.
export type ApnsResponder = (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders, body: string) => void;
export interface ApnsReceived { headers: http2.IncomingHttpHeaders; body: string }

export async function startMockApns(respond: ApnsResponder) {
  const received: ApnsReceived[] = [];
  const server = http2.createServer();
  const sessions = new Set<http2.ServerHttp2Session>();
  server.on('session', s => { sessions.add(s); s.on('close', () => sessions.delete(s)); });
  server.on('stream', (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
    let body = '';
    stream.on('data', chunk => { body += chunk; });
    stream.on('end', () => { received.push({ headers, body }); respond(stream, headers, body); });
    stream.on('error', () => undefined);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  return {
    origin, received, sessions,
    close: () => new Promise<void>(resolve => { for (const s of sessions) s.destroy(); server.close(() => resolve()); }),
  };
}

export const apnsReply = (status: number, body?: object): ApnsResponder => stream => {
  if (stream.destroyed) return;
  stream.respond({ ':status': status, 'apns-id': 'eabeae54-14a8-11e5-b60b-1697f925ec7b' });
  stream.end(body ? JSON.stringify(body) : undefined);
};
