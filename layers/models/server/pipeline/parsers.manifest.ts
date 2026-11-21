// The models layer's DETERMINISTIC parsers, imported for their side-effect
// registration; the shell's parsers.manifest.ts imports this file, and the
// determinism test iterates the registry the manifests fill.
// Misalignment disclosures
import './parsers/disclosures/openai-misalignment-reports'
import './parsers/disclosures/openai-misalignment-report'
