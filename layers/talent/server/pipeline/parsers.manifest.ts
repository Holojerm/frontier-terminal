// The talent layer's DETERMINISTIC parsers, imported for their side-effect
// registration; the shell's parsers.manifest.ts imports this file, and the
// determinism test iterates the registry the manifests fill.
import './parsers/hiring/openai-ashby'
import './parsers/hiring/anthropic-greenhouse'
import './parsers/hiring/xai-greenhouse'
import './parsers/hiring/mistral-ashby'
import './parsers/hiring/google-careers'
