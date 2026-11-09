# Muse Ember

Muse Ember is the efficient execution model in the Muse family, built for high-volume, repeated work. It runs the sub-agent tasks, tool calls, and routing inside larger agent workflows, and processes large collections of images, files, and records. Pair it with Muse Spark or Muse Wonder: the larger model plans, and Muse Ember handles the volume.

## At a glance

|                                                                                          |                                                                                                                                                                                             |
| :--------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **[Standard mode](https://dev.meta.ai/docs/pricing-rate-limits#standard-mode) model ID** | `muse-ember-1.0`                                                                                                                                                                            |
| **Input**                                                                                | Text, image, video, audio, and PDF                                                                                                                                                          |
| **Output**                                                                               | Text                                                                                                                                                                                        |
| **Context window**                                                                       | 1,048,576 tokens                                                                                                                                                                            |
| **Max output**                                                                           | 524,288 tokens                                                                                                                                                                              |
| **[Reasoning effort](https://dev.meta.ai/docs/reasoning)**                               | `"minimal"` to `"max"`; the default is `"max"`                                                                                                                                              |
| **Endpoints**                                                                            | [Responses](https://dev.meta.ai/docs/protocols/responses), [Chat Completions](https://dev.meta.ai/docs/protocols/chat-completions), [Messages](https://dev.meta.ai/docs/protocols/messages) |
| **Pricing**                                                                              | Pay-as-you-go, with long-context rates for requests over 200K input tokens; see [Muse Ember pricing](https://dev.meta.ai/docs/pricing-rate-limits#muse-ember-pricing)                       |
| **Rate limits**                                                                          | See [rate limits](https://dev.meta.ai/docs/pricing-rate-limits#rate-limits)                                                                                                                 |

## Build with Muse Ember

Use Muse Ember for bounded work that repeats many times:

- **Sub-agent tasks**: run the focused coding tasks, terminal commands, and lookups that a main agent hands out.
- **Tool calls**: drive tool calls inside a larger workflow, where cost and latency per call add up.
- **Routing**: classify requests and send each one to the right handler or model.
- **Work across large collections**: run the same task over thousands of images, files, or records, such as captioning and sorting photos, extracting fields, or classifying tickets, with many Muse Ember requests running in parallel.

Muse Ember accepts the same request body as Muse Spark, so switching most examples is a model ID change. [Switch between models](https://dev.meta.ai/docs/choose-a-model#switch-models) lists what differs. It works with [computer use](https://dev.meta.ai/docs/computer-use), [image understanding](https://dev.meta.ai/docs/media-understanding#images), [tool calling](https://dev.meta.ai/docs/tool-calling), [structured output](https://dev.meta.ai/docs/structured-output), and [search grounding](https://dev.meta.ai/docs/search-grounding).

For hard single-shot coding problems, knowledge-heavy questions, or visual coding, use Muse Spark or Muse Wonder. See [Choose a model](https://dev.meta.ai/docs/choose-a-model).

## Pair Muse Ember with a larger model

In an agent, run Muse Wonder or Muse Spark on the main loop to plan and reason, and hand repeated subtasks to Muse Ember. The reasoning models accept the same request body, so each request picks its model with the `model` field. [Combine models in one agent](https://dev.meta.ai/docs/choose-a-model#combine-models) shows how to set this up in the harnesses you already use.

## Make your first call

Send a request to the [Responses API](https://dev.meta.ai/docs/protocols/responses) with your `MODEL_API_KEY`:

```shell
curl -X POST "https://api.meta.ai/v1/responses" \
  -H "Authorization: Bearer $MODEL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "model": "muse-ember-1.0",
  "input": "Classify this support ticket as billing, bug, or feature request, and give a one-sentence reason: \"I was charged twice for my October invoice.\""
}'
```

For the same call in Python or TypeScript, follow the [quickstart](https://dev.meta.ai/docs/quickstart#first-call) and set the model to `muse-ember-1.0`.

## Availability

Muse Ember is on Model API and in [Muse Code](https://dev.meta.ai/docs/muse-code), on pay-as-you-go and with any subscription.

| Model                         | Model API (pay-as-you-go) | Muse Code                                                                              |
| :---------------------------- | :------------------------ | :------------------------------------------------------------------------------------- |
| Muse Ember (`muse-ember-1.0`) | Standard mode             | Pay-as-you-go and [every plan](https://dev.meta.ai/docs/muse-code/subscriptions#about) |

On Model API, Muse Ember runs in [Standard mode](https://dev.meta.ai/docs/pricing-rate-limits#standard-mode) only; it has no Contributor-mode variant. A request with more than 200K input tokens, such as one with a long conversation history, is billed at higher long-context rates. See [Muse Ember pricing](https://dev.meta.ai/docs/pricing-rate-limits#muse-ember-pricing) for both tiers. On a Muse Code subscription, a request with more than 200K input tokens uses your plan's usage faster.

## Next steps

- Weighing Muse Ember against Muse Spark and Muse Wonder? [Choose a model](https://dev.meta.ai/docs/choose-a-model) compares them workload by workload.
- Get schema-guaranteed JSON from routing and extraction steps with [structured output](https://dev.meta.ai/docs/structured-output).
