import { defineConfig } from 'vite';
import { securityHeaders } from './scripts/security-headers.ts';

// Relative base so the production build works under any subpath
// (e.g. https://example.org/teaching/air-whiteboard/). Runtime asset URLs are
// resolved against document.baseURI on the main thread and handed to the
// worker as absolute URLs, because worker-relative URLs would resolve against
// the hashed worker chunk location instead.
export default defineConfig(({ mode }) => {
  const devtools = mode !== 'production';
  return {
    base: './',
    define: {
      // Compile-time constant: production builds statically drop every
      // developer-only branch (HUD, recording, replay) and its dynamic import.
      __DEVTOOLS__: JSON.stringify(devtools),
    },
    build: {
      target: 'es2022',
      sourcemap: false,
      assetsInlineLimit: 0,
      reportCompressedSize: true,
    },
    worker: {
      format: 'es',
    },
    server: {
      headers: {
        // CSP is not applied in dev because Vite's dev client injects styles.
        'Permissions-Policy': securityHeaders['Permissions-Policy'],
      },
    },
    preview: {
      headers: securityHeaders,
    },
  };
});
