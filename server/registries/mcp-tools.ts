// The MCP server's tools, in registration order (the order tools/list returns
// them), and the instructions every client is handed: the app's composition
// root for MCP. The server itself is layers/core/server/utils/mcp.ts. A domain's
// tools live in its own server/mcp/<domain>.ts and get one line here.

import { MCP_SERVER_NAME, PROVENANCE, type McpKit } from '#layers/core/server/mcp/kit'
import { registerAlertTools } from '#layers/terminal/server/mcp/alerts'
import { registerComputeTools } from '#layers/compute/server/mcp/compute'
import { registerDemandTools } from '#layers/terminal/server/mcp/demand'
import { registerExposureTools } from '#layers/terminal/server/mcp/exposure'
import { registerFeedTools } from '#layers/terminal/server/mcp/feed'
import { registerFilingTools } from '#layers/terminal/server/mcp/filings'
import { registerHiringTools } from '#layers/talent/server/mcp/hiring'
import { registerOperationsTools } from '#layers/terminal/server/mcp/operations'
import { registerReliabilityTools } from '#layers/reliability/server/mcp/reliability'
import { registerPriceTools } from '#layers/pricing/server/mcp/prices'
import { registerReleaseTools } from '#layers/terminal/server/mcp/releases'
import { registerSignalTools } from '#layers/terminal/server/mcp/signals'
import { registerThesisTools } from '#layers/terminal/server/mcp/theses'
import { registerUtilizationTools } from '#layers/terminal/server/mcp/utilization'

export const MCP_TOOLS: readonly ((kit: McpKit) => void)[] = [
  registerAlertTools,
  registerPriceTools,
  registerReleaseTools,
  registerHiringTools,
  registerReliabilityTools,
  registerOperationsTools,
  registerDemandTools,
  registerFilingTools,
  registerExposureTools,
  registerUtilizationTools,
  registerComputeTools,
  registerThesisTools,
  registerSignalTools,
  registerFeedTools,
]

export const MCP_INSTRUCTIONS =
  `${MCP_SERVER_NAME}: a free, public, read-only terminal of fundamentals on the frontier AI labs ` +
  '(OpenAI, Anthropic, Google, xAI, Meta, Mistral, DeepSeek, Alibaba (Qwen), Moonshot AI (Kimi)) and the public companies around them. ' +
  'Per lab: API price lists, hiring boards (with the physical-infrastructure buildout cluster) and posted pay (get_pay), the listed companies’ hiring with their data-center roles (get_listed_hiring), SEC filings and disclosed revenue, ' +
  'status-page incidents, latency probes and published rate limits (get_rate_limits), misalignment disclosures, OpenRouter demand share with its implied spend share, ' +
  'and adoption outside the labs’ own numbers (get_adoption). ' +
  'Around the labs: hyperscaler exposure, what Microsoft and Amazon file about OpenAI and Anthropic (get_parents), who sells to and funds whom, suppliers, listed companies, ' +
  'compute (GPU rental prices, utilization readings in get_utilization), hardware (the monthly prints of the foundry and server makers, point in time, in get_hardware_prints), ' +
  'power (Epoch AI’s data-center power in get_datacenters, who powers each lab site in get_power_sites, grid load where those sites are in get_grid_load), ' +
  'press-reported revenue, valuations and funding (get_reported), and those reports scored against later filings (get_ground_truth), and what the listed companies guided on their earnings calls, scored the same way (get_call_guidance). ' +
  'Theses (get_theses) are arguments built on this data, each claim checked against a kill condition. ' +
  'The signal scorecard (get_signals) tests each series against the stocks it is expected to lead, with a held-out sample. ' +
  'Not investment advice. Start with `describe` (the site map) or `get_overview` (what moved). ' +
  PROVENANCE
