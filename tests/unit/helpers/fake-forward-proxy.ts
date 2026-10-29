// halo: egress-proxy-ssrf — test helper, fork-only.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';

/** What the proxy answers. `tunnelTo` (CONNECT only) splices the client onto that local port. */
export interface ProxyAnswer {
  status: number;
  headers?: Record<string, string>;
  body?: string;
  tunnelTo?: number;
}

export interface ProxyHit {
  method: string;
  /** Absolute-form URL for a forwarded request, `host:port` for CONNECT. */
  target: string;
  proxyAuthorization?: string;
}

/**
 * A minimal forward proxy in the shape squid presents to wigolo: absolute-form requests for http://
 * targets, CONNECT for https:// ones. It never contacts the requested target; `answer` decides the
 * response (default 200 "via-proxy", and CONNECT refused with 403 unless a `tunnelTo` is given).
 */
export class FakeForwardProxy {
  readonly hits: ProxyHit[] = [];
  answer: (hit: ProxyHit) => ProxyAnswer = (hit) =>
    hit.method === 'CONNECT' ? { status: 403 } : { status: 200, body: 'via-proxy' };
  private server: Server;
  private sockets = new Set<Socket>();
  /** TCP connections accepted from clients since start (or since a test zeroed it). */
  connections = 0;
  port = 0;

  constructor() {
    this.server = createServer((req, res) => {
      const hit = this.record(req);
      const a = this.answer(hit);
      res.writeHead(a.status, { 'content-type': 'text/html', ...a.headers });
      res.end(a.body ?? '');
    });
    this.server.on('connection', (s: Socket) => {
      this.connections++;
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    this.server.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => {
      const hit = this.record(req);
      const a = this.answer(hit);
      if (a.status !== 200 || a.tunnelTo === undefined) {
        const extra = Object.entries(a.headers ?? {}).map(([k, v]) => `${k}: ${v}\r\n`).join('');
        client.end(`HTTP/1.1 ${a.status} Refused\r\n${extra}Content-Length: 0\r\nConnection: close\r\n\r\n`);
        return;
      }
      const upstream = netConnect(a.tunnelTo, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      this.sockets.add(upstream);
      upstream.on('close', () => this.sockets.delete(upstream));
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
    });
  }

  private record(req: IncomingMessage): ProxyHit {
    const auth = req.headers['proxy-authorization'];
    const hit: ProxyHit = {
      method: req.method ?? '',
      target: req.url ?? '',
      ...(typeof auth === 'string' ? { proxyAuthorization: auth } : {}),
    };
    this.hits.push(hit);
    return hit;
  }

  async start(): Promise<this> {
    await new Promise<void>((res) => this.server.listen(0, '127.0.0.1', () => res()));
    this.port = (this.server.address() as { port: number }).port;
    return this;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((res) => this.server.close(() => res()));
  }
}
