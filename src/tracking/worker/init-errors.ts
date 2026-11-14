/**
 * Classification of detector creation failures (pure; unit-tested).
 *
 * Only loader-specific signals count as a runtime load failure. MediaPipe
 * graph errors include C++ source paths such as ".../wasm/graph_utils.cc",
 * so a bare "wasm" substring must not be treated as a loading problem.
 */
import type { Delegate, InitErrorCode } from '../protocol';

const LOAD_FAILURE = /ModuleFactory not set|WebAssembly\.(?:instantiate|compile|Module)|dynamically imported module|Failed to fetch|\.wasm\b.*(?:404|failed)|CompileError|LinkError/i;
const MODEL_FAILURE = /NormalizationOptions|metadata|Input tensor|model file|flatbuffer|Invalid model|tflite/i;

export function classifyCreateError(message: string, delegate: Delegate): { code: InitErrorCode; message: string } {
  if (LOAD_FAILURE.test(message)) {
    return { code: 'wasm-load', message: `Tracking runtime failed to load: ${message}` };
  }
  if (MODEL_FAILURE.test(message)) {
    return { code: 'model-integrity', message: `The hand-tracking model could not be used: ${message}` };
  }
  if (delegate === 'GPU') {
    return { code: 'delegate', message: `GPU tracking backend failed to start: ${message}` };
  }
  return { code: 'unknown', message: `Tracking failed to start: ${message}` };
}
