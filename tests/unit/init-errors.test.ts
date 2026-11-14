import { describe, expect, it } from 'vitest';
import { classifyCreateError } from '../../src/tracking/worker/init-errors';

describe('detector creation error classification', () => {
  it('treats loader failures as runtime load errors', () => {
    expect(classifyCreateError('ModuleFactory not set.', 'GPU').code).toBe('wasm-load');
    expect(classifyCreateError('Failed to fetch dynamically imported module: https://x/vision.js', 'CPU').code).toBe('wasm-load');
    expect(classifyCreateError('CompileError: WebAssembly.instantiate(): expected magic word', 'CPU').code).toBe('wasm-load');
  });

  it('does not mistake graph errors with wasm source paths for load failures', () => {
    const graph =
      'NOT_FOUND: Input tensor has type float32: it requires specifying NormalizationOptions metadata; StartGraph failed research/drishti/app/pursuit/wasm/graph_utils.cc:95';
    expect(classifyCreateError(graph, 'CPU').code).toBe('model-integrity');
  });

  it('attributes other GPU failures to the delegate so CPU can be tried', () => {
    expect(classifyCreateError('Unable to initialize EGL context', 'GPU').code).toBe('delegate');
    expect(classifyCreateError('Something odd', 'CPU').code).toBe('unknown');
  });
});
