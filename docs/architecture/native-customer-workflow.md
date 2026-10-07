# Native editing workflow

The browser, local subscription connector and managed subscription worker use
`contracts/native-turn-runtime.cjs`. Provider adapters translate text, images,
tool results and usage; they do not decide editing permission or completion.
The managed worker loads this contract from its pinned public source checkout.

## Durable goal and live evidence

An `ActiveGoal` contains the document scope, original request and applicable
objective checks. It is independent of the last 12 turns / 24,000 characters of
conversation. Hosted sessions store it in `spellbook_native_sessions.active_goal`;
local workspaces store it beside their file handle in IndexedDB. Answer turns
and cancellation retain the pending goal. A new explicit edit replaces it, a
verified completion clears it, and another document cannot inherit it.
Status questions also receive this pending goal without authorizing an edit;
continuation instructions retain additional constraints from the current turn.

Live editor revision, permission and native observations govern every mutation.
A remembered goal never grants permission. Native batches retain existing
preflight, rollback, one-step undo, file admission and recovery behavior.
`product_mutation_rejected:` means native execution never started;
`product_mutation_rolled_back:` means exact prior live state was restored.
An unknown transport failure leaves the mutation unconfirmed even if a later
command succeeds.

## Execution and completion

The canonical capability registry defines operation arguments. The same
validator is used at the model-tool and editor boundaries. Non-null irrelevant
arguments and unknown fields fail explicitly. Binary assets use the existing
trusted asset host; ordinary commands use the atomic batch tool, including
one-command batches.

A complete, unambiguous Korean circle-photo instruction for a single square,
unlocked picture uses one native `crop_image` command with `geometry: ellipse`.
Its frame, existing crop and media remain unchanged. Ambiguous pictures,
non-square frames and additional instructions use model planning. This narrow
optimization is not a general natural-language command parser.

The result must contain fresh PNGs for every slide touched during the turn.
Successive batches accumulate review coverage. The model returns its visual
review and user message together. The runtime checks coverage, revision
freshness, introduced layout issues and applicable customer-goal checks before
reporting fulfilment. It also checks that every result image was offered to an
image-capable model, including images inserted asynchronously by the provider.
A circle requires both an ellipse and a square frame;
when observed, the original media fingerprint must also match.

Missing results can be repaired under the existing permission when a fresh
read proves the document is unchanged. Each new provider call receives result
images explicitly; it does not rely on another provider thread's memory.
A human edit invalidates earlier review evidence. A successful tool call or
model approval alone does not prove the requested result.

Objective checks currently cover circle/rectangle image shape and original
media identity. Other editing goals still require model semantic review;
the runtime does not claim an independent deterministic grader for all 94
commands. Subjective visual quality still needs human evaluation.

## Measurement and evaluation

The runtime records elapsed time, editor-host time, model time, host calls,
sent/full observation bytes, images and provider-reported token use. Prepared
observations that were never passed to a model are not counted as deliveries.
Model time
excludes nested host work. Subscription providers report thread token totals;
the adapter records growth from each turn's starting totals. Aborted and failed
turns retain timing where the adapter publishes failure metrics.

Focused regression coverage lives in
[native-customer-workflow.test.mjs](../../scripts/native-customer-workflow.test.mjs).
[verify-native-image-shape.mjs](../../scripts/verify-native-image-shape.mjs)
uses the real headless editor for shape, rejected arguments, crop/media
preservation, undo/redo, native save/reopen and local goal persistence.
[evaluate-native-customer-workflow.mjs](../../scripts/evaluate-native-customer-workflow.mjs)
uses a real local subscription model and editor; each trial checks authored
results, unrelated objects, saved media and exact reopened state. Pass
`--require-success true` to fail when any required trial does not fulfil its goal.

Keep implementation, local integration, authenticated customer flow,
PowerPoint compatibility, production deployment and comparative product
quality as separate evidence. A small repeated cohort cannot establish broad
performance superiority.

## Design references

- [ONLYOFFICE image editing](https://helpcenter.onlyoffice.com/docs/userguides/presentation_editor/InsertImages.aspx): native crop-to-shape rather than raster replacement.
- [OpenAI latency optimization](https://developers.openai.com/api/docs/guides/latency-optimization): avoid unnecessary model calls and use deterministic execution for bounded tasks.
- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) and [tool search](https://developers.openai.com/api/docs/guides/tools-tool-search): consider actual provider support and measured overhead rather than copying API features into a subscription transport.
- [Anthropic managed agents](https://www.anthropic.com/engineering/managed-agents): separate durable session state from model context and execution.
- [Anthropic agent evaluations](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents): grade real final state, repeat trials and combine objective and model/human judgment.
- [Anthropic context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents): provide sufficient current evidence and clear tool contracts.

These references informed the design; they are not evidence that this product
has achieved equivalent customer quality or competitive leadership.
