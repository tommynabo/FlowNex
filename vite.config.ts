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

              const separator = apifyPath.includes('?') ? '&' : '?';
              const url = `https://api.apify.com/v2/${apifyPath}${separator}token=${apifyToken}`;
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

/**
 * Dev-only plugin: intercepts POST /api/serper-proxy and calls google.serper.dev server-side.
 * Mirrors what api/serper-proxy.ts (Vercel serverless) does in production.
 * The Serper API key is read from .env (SERPER_API_KEY or SERPET_API_KEY typo) and never sent to the browser.
 */
function serperDevProxy(serperKey: string): Plugin {
  return {
    name: 'serper-dev-proxy',
    configureServer(server) {
      server.middlewares.use('/api/serper-proxy', (req: IncomingMessage, res: ServerResponse) => {
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
              const { keyword, num = 40 } = JSON.parse(rawBody || '{}') as { keyword?: string; num?: number };
              if (!keyword) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'keyword required' }));
                return;
              }
              if (!serperKey) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'SERPER_API_KEY / SERPET_API_KEY not set in .env' }));
                return;
              }

              const serperRes = await fetch('https://google.serper.dev/search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-API-KEY': serperKey },
                body: JSON.stringify({ q: keyword, num }),
              });
              const data = await serperRes.json() as {
                organic?: Array<{ link?: string; snippet?: string; title?: string }>;
              };

              // Mirror the output format of scraperlink~google-search-results-serp-scraper
              // so the parser in TikTokFacelessEngine (item.results[].url / .description) works unchanged
              const result = [{
                results: (data.organic ?? []).map(o => ({
                  url: o.link ?? '', link: o.link ?? '',
                  description: o.snippet ?? '', snippet: o.snippet ?? '',
                  title: o.title ?? '',
                })),
              }];
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(result));
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
  const serperKey  = env.SERPER_API_KEY || env.SERPET_API_KEY || '';

  return {
    server: {
      port: 3000,
      host: '0.0.0.0',
    },
    plugins: [
      react(),
      apifyDevProxy(apifyToken),
      serperDevProxy(serperKey),
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
