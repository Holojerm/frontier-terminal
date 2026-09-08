// Central parser manifest. Every DETERMINISTIC parser module is imported
// here (side-effect registration) — the determinism test iterates exactly
// this registry. The judge lane never registers; it goes through the
// agent-output gate instead.
// Hiring
import './parsers/hiring/openai-ashby'
import './parsers/hiring/anthropic-greenhouse'
import './parsers/hiring/xai-greenhouse'
// Vendor-md pricing/catalog + EDGAR
import './parsers/pricing/openai-models'
import './parsers/pricing/anthropic-pricing'
import './parsers/pricing/anthropic-models-overview'
import './parsers/pricing/xai-models'
import './parsers/pricing/google-pricing'
import './parsers/sec/edgar-fts'
import './parsers/sec/edgar-submissions'
// Status pages (capacity strain)
import './parsers/status/openai-status'
import './parsers/status/anthropic-status'
import './parsers/status/google-cloud-status'
// OpenRouter drift check (cross-check only)
import './parsers/openrouter'
