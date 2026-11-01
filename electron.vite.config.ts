import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import type { Plugin } from 'vite';

const shared = resolve(__dirname, 'src/shared');

/**
 * The packaged renderer gets a strict CSP. The dev server needs HMR, so its
 * policy additionally allows the Vite websocket and React refresh preamble.
 * `style-src 'unsafe-inline'` is required by xterm.js and Radix positioning.
 */
function cspPlugin(): Plugin {
  const base = [
    "default-src 'none'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'"
  ];
  return {
    name: 'ryft-csp',
    transformIndexHtml(html, ctx) {
      const policy = ctx.server
        ? [...base, "script-src 'self' 'unsafe-inline'", "connect-src 'self' ws://localhost:* http://localhost:*"]
        : [...base, "script-src 'self'", "connect-src 'self'"];
      return html.replace('__RYFT_CSP__', policy.join('; '));
    }
  };
}

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': shared } },
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } } }
  },
  preload: {
    resolve: { alias: { '@shared': shared } },
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } } }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias: { '@shared': shared, '@renderer': resolve(__dirname, 'src/renderer/src') } },
    plugins: [react(), tailwindcss(), cspPlugin()],
    // Inlined assets would become data: fonts, which the CSP blocks on purpose.
    build: { assetsInlineLimit: 0, rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } } }
  }
});
