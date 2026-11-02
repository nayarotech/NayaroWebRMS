import { resolve } from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Production Content-Security-Policy, injected at build time so it can name
 * the deployment's API origin. Scripts load only from this origin, so an
 * injected <script> cannot run and read the session token from localStorage.
 * Development skips it because Vite's hot reload relies on inline scripts.
 * Hosting should also send this policy as an HTTP header.
 */
function contentSecurityPolicy(apiUrl: string): Plugin {
  const api = new URL(apiUrl);
  const socket = `${api.protocol === 'https:' ? 'wss:' : 'ws:'}//${api.host}`;
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${api.origin} ${socket}`,
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
  return {
    name: 'nayaro-csp',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace(
        '<meta charset="UTF-8" />',
        `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`,
      ),
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, resolve(__dirname, '../..'), 'VITE_');
  const apiUrl = env['VITE_API_URL'] ?? process.env['VITE_API_URL'] ?? 'http://localhost:4000';
  return {
    envDir: resolve(__dirname, '../..'),
    plugins: [react(), tailwindcss(), contentSecurityPolicy(apiUrl)],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
        '@nayaro/shared': resolve(__dirname, '../../packages/shared/src'),
      },
    },
    server: { port: 5180, strictPort: true },
    preview: { port: 5180 },
  };
});
