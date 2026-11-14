/**
 * HTTP security headers for preview and deployment. Kept in one place so the
 * preview server, the deployment `_headers` file, and the tests agree.
 *
 * - `wasm-unsafe-eval` is required to compile the MediaPipe WebAssembly module.
 *   The pinned loader uses neither `eval` nor `new Function` (checked in M0),
 *   so `unsafe-eval` is not granted.
 * - `worker-src 'self'`: the inference worker is a same-origin module script.
 * - `connect-src 'self'`: model/WASM fetches are same-origin; nothing else is.
 * - Camera is restricted to this origin; microphone is disabled.
 */
export const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self'",
  "connect-src 'self'",
  "img-src 'self' blob:",
  "media-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export const securityHeaders: Record<string, string> = {
  'Content-Security-Policy': contentSecurityPolicy,
  'Permissions-Policy':
    'camera=(self), microphone=(), geolocation=(), display-capture=(), payment=(), usb=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin',
};
