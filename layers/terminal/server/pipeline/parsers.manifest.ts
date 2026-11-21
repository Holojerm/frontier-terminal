// Central parser manifest. Every DETERMINISTIC parser module is imported
// here (side-effect registration) — the determinism test iterates exactly
// this registry. The judge lane never registers; it goes through the
// agent-output gate instead.
// Hiring (the talent layer's own manifest)
import '#layers/talent/server/pipeline/parsers.manifest'
// Vendor-md pricing/catalog (the pricing layer's own manifest) + EDGAR
import '#layers/pricing/server/pipeline/parsers.manifest'
import './parsers/sec/edgar-fts'
import './parsers/sec/edgar-submissions'
import './parsers/sec/edgar-companyfacts'
import './parsers/sec/xbrl-segment'
import './parsers/sec/filing-index'
import './parsers/sec/prospectus-revenue'
import './parsers/sec/prospectus'
// Status pages and the OpenRouter model catalog (the reliability layer's own manifest)
import '#layers/reliability/server/pipeline/parsers.manifest'
// Misalignment disclosures (the models layer's own manifest)
import '#layers/models/server/pipeline/parsers.manifest'
// OpenRouter usage rankings (the adoption layer's own manifest)
import '#layers/adoption/server/pipeline/parsers.manifest'
