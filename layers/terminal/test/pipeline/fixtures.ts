// Committed fixtures, loaded through Vite `?raw` imports so they are readable
// inside workerd, where there is no filesystem. Keyed by repo-relative path —
// the same strings parsers register as fixturePath / sideFixturePaths — so the
// determinism harness resolves a registration straight to its bytes.

import manifestJson from '~~/fixtures/manifest.json'
import openaiMisalignmentReportDns from '~~/fixtures/disclosures/openai-misalignment-report-an-agent-used-dns-to-reach-an-external-chatbot.html?raw'
import openaiMisalignmentReportSelfReplicating from '~~/fixtures/disclosures/openai-misalignment-report-self-replicating-prompt-injections-exist.html?raw'
import openaiMisalignmentReportUploading from '~~/fixtures/disclosures/openai-misalignment-report-uploading-files-to-the-internet-in-order-to-cite-them.html?raw'
import openaiMisalignmentReports from '~~/fixtures/disclosures/openai-misalignment-reports.html?raw'
import anthropicGreenhouseDepartments from '~~/fixtures/hiring/anthropic-greenhouse-departments.json?raw'
import anthropicGreenhouse from '~~/fixtures/hiring/anthropic-greenhouse.json?raw'
import googleCareers from '~~/fixtures/hiring/google-careers.xml?raw'
import mistralAshby from '~~/fixtures/hiring/mistral-ashby.json?raw'
import openaiAshby from '~~/fixtures/hiring/openai-ashby.json?raw'
import xaiGreenhouseDepartments from '~~/fixtures/hiring/xai-greenhouse-departments.json?raw'
import xaiGreenhouse from '~~/fixtures/hiring/xai-greenhouse.json?raw'
import anthropicModelsOverview from '~~/fixtures/pricing/anthropic-models-overview.md?raw'
import anthropicPricing from '~~/fixtures/pricing/anthropic-pricing.md?raw'
import googleModelPage from '~~/fixtures/pricing/google-model-gemini-4-argon.md?raw'
import googleModels from '~~/fixtures/pricing/google-models.md?raw'
import googlePricing from '~~/fixtures/pricing/google-pricing.md?raw'
import metaModels from '~~/fixtures/pricing/meta-models.md?raw'
import metaPricing from '~~/fixtures/pricing/meta-pricing.md?raw'
import mistralModels from '~~/fixtures/pricing/mistral-models.md?raw'
import alibabaModels from '~~/fixtures/pricing/alibaba-models.html?raw'
import alibabaPricing from '~~/fixtures/pricing/alibaba-pricing.html?raw'
import deepseekPricing from '~~/fixtures/pricing/deepseek-pricing.md?raw'
import moonshotModels from '~~/fixtures/pricing/moonshot-models.md?raw'
import mistralPricing from '~~/fixtures/pricing/mistral-pricing.md?raw'
import openaiModels from '~~/fixtures/pricing/openai-models.md?raw'
import openaiModelPage from '~~/fixtures/pricing/openai-model-gpt-5.6-sol.md?raw'
import openaiPricing from '~~/fixtures/pricing/openai-pricing.md?raw'
import openrouterModels from '~~/fixtures/pricing/openrouter-models.json?raw'
import openrouterRankings from '~~/fixtures/rankings/openrouter-rankings-daily.json?raw'
import gpuAzure from '~~/fixtures/recipes/gpu-azure.json?raw'
import gpuCoreweave from '~~/fixtures/recipes/gpu-coreweave.html?raw'
import gpuCrusoe from '~~/fixtures/recipes/gpu-crusoe.html?raw'
import gpuDigitalocean from '~~/fixtures/recipes/gpu-digitalocean.html?raw'
import gpuLambda from '~~/fixtures/recipes/gpu-lambda.html?raw'
import gpuNebius from '~~/fixtures/recipes/gpu-nebius.html?raw'
import gpuOracle from '~~/fixtures/recipes/gpu-oracle.json?raw'
import gpuTogether from '~~/fixtures/recipes/gpu-together.html?raw'
import gpuVerda from '~~/fixtures/recipes/gpu-verda.html?raw'
import rampAiIndex from '~~/fixtures/recipes/ramp-ai-index.html?raw'
import limitsAnthropic from '~~/fixtures/recipes/limits-anthropic.md?raw'
import limitsMeta from '~~/fixtures/recipes/limits-meta.md?raw'
import limitsOpenaiAstra from '~~/fixtures/recipes/limits-openai-gpt-6-astra.md?raw'
import limitsXai from '~~/fixtures/recipes/limits-xai.md?raw'
import payAnthropic from '~~/fixtures/recipes/pay-anthropic.json?raw'
import payOpenai from '~~/fixtures/recipes/pay-openai.json?raw'
import secAmznAnthropic from '~~/fixtures/recipes/sec-amzn-anthropic.xml?raw'
import filedFactsAmznCompanyfacts from '~~/fixtures/filed-facts/companyfacts-amzn.json?raw'
import filedFactsMsftCompanyfacts from '~~/fixtures/filed-facts/companyfacts-msft.json?raw'
import filedFactsAmznInstance from '~~/fixtures/filed-facts/amzn-20260930.xml?raw'
import filedFactsGooglInstance from '~~/fixtures/filed-facts/goog-20260930.xml?raw'
import filedFactsMsftInstance from '~~/fixtures/filed-facts/msft-20260930.xml?raw'
import secMsftOpenai from '~~/fixtures/recipes/sec-msft-openai.xml?raw'
import epochDataCenters from '~~/fixtures/recipes/epoch-data-centers.csv?raw'
import epochTimelines from '~~/fixtures/recipes/epoch-data-center-timelines.csv?raw'
import githubPrsCopilot from '~~/fixtures/recipes/github-prs-copilot.json?raw'
import npmClaudeCode from '~~/fixtures/recipes/npm-claude-code.json?raw'
import pypiAnthropic from '~~/fixtures/recipes/pypi-anthropic.json?raw'
import secCompanyfactsCrwv from '~~/fixtures/recipes/sec-companyfacts-crwv.json?raw'
import xaiModels from '~~/fixtures/pricing/xai-models.md?raw'
import edgarCompanyfactsSpcx from '~~/fixtures/sec/edgar-companyfacts-spcx.json?raw'
import xbrlSegmentGoogl from '~~/fixtures/sec/xbrl-segment-googl-2026-10-29.xml?raw'
import filingIndexAnthropic from '~~/fixtures/sec/filing-index-anthropic-s-1.html?raw'
import prospectusAnthropic from '~~/fixtures/sec/prospectus-anthropic-s-1.html?raw'
import prospectusAnthropicAmended from '~~/fixtures/sec/prospectus-anthropic-s-1-a.html?raw'
import edgarFtsOpenai from '~~/fixtures/sec/edgar-fts-openai.json?raw'
import edgarFts from '~~/fixtures/sec/edgar-fts.json?raw'
import edgarSubmissionsAmzn from '~~/fixtures/sec/edgar-submissions-amzn.json?raw'
import edgarSubmissionsGoogl from '~~/fixtures/sec/edgar-submissions-googl.json?raw'
import edgarSubmissionsMeta from '~~/fixtures/sec/edgar-submissions-meta.json?raw'
import edgarSubmissionsOrcl from '~~/fixtures/sec/edgar-submissions-orcl.json?raw'
import edgarSubmissionsBaba from '~~/fixtures/sec/edgar-submissions-baba.json?raw'
import edgarSubmissionsMsft from '~~/fixtures/sec/edgar-submissions-msft.json?raw'
import edgarSubmissionsNvda from '~~/fixtures/sec/edgar-submissions-nvda.json?raw'
import edgarSubmissionsSpcx from '~~/fixtures/sec/edgar-submissions-spcx.json?raw'
import anthropicStatus from '~~/fixtures/status/anthropic-status.xml?raw'
import googleCloudStatus from '~~/fixtures/status/google-cloud-status.json?raw'
import mistralStatus from '~~/fixtures/status/mistral-status.json?raw'
import deepseekStatus from '~~/fixtures/status/deepseek-status.xml?raw'
import deepseekStatusAtom from '~~/fixtures/status/deepseek-status-atom.xml?raw'
import xaiStatus from '~~/fixtures/status/xai-status.xml?raw'
import openaiStatus from '~~/fixtures/status/openai-status.json?raw'
import waybackAnthropicModels2024 from '~~/fixtures/pricing/wayback/anthropic-models-2024-06.html?raw'
import waybackAnthropicPricing2025 from '~~/fixtures/pricing/wayback/anthropic-pricing-2025-06.html?raw'
import waybackOpenaiApiPricing2024 from '~~/fixtures/pricing/wayback/openai-api-pricing-2024-12.html?raw'
import waybackOpenaiDocsPricing2026 from '~~/fixtures/pricing/wayback/openai-docs-pricing-2026-03.html?raw'
import waybackOpenaiPricing2023 from '~~/fixtures/pricing/wayback/openai-pricing-2023-07.html?raw'
import waybackOpenaiPricing2024 from '~~/fixtures/pricing/wayback/openai-pricing-2024-04.html?raw'
import waybackOpenaiPricingMd2026 from '~~/fixtures/pricing/wayback/openai-pricing-2026-07.md?raw'
import waybackOpenaiApiPricing2025 from '~~/fixtures/pricing/wayback/openai-api-pricing-2025-01.html?raw'
import waybackOpenaiDocsPricing2026b from '~~/fixtures/pricing/wayback/openai-docs-pricing-2026-03b.html?raw'
import waybackOpenaiDocsPricing202607 from '~~/fixtures/pricing/wayback/openai-docs-pricing-2026-07.html?raw'
import waybackGooglePricing202406 from '~~/fixtures/pricing/wayback/google-pricing-2024-06.html?raw'
import waybackGooglePricing202408 from '~~/fixtures/pricing/wayback/google-pricing-2024-08.html?raw'
import waybackGooglePricing202501 from '~~/fixtures/pricing/wayback/google-pricing-2025-01.html?raw'
import waybackGoogleDocsPricing202506 from '~~/fixtures/pricing/wayback/google-docs-pricing-2025-06.html?raw'
import waybackGoogleDocsPricing202509 from '~~/fixtures/pricing/wayback/google-docs-pricing-2025-09.html?raw'
import waybackXaiApi202503 from '~~/fixtures/pricing/wayback/xai-api-2025-03.html?raw'
import waybackXaiDocsModels202512 from '~~/fixtures/pricing/wayback/xai-docs-models-2025-12.html?raw'
import waybackXaiModels202603 from '~~/fixtures/pricing/wayback/xai-models-2026-03.md?raw'
import waybackXaiModels202606 from '~~/fixtures/pricing/wayback/xai-models-2026-06.md?raw'
import waybackMistralDocsPricing202404 from '~~/fixtures/pricing/wayback/mistral-docs-pricing-2024-04.html?raw'
import waybackMistralTechnology202406 from '~~/fixtures/pricing/wayback/mistral-technology-2024-06.html?raw'
import waybackMistralTechnology202502 from '~~/fixtures/pricing/wayback/mistral-technology-2025-02.html?raw'
import waybackDeepseekPlatform202405 from '~~/fixtures/pricing/wayback/deepseek-platform-pricing-2024-05.html?raw'
import waybackDeepseekPricing202412 from '~~/fixtures/pricing/wayback/deepseek-pricing-2024-12.html?raw'
import waybackDeepseekPricing202503 from '~~/fixtures/pricing/wayback/deepseek-pricing-2025-03.html?raw'
import waybackDeepseekPricing202512 from '~~/fixtures/pricing/wayback/deepseek-pricing-2025-12.html?raw'
import waybackDeepseekPricing202605 from '~~/fixtures/pricing/wayback/deepseek-pricing-2026-05.html?raw'
import waybackDeepseekPricing202608 from '~~/fixtures/pricing/wayback/deepseek-pricing-2026-08.html?raw'
import waybackAlibabaPricing202601 from '~~/fixtures/pricing/wayback/alibaba-model-pricing-2026-01.html?raw'
import waybackAlibabaPricing202608 from '~~/fixtures/pricing/wayback/alibaba-model-pricing-2026-08.html?raw'
import sourcesYaml from '~~/sources.yaml?raw'

