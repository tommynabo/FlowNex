import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'http';

/**
 * Dev-only plugin: intercepts POST /api/apify and proxies to Apify server-side.
 * Mirrors what api/apify.ts (Vercel serverless) does in production.
 * The Apify token is read from .env and never sent to the browser.
 */
function apifyDevProxy(apifyToken: string): Plugin {
  return {
    name: 'apify-dev-proxy',
    configureServer(server) {
      server.middlewares.use('/api/apify', (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        let rawBody = '';
        req.on('data', (chunk: Buffer) => { rawBody += chunk.toString(); });
        req.on('end', () => {
          (async () => {
            try {
              const { path: apifyPath, method = 'GET', body } = JSON.parse(rawBody || '{}');
              if (!apifyPath) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: '`path` required' }));
                return;
              }

              const url = `https://api.apify.com/v2/${apifyPath}?token=${apifyToken}`;
              const fetchOpts: RequestInit = {
                method,
                headers: { 'Content-Type': 'application/json' },
              };
              if (method === 'POST' && body !== undefined) {
                fetchOpts.body = JSON.stringify(body);
              }

              const apifyRes = await fetch(url, fetchOpts);
              const text = await apifyRes.text();
              res.writeHead(apifyRes.status, { 'Content-Type': 'application/json' });
              res.end(text);
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: msg }));
            }
          })();
        });
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const apifyToken = env.VITE_APIFY_API_TOKEN || '';

  return {
    server: {
      port: 3000,
      host: '0.0.0.0',
    },
    plugins: [
      react(),
      apifyDevProxy(apifyToken),
    ],
    define: {
      'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY)
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      }
    }
  };
});
