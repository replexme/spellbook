/* SPDX-License-Identifier: MPL-2.0 */
const { completionSchema } = require("./native-turn-policy.cjs");
function createSubscriptionModel(client, allowImageGeneration = false) {
  if (typeof client?.runStructuredTurn !== "function")
    throw Error("subscription_model_invalid");
  const result = (output) => ({
    success: output.ok,
    contentItems: [
      { type: "inputText", text: output.text },
      ...(client.supportsInputImages === false
        ? []
        : (output.images ?? []).map((base64) => ({
            type: "inputImage",
            imageUrl: "data:image/png;base64," + base64,
          }))),
    ],
  });
  return {
    supportsInputImages: client.supportsInputImages !== false,
    allowImageGeneration,
    run: (options) =>
      client.runStructuredTurn(
        [
          { type: "text", text: options.instructions },
          ...(options.initialPage
            ? [
                { type: "text", text: options.initialPage.text },
                ...(client.supportsInputImages === false
                  ? []
                  : (options.initialPage.images ?? []).map((base64) => ({
                      type: "image",
                      url: "data:image/png;base64," + base64,
                    }))),
              ]
            : []),
        ],
        completionSchema,
        options.timeoutMs,
        {
          modelSettings: options.modelSettings,
          signal: options.signal,
          onText: options.onText,
          onThinking: options.onThinking,
          onUsage: options.onUsage,
          onEvent: () => {},
          tools: options.tools.map((tool) => ({ ...tool, type: "function" })),
          onTool: async (name, args, _id, signal) =>
            result(await options.onTool(name, args, signal)),
          allowImageGeneration: options.allowImageGeneration === true,
          onGeneratedImage: options.allowImageGeneration
            ? options.onGeneratedImage
            : undefined,
        },
      ),
  };
}
module.exports = { createSubscriptionModel };
