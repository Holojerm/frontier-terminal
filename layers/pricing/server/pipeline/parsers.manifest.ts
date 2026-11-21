// The pricing layer's DETERMINISTIC parsers, imported for their side-effect
// registration; the shell's parsers.manifest.ts imports this file, and the
// determinism test iterates the registry the two fill.
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
import './parsers/pricing/deepseek-pricing'
import './parsers/pricing/alibaba-pricing'
import './parsers/pricing/moonshot-models'
