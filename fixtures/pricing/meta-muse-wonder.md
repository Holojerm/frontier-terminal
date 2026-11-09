# Muse Wonder

Muse Wonder is Meta's most capable model, built for complex software engineering and long-horizon agentic work. It makes and verifies changes across many files in real repositories, and it plans, delegates to sub-agents, calls tools in parallel, and recovers from errors across many steps, following detailed instructions closely.

> **NOTE: Preview**
>
> Muse Wonder is in preview. For more about the model, see the [Muse Wonder model page](https://dev.meta.ai/models/muse-wonder) and the [Muse Wonder model card](https://research.meta.ai/static/muse-wonder-model-card).

## At a glance

|                                                            |                                                                                                                                                                                             |
| :--------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Model ID**                                               | `muse-wonder-1.0`                                                                                                                                                                           |
| **Input**                                                  | Text, image, video, audio, and PDF                                                                                                                                                          |
| **Output**                                                 | Text                                                                                                                                                                                        |
| **Context window**                                         | 1,048,576 tokens                                                                                                                                                                            |
| **[Reasoning effort](https://dev.meta.ai/docs/reasoning)** | `"minimal"` to `"max"`; the default is `"max"`                                                                                                                                              |
| **Endpoints**                                              | [Responses](https://dev.meta.ai/docs/protocols/responses), [Chat Completions](https://dev.meta.ai/docs/protocols/chat-completions), [Messages](https://dev.meta.ai/docs/protocols/messages) |
| **Pricing**                                                | Pay-as-you-go, Standard mode only; see [Muse Wonder pricing](https://dev.meta.ai/docs/pricing-rate-limits#muse-wonder-pricing)                                                              |
| **Rate limits**                                            | See [rate limits](https://dev.meta.ai/docs/pricing-rate-limits#rate-limits)                                                                                                                 |

## Build with Muse Wonder

Use Muse Wonder when capability matters more than cost per token:

- **Multi-file coding changes**: make and verify changes across many files in a real repository.
- **Long-running agents**: plan, delegate to sub-agents, and work through multi-hour runs with parallel tool calls.
- **Agent main loops**: run the main loop of a [coding agent](https://dev.meta.ai/docs/coding-agents) or an [agent framework](https://dev.meta.ai/docs/agent-frameworks), and hand lower-cost subtasks to [Muse Ember](https://dev.meta.ai/docs/muse-ember).
- **Computer use**: drive a desktop from screenshots with the native [computer use](https://dev.meta.ai/docs/computer-use) tool.

Muse Wonder also handles [image understanding](https://dev.meta.ai/docs/media-understanding#images), [video](https://dev.meta.ai/docs/media-understanding#video) and [audio](https://dev.meta.ai/docs/media-understanding#audio) understanding, [tool calling](https://dev.meta.ai/docs/tool-calling), [structured output](https://dev.meta.ai/docs/structured-output), and [search grounding](https://dev.meta.ai/docs/search-grounding). For high-volume, latency-sensitive, or cost-sensitive work, see [Choose a model](https://dev.meta.ai/docs/choose-a-model).

## Set reasoning effort

Muse Wonder supports every [reasoning effort](https://dev.meta.ai/docs/reasoning) level from `"minimal"` to `"max"`. For agentic coding, start with `"high"`. Save `"xhigh"` and `"max"` for the hardest problems, such as tracing a concurrency bug or planning a large migration, where a correct answer matters more than speed.

On Model API, `"max"` on `muse-wonder-1.0` doesn't select Muse Wonder Full, which is available only in Muse Code.

## Make your first call

Muse Wonder takes the same requests as Muse Spark on the same endpoints. Follow the [quickstart](https://dev.meta.ai/docs/quickstart#first-call) and set the model to `muse-wonder-1.0`. Most examples in these docs that use `muse-spark-1.3` run on Muse Wonder with that change; [Switch between models](https://dev.meta.ai/docs/choose-a-model#switch-models) lists the settings that differ.

## Availability

Muse Wonder comes in two variants. Muse Wonder is on Model API and in [Muse Code](https://dev.meta.ai/docs/muse-code). Muse Wonder Full, the higher-capability variant, is available only in Muse Code with a subscription, so setting reasoning effort to `"max"` on Muse Wonder doesn't select it.

| Variant                         | Model API (pay-as-you-go)      | Muse Code                                                                                                                                                       |
| :------------------------------ | :----------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Muse Wonder (`muse-wonder-1.0`) | Available (Standard mode only) | Pay-as-you-go and [every plan](https://dev.meta.ai/docs/muse-code/subscriptions#about)                                                                          |
| Muse Wonder Full                | Not available                  | [Power Usage](https://dev.meta.ai/docs/muse-code/subscriptions#power-usage) and [Maximum Usage](https://dev.meta.ai/docs/muse-code/subscriptions#maximum-usage) |

With a subscription, Muse Wonder is available on every plan and Muse Wonder Full on the Power Usage and Maximum Usage plans, each in [Standard mode](https://dev.meta.ai/docs/pricing-rate-limits#standard-mode) and [Contributor mode](https://dev.meta.ai/docs/pricing-rate-limits#contributor-mode).

Muse Wonder and Muse Wonder Full aren't currently available in South Korea, on Model API or in Muse Code.

In Standard mode, your content — the prompts, code, files, and context you send, plus the model responses you get back — is not used to train Meta models. Muse Code subscribers can also use Contributor mode, which is on by default: it gives you more usage in exchange for letting Meta use your content to train future Meta models, and you can turn it off at any time in your settings. For Muse Wonder, Contributor mode isn't available on pay-as-you-go. See [Pricing and rate limits](https://dev.meta.ai/docs/pricing-rate-limits) for rates.

## Next steps

- Not sure Muse Wonder is the right fit? [Choose a model](https://dev.meta.ai/docs/choose-a-model) compares it with Muse Spark workload by workload.
- Put Muse Wonder to work on your codebase by wiring it into [Codex or Claude Code](https://dev.meta.ai/docs/coding-agents).
- Give it a desktop to drive with the [computer use](https://dev.meta.ai/docs/computer-use) guide.
