# Muse Spark

Muse Spark is Meta's model for agentic and coding work at scale, such as multi-step tool loops, software engineering assistants, and long-context reasoning. It costs less than Muse Wonder, and on Model API it also offers a discounted Contributor mode.

## At a glance

|                                                                                                |                                                                                                                                                                                             |
| :--------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **[Standard mode](https://dev.meta.ai/docs/pricing-rate-limits#standard-mode) model IDs**      | `muse-spark-1.3`, `muse-spark-1.2`, `muse-spark-1.1`                                                                                                                                        |
| **[Contributor-mode](https://dev.meta.ai/docs/pricing-rate-limits#contributor-mode) variants** | `muse-spark-1.3-contributor`, `muse-spark-1.2-contributor`                                                                                                                                  |
| **Input**                                                                                      | Text, image, video, audio, and PDF                                                                                                                                                          |
| **Output**                                                                                     | Text                                                                                                                                                                                        |
| **Context window**                                                                             | 1,048,576 tokens                                                                                                                                                                            |
| **[Reasoning effort](https://dev.meta.ai/docs/reasoning)**                                     | `"minimal"` to `"max"` on `muse-spark-1.3`; see [Versions](https://dev.meta.ai/docs/muse-spark#versions). The default is `"high"`                                                           |
| **Endpoints**                                                                                  | [Responses](https://dev.meta.ai/docs/protocols/responses), [Chat Completions](https://dev.meta.ai/docs/protocols/chat-completions), [Messages](https://dev.meta.ai/docs/protocols/messages) |
| **Pricing**                                                                                    | Pay-as-you-go; see [Muse Spark pricing](https://dev.meta.ai/docs/pricing-rate-limits#muse-spark-pricing)                                                                                    |
| **Rate limits**                                                                                | See [rate limits](https://dev.meta.ai/docs/pricing-rate-limits#rate-limits)                                                                                                                 |

## Build with Muse Spark

Use Muse Spark for agentic and coding work that needs strong reasoning at a lower cost than Muse Wonder:

- **Agent main loops**: run the main loop of an agent or assistant, and hand high-volume subtasks to [Muse Ember](https://dev.meta.ai/docs/muse-ember).
- **Multi-step tool loops**: plan and drive tool calls across many turns.
- **Knowledge-heavy questions**: answer questions that depend on broad knowledge, without a retrieval step.
- **Coding assistants**: connect the [coding agent](https://dev.meta.ai/docs/coding-agents) you already use, or run [Muse Code](https://dev.meta.ai/docs/muse-code).

Muse Spark also handles [image understanding](https://dev.meta.ai/docs/media-understanding#images), [video](https://dev.meta.ai/docs/media-understanding#video) and [audio](https://dev.meta.ai/docs/media-understanding#audio) understanding, [tool calling](https://dev.meta.ai/docs/tool-calling), [structured output](https://dev.meta.ai/docs/structured-output), and [search grounding](https://dev.meta.ai/docs/search-grounding). For complex, long-running tasks where capability matters more than cost, see [Choose a model](https://dev.meta.ai/docs/choose-a-model).

## Versions

Muse Spark comes in three versions. All take text, image, video, audio, and PDF input, return text, and have a 1,048,576-token context window. They differ by capability:

- **Muse Spark 1.3** (`muse-spark-1.3`): the latest version, tuned for agentic workflows (multi-step tool, browser, and long-horizon tasks) with improved coding over 1.2. Supports all [reasoning effort](https://dev.meta.ai/docs/reasoning) levels, including the `"max"` level for extended reasoning (not available with `muse-spark-1.3-contributor`). **Recommended for new work.**
- **Muse Spark 1.2** (`muse-spark-1.2`): the previous version.
- **Muse Spark 1.1** (`muse-spark-1.1`): the original version.

> **NOTE: Audio input on Muse Spark 1.3**
>
> Audio understanding in Muse Spark 1.3 is not fully supported, and response quality for requests that include audio may be degraded. For audio, use Muse Spark 1.2, or [Muse Voice Transcribe](https://dev.meta.ai/docs/models#muse-voice-transcribe) for dedicated speech-to-text.

`muse-spark-1.3` is the default model in most code examples in these docs. The [coding agents](https://dev.meta.ai/docs/coding-agents), [agent frameworks](https://dev.meta.ai/docs/agent-frameworks), and [computer use](https://dev.meta.ai/docs/computer-use) guides use `muse-wonder-1.0` for long-running agentic work.

## Make your first call

Follow the [quickstart](https://dev.meta.ai/docs/quickstart#first-call) to set your key and send your first request to `muse-spark-1.3`.

## Availability

Every Muse Spark version is available on pay-as-you-go. All versions except Muse Spark 1.1 are also available in [Muse Code](https://dev.meta.ai/docs/muse-code), on pay-as-you-go and with any subscription.

| Version                                                   | Model API (pay-as-you-go) | Muse Code                                                                              |
| :-------------------------------------------------------- | :------------------------ | :------------------------------------------------------------------------------------- |
| Muse Spark 1.3 (`muse-spark-1.3`)                         | Standard mode             | Pay-as-you-go and [every plan](https://dev.meta.ai/docs/muse-code/subscriptions#about) |
| Muse Spark 1.3 Contributor (`muse-spark-1.3-contributor`) | Contributor mode          | Pay-as-you-go and [every plan](https://dev.meta.ai/docs/muse-code/subscriptions#about) |
| Muse Spark 1.2 (`muse-spark-1.2`)                         | Standard mode             | Pay-as-you-go and [every plan](https://dev.meta.ai/docs/muse-code/subscriptions#about) |
| Muse Spark 1.2 Contributor (`muse-spark-1.2-contributor`) | Contributor mode          | Pay-as-you-go and [every plan](https://dev.meta.ai/docs/muse-code/subscriptions#about) |
| Muse Spark 1.1 (`muse-spark-1.1`)                         | Standard mode             | Not available                                                                          |

In [Standard mode](https://dev.meta.ai/docs/pricing-rate-limits#standard-mode), your content — the prompts, code, files, and context you send, plus the model responses you get back — is not used to train Meta models. In [Contributor mode](https://dev.meta.ai/docs/pricing-rate-limits#contributor-mode), your content may be used to train future Meta models, in exchange for a lower price. On pay-as-you-go, switch between the two by choosing the model ID: for example, `muse-spark-1.3` for Standard mode or `muse-spark-1.3-contributor` for Contributor mode. Muse Spark 1.1 is available in Standard mode only. See [Pricing and rate limits](https://dev.meta.ai/docs/pricing-rate-limits) for rates.

## Next steps

- Weighing Muse Spark against Muse Wonder? [Choose a model](https://dev.meta.ai/docs/choose-a-model) compares them workload by workload.
- Get schema-guaranteed JSON for your classification pipeline with [structured output](https://dev.meta.ai/docs/structured-output).
- Pair Muse Spark with Muse Wonder and Muse Ember in one agent with an [agent framework](https://dev.meta.ai/docs/agent-frameworks).
