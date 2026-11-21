// The reliability layer's DETERMINISTIC parsers, imported for their side-effect
// registration; the shell's parsers.manifest.ts imports this file, and the
// determinism test iterates the registry the manifests fill.
// Status pages (capacity strain)
import './parsers/status/openai-status'
import './parsers/status/anthropic-status'
import './parsers/status/google-cloud-status'
import './parsers/status/mistral-status'
import './parsers/status/xai-status'
import './parsers/status/deepseek-status'
// OpenRouter model catalog (the probes' target list; cross-check only)
import './parsers/openrouter'
