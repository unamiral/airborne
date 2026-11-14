#!/usr/bin/env node
// Writes dist/_headers (Netlify / Cloudflare Pages format) from the same
// header definitions the preview server uses (scripts/security-headers.ts).
// Node strips the TypeScript types of that file when importing it.
import { writeFileSync } from 'node:fs';
import { securityHeaders } from './security-headers.ts';

const dist = process.argv[2] ?? 'dist';
const lines = ['/*'];
for (const [name, value] of Object.entries(securityHeaders)) lines.push(`  ${name}: ${value}`);
lines.push(
  '',
  '/index.html',
  '  Cache-Control: no-cache',
  '',
  '# Hashed chunks and versioned ML assets never change at a given URL.',
  '/assets/*',
  '  Cache-Control: public, max-age=31536000, immutable',
  '',
  '/assets/mediapipe/*',
  '  Cross-Origin-Resource-Policy: same-origin',
  '',
  '/*.wasm',
  '  Content-Type: application/wasm',
  '',
);
writeFileSync(`${dist}/_headers`, `${lines.join('\n')}\n`);
console.log(`deploy-headers: wrote ${dist}/_headers`);
