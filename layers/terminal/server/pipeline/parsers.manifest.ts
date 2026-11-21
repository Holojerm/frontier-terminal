// Central parser manifest. Every DETERMINISTIC parser module is imported
// here (side-effect registration) — the determinism test iterates exactly
// this registry. The judge lane never registers; it goes through the
// agent-output gate instead.
// Hiring
import './parsers/hiring/openai-ashby'
import './parsers/hiring/anthropic-greenhouse'
import './parsers/hiring/xai-greenhouse'
import './parsers/hiring/mistral-ashby'
import './parsers/hiring/google-careers'
// Vendor-md pricing/catalog (the pricing layer's own manifest) + EDGAR
import '#layers/pricing/server/pipeline/parsers.manifest'
import './parsers/sec/edgar-fts'
import './parsers/sec/edgar-submissions'
import './parsers/sec/edgar-companyfacts'
import './parsers/sec/xbrl-segment'
import './parsers/sec/filing-index'
import './parsers/sec/prospectus-revenue'
import './parsers/sec/prospectus'
// Status pages (capacity strain)
import './parsers/status/openai-status'
import './parsers/status/anthropic-status'
import './parsers/status/google-cloud-status'
import './parsers/status/mistral-status'
import './parsers/status/xai-status'
import './parsers/status/deepseek-status'
// Misalignment disclosures
import './parsers/disclosures/openai-misalignment-reports'
import './parsers/disclosures/openai-misalignment-report'
// OpenRouter drift check (cross-check only)
import './parsers/openrouter'
// OpenRouter usage rankings (demand share)
import './parsers/openrouter-rankings'
