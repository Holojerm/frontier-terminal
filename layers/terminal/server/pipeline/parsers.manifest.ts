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
// Vendor-md pricing/catalog + EDGAR
import './parsers/pricing/openai-models'
import './parsers/pricing/openai-pricing'
import './parsers/pricing/openai-model-page'
import './parsers/pricing/anthropic-pricing'
import './parsers/pricing/anthropic-models-overview'
import './parsers/pricing/xai-models'
import './parsers/pricing/google-pricing'
import './parsers/pricing/google-model-page'
import './parsers/pricing/meta-models'
import './parsers/pricing/meta-pricing'
import './parsers/pricing/mistral-models'
import './parsers/pricing/mistral-pricing'
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
// Misalignment disclosures
import './parsers/disclosures/openai-misalignment-reports'
import './parsers/disclosures/openai-misalignment-report'
// OpenRouter drift check (cross-check only)
import './parsers/openrouter'
// OpenRouter usage rankings (demand share)
import './parsers/openrouter-rankings'
