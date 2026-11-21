// Central parser manifest. Every DETERMINISTIC parser module is imported
// here (side-effect registration) — the determinism test iterates exactly
// this registry. The judge lane never registers; it goes through the
// agent-output gate instead.
// Hiring (the talent layer's own manifest)
import '#layers/talent/server/pipeline/parsers.manifest'
// Vendor-md pricing/catalog (the pricing layer's own manifest)
import '#layers/pricing/server/pipeline/parsers.manifest'
// EDGAR (the companies layer's own manifest)
import '#layers/companies/server/pipeline/parsers.manifest'
// Status pages and the OpenRouter model catalog (the reliability layer's own manifest)
import '#layers/reliability/server/pipeline/parsers.manifest'
// Misalignment disclosures (the models layer's own manifest)
import '#layers/models/server/pipeline/parsers.manifest'
// OpenRouter usage rankings (the adoption layer's own manifest)
import '#layers/adoption/server/pipeline/parsers.manifest'