import { fixtureProvenance } from '../../server/pipeline/parsers/fixture-provenance'

export const manifest = manifestJson

const files: Readonly<Record<string, string>> = {
  'fixtures/disclosures/openai-misalignment-report-an-agent-used-dns-to-reach-an-external-chatbot.html':
    openaiMisalignmentReportDns,
  'fixtures/disclosures/openai-misalignment-report-self-replicating-prompt-injections-exist.html':
    openaiMisalignmentReportSelfReplicating,
  'fixtures/disclosures/openai-misalignment-report-uploading-files-to-the-internet-in-order-to-cite-them.html':
    openaiMisalignmentReportUploading,
  'fixtures/disclosures/openai-misalignment-reports.html': openaiMisalignmentReports,
  'fixtures/hiring/anthropic-greenhouse-departments.json': anthropicGreenhouseDepartments,
  'fixtures/hiring/anthropic-greenhouse.json': anthropicGreenhouse,
  'fixtures/hiring/google-careers.xml': googleCareers,
  'fixtures/hiring/mistral-ashby.json': mistralAshby,
  'fixtures/hiring/openai-ashby.json': openaiAshby,
  'fixtures/hiring/xai-greenhouse-departments.json': xaiGreenhouseDepartments,
  'fixtures/hiring/xai-greenhouse.json': xaiGreenhouse,
  'fixtures/pricing/anthropic-models-overview.md': anthropicModelsOverview,
  'fixtures/pricing/anthropic-pricing.md': anthropicPricing,
  'fixtures/pricing/google-models.md': googleModels,
  'fixtures/pricing/google-model-gemini-4-argon.md': googleModelPage,
  'fixtures/pricing/google-pricing.md': googlePricing,
  'fixtures/pricing/meta-models.md': metaModels,
  'fixtures/pricing/meta-pricing.md': metaPricing,
  'fixtures/pricing/mistral-models.md': mistralModels,
  'fixtures/pricing/alibaba-models.html': alibabaModels,
  'fixtures/pricing/alibaba-pricing.html': alibabaPricing,
  'fixtures/pricing/deepseek-pricing.md': deepseekPricing,
  'fixtures/pricing/moonshot-models.md': moonshotModels,
  'fixtures/pricing/mistral-pricing.md': mistralPricing,
  'fixtures/pricing/openai-models.md': openaiModels,
  'fixtures/pricing/openai-model-gpt-5.6-sol.md': openaiModelPage,
  'fixtures/pricing/openai-pricing.md': openaiPricing,
  'fixtures/pricing/openrouter-models.json': openrouterModels,
  'fixtures/pricing/xai-models.md': xaiModels,
  'fixtures/rankings/openrouter-rankings-daily.json': openrouterRankings,
  'fixtures/recipes/gpu-azure.json': gpuAzure,
  'fixtures/recipes/gpu-coreweave.html': gpuCoreweave,
  'fixtures/recipes/gpu-crusoe.html': gpuCrusoe,
  'fixtures/recipes/gpu-digitalocean.html': gpuDigitalocean,
  'fixtures/recipes/gpu-lambda.html': gpuLambda,
  'fixtures/recipes/gpu-nebius.html': gpuNebius,
  'fixtures/recipes/gpu-oracle.json': gpuOracle,
  'fixtures/recipes/gpu-together.html': gpuTogether,
  'fixtures/recipes/gpu-verda.html': gpuVerda,
  'fixtures/recipes/ramp-ai-index.html': rampAiIndex,
  'fixtures/recipes/limits-anthropic.md': limitsAnthropic,
  'fixtures/recipes/limits-meta.md': limitsMeta,
  'fixtures/recipes/limits-openai-gpt-6-astra.md': limitsOpenaiAstra,
  'fixtures/recipes/limits-xai.md': limitsXai,
  'fixtures/recipes/pay-anthropic.json': payAnthropic,
  'fixtures/recipes/pay-openai.json': payOpenai,
  'fixtures/recipes/sec-amzn-anthropic.xml': secAmznAnthropic,
  'fixtures/filed-facts/companyfacts-amzn.json': filedFactsAmznCompanyfacts,
  'fixtures/filed-facts/companyfacts-msft.json': filedFactsMsftCompanyfacts,
  'fixtures/filed-facts/amzn-20260930.xml': filedFactsAmznInstance,
  'fixtures/filed-facts/goog-20260930.xml': filedFactsGooglInstance,
  'fixtures/filed-facts/msft-20260930.xml': filedFactsMsftInstance,
  'fixtures/recipes/sec-msft-openai.xml': secMsftOpenai,
  'fixtures/recipes/epoch-data-centers.csv': epochDataCenters,
  'fixtures/recipes/epoch-data-center-timelines.csv': epochTimelines,
  'fixtures/recipes/github-prs-copilot.json': githubPrsCopilot,
  'fixtures/recipes/npm-claude-code.json': npmClaudeCode,
  'fixtures/recipes/pypi-anthropic.json': pypiAnthropic,
  'fixtures/recipes/sec-companyfacts-crwv.json': secCompanyfactsCrwv,
  'fixtures/sec/edgar-companyfacts-spcx.json': edgarCompanyfactsSpcx,
  'fixtures/sec/edgar-fts-openai.json': edgarFtsOpenai,
  'fixtures/sec/edgar-fts.json': edgarFts,
  'fixtures/sec/edgar-submissions-amzn.json': edgarSubmissionsAmzn,
  'fixtures/sec/edgar-submissions-googl.json': edgarSubmissionsGoogl,
  'fixtures/sec/edgar-submissions-meta.json': edgarSubmissionsMeta,
  'fixtures/sec/edgar-submissions-orcl.json': edgarSubmissionsOrcl,
  'fixtures/sec/edgar-submissions-baba.json': edgarSubmissionsBaba,
  'fixtures/sec/edgar-submissions-msft.json': edgarSubmissionsMsft,
  'fixtures/sec/edgar-submissions-nvda.json': edgarSubmissionsNvda,
  'fixtures/sec/edgar-submissions-spcx.json': edgarSubmissionsSpcx,
  'fixtures/sec/xbrl-segment-googl-2026-10-29.xml': xbrlSegmentGoogl,
  'fixtures/sec/filing-index-anthropic-s-1.html': filingIndexAnthropic,
  'fixtures/sec/prospectus-anthropic-s-1.html': prospectusAnthropic,
  'fixtures/sec/prospectus-anthropic-s-1-a.html': prospectusAnthropicAmended,
  'fixtures/status/anthropic-status.xml': anthropicStatus,
  'fixtures/status/google-cloud-status.json': googleCloudStatus,
  'fixtures/status/mistral-status.json': mistralStatus,
  'fixtures/status/deepseek-status.xml': deepseekStatus,
  'fixtures/status/deepseek-status-atom.xml': deepseekStatusAtom,
  'fixtures/status/xai-status.xml': xaiStatus,
  'fixtures/status/openai-status.json': openaiStatus,
  'fixtures/pricing/wayback/anthropic-models-2024-06.html': waybackAnthropicModels2024,
  'fixtures/pricing/wayback/anthropic-pricing-2025-06.html': waybackAnthropicPricing2025,
  'fixtures/pricing/wayback/openai-api-pricing-2024-12.html': waybackOpenaiApiPricing2024,
  'fixtures/pricing/wayback/openai-docs-pricing-2026-03.html': waybackOpenaiDocsPricing2026,
  'fixtures/pricing/wayback/openai-pricing-2023-07.html': waybackOpenaiPricing2023,
  'fixtures/pricing/wayback/openai-pricing-2024-04.html': waybackOpenaiPricing2024,
  'fixtures/pricing/wayback/openai-pricing-2026-07.md': waybackOpenaiPricingMd2026,
  'fixtures/pricing/wayback/openai-api-pricing-2025-01.html': waybackOpenaiApiPricing2025,
  'fixtures/pricing/wayback/openai-docs-pricing-2026-03b.html': waybackOpenaiDocsPricing2026b,
  'fixtures/pricing/wayback/openai-docs-pricing-2026-07.html': waybackOpenaiDocsPricing202607,
  'fixtures/pricing/wayback/google-pricing-2024-06.html': waybackGooglePricing202406,
  'fixtures/pricing/wayback/google-pricing-2024-08.html': waybackGooglePricing202408,
  'fixtures/pricing/wayback/google-pricing-2025-01.html': waybackGooglePricing202501,
  'fixtures/pricing/wayback/google-docs-pricing-2025-06.html': waybackGoogleDocsPricing202506,
  'fixtures/pricing/wayback/google-docs-pricing-2025-09.html': waybackGoogleDocsPricing202509,
  'fixtures/pricing/wayback/xai-api-2025-03.html': waybackXaiApi202503,
  'fixtures/pricing/wayback/xai-docs-models-2025-12.html': waybackXaiDocsModels202512,
  'fixtures/pricing/wayback/xai-models-2026-03.md': waybackXaiModels202603,
  'fixtures/pricing/wayback/xai-models-2026-06.md': waybackXaiModels202606,
  'fixtures/pricing/wayback/mistral-docs-pricing-2024-04.html': waybackMistralDocsPricing202404,
  'fixtures/pricing/wayback/mistral-technology-2024-06.html': waybackMistralTechnology202406,
  'fixtures/pricing/wayback/mistral-technology-2025-02.html': waybackMistralTechnology202502,
  'fixtures/pricing/wayback/deepseek-platform-pricing-2024-05.html': waybackDeepseekPlatform202405,
  'fixtures/pricing/wayback/deepseek-pricing-2024-12.html': waybackDeepseekPricing202412,
  'fixtures/pricing/wayback/deepseek-pricing-2025-03.html': waybackDeepseekPricing202503,
  'fixtures/pricing/wayback/deepseek-pricing-2025-12.html': waybackDeepseekPricing202512,
  'fixtures/pricing/wayback/deepseek-pricing-2026-05.html': waybackDeepseekPricing202605,
  'fixtures/pricing/wayback/deepseek-pricing-2026-08.html': waybackDeepseekPricing202608,
  'fixtures/pricing/wayback/alibaba-model-pricing-2026-01.html': waybackAlibabaPricing202601,
  'fixtures/pricing/wayback/alibaba-model-pricing-2026-08.html': waybackAlibabaPricing202608,
  'sources.yaml': sourcesYaml,
}

/** Text of a committed file by repo-relative path. Throws on an unknown path
 * so a parser registered against a fixture nobody imported fails loudly. */
export function fixtureText(repoRelativePath: string): string {
  const text = files[repoRelativePath]
  if (text === undefined) {
    throw new Error(
      `no fixture imported for ${repoRelativePath} — add it to layers/terminal/test/pipeline/fixtures.ts`,
    )
  }
  return text
}

/** Provenance recorded in fixtures/manifest.json for a source id — the tests'
 * expected values come from here, never retyped. For a constructed fixture
 * that is the documentation it was built from (fixture-provenance.ts). */
export function provenanceOf(sourceId: string): { source_url: string; fetched_at: string } {
  return fixtureProvenance(sourceId)
}
