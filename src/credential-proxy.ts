/**
 * Credential proxy for worker isolation.
 *
 * Workers connect here (via ANTHROPIC_BASE_URL pointing to this proxy)
 * instead of calling api.anthropic.com directly. The proxy strips whatever
 * x-api-key the worker sends and injects the real API key from the host env.
 * Workers only ever see a dummy/session token — never the real key.
 *
 * Adapted from NanoClaw's credential-proxy.ts.
 */
import { createServer, type Server } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest, type RequestOptions } from 'node:http';
import type { Logger } from 'pino';

export function startCredentialProxy(
  logger: Logger,
  host = '127.0.0.1',
  port = 0,  // 0 = OS-assigned ephemeral port
): Promise<{ server: Server; port: number }> {
  const UPSTREAM_URL = new URL(
    process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',
  );
  const IS_HTTPS = UPSTREAM_URL.protocol === 'https:';
  const makeRequest = IS_HTTPS ? httpsRequest : httpRequest;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY must be set in the host environment for the credential proxy.',
    );
  }

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: UPSTREAM_URL.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers
        for (const h of ['connection', 'keep-alive', 'transfer-encoding']) {
          delete headers[h];
        }

        // Replace whatever key the worker sent with the real key
        delete headers['x-api-key'];
        headers['x-api-key'] = apiKey;

        const upstream = makeRequest(
          {
            hostname: UPSTREAM_URL.hostname,
            port: UPSTREAM_URL.port || (IS_HTTPS ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.on('error', (err: Error) => {
          logger.error({ err, url: req.url }, 'credential-proxy upstream error');
          if (!res.headersSent) res.writeHead(502);
          res.end('Bad Gateway');
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.on('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const assignedPort = typeof addr === 'object' && addr ? addr.port : port;
      logger.info({ host, port: assignedPort }, 'credential-proxy started');
      resolve({ server, port: assignedPort });
    });
  });
}
