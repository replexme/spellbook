/* SPDX-License-Identifier: MPL-2.0 */
// Persistent product goal is distinct from a provider's bounded conversation.
function normalizeActiveGoal(value, scope) {
  if (
    !value ||
    value.version !== 1 ||
    typeof value.request !== "string" ||
    !value.request.trim() ||
    value.request.length > 2000 ||
    typeof value.scope !== "string" ||
    value.scope !== scope ||
    !Array.isArray(value.checks) ||
    value.checks.length > 500
  )
    return null;
  const checks = [];
  for (const check of value.checks) {
    if (
      !check ||
      check.kind !== "image_shape" ||
      !/^\d+(?:\/\d+)+$/.test(check.elementId ?? "") ||
      !["circle", "rectangle"].includes(check.shape)
    )
      return null;
    checks.push({
      kind: check.kind,
      elementId: check.elementId,
      shape: check.shape,
      ...(typeof check.mediaFingerprint === "string" &&
      /^sha256:[a-f0-9]{64}$/.test(check.mediaFingerprint)
        ? { mediaFingerprint: check.mediaFingerprint }
        : {}),
    });
  }
  return { version: 1, scope, request: value.request, checks };
}
function goalChecks(request, observation, permission) {
  const circle = /(?:원형|동그랗|동그란|\bcircl(?:e|ular)\b)/iu.test(request);
  const rectangle = /(?:사각형|직사각형|\brectang(?:le|ular)\b)/iu.test(
    request,
  );
  if (!circle && !rectangle) return [];
  const pages = observation.slides.filter(
    (slide) =>
      permission.mode !== "slides" ||
      permission.slideIndexes.includes(slide.slideIndex),
  );
  const flatten = (elements) =>
    elements.flatMap((element) => [
      element,
      ...flatten(element.elements ?? []),
    ]);
  let images = pages
    .flatMap((slide) => flatten(slide.elements))
    .filter(
      (element) =>
        ["image", "picture"].includes(
          element.kind ?? element.type ?? element.onlyoffice?.type,
        ) &&
        (permission.mode !== "selection" ||
          permission.elementIds.includes(element.elementId)),
    );
  // Multiple unnamed pictures cannot be silently narrowed to a convenient one.
  const all = /(?:모든|전부|사진들|\ball\b)/iu.test(request);
  if (
    !all &&
    Array.isArray(observation.selectedElementIds) &&
    images.some((image) =>
      observation.selectedElementIds.includes(image.elementId),
    )
  )
    images = images.filter((image) =>
      observation.selectedElementIds.includes(image.elementId),
    );
  const targets = images.length === 1 || all ? images : [];
  return targets.map((element) => ({
    kind: "image_shape",
    elementId: element.elementId,
    shape: circle ? "circle" : "rectangle",
    ...(fingerprint(element.elementId, observation)
      ? { mediaFingerprint: fingerprint(element.elementId, observation) }
      : {}),
  }));
}
function fingerprint(elementId, observation) {
  const [slideIndex, ...indexes] = elementId.split("/").map(Number);
  let value = observation.slides.find(
    (slide) => slide.slideIndex === slideIndex,
  )?.onlyoffice;
  let drawing;
  for (const index of indexes) {
    drawing = (drawing?.groupChildren ?? value?.drawings)?.[index];
    value = null;
  }
  return typeof drawing?.imagePath === "string" &&
    /^sha256:[a-f0-9]{64}$/.test(drawing.imagePath)
    ? drawing.imagePath
    : null;
}
function verifyGoalChecks(checks, observation) {
  const failures = [];
  for (const check of checks) {
    const parts = check.elementId.split("/").map(Number);
    const slide = observation.slides.find(
      (slide) => slide.slideIndex === parts[0],
    );
    let element = slide;
    for (const index of parts.slice(1)) element = element?.elements?.[index];
    const preset =
      element?.onlyoffice?.geometry?.preset ??
      (parts.length === 2
        ? slide?.onlyoffice?.drawings?.[parts[1]]?.geometry?.preset
        : null);
    if (
      !element ||
      (check.mediaFingerprint &&
        fingerprint(check.elementId, observation) !== check.mediaFingerprint) ||
      preset !== (check.shape === "circle" ? "ellipse" : "rect") ||
      (check.shape === "circle" &&
        (!Number.isFinite(element.width) ||
          !Number.isFinite(element.height) ||
          Math.abs(element.width - element.height) > 1))
    )
      failures.push({
        elementId: check.elementId,
        condition: check.shape,
        actual: { preset, width: element?.width, height: element?.height },
      });
  }
  return { passed: failures.length === 0, checked: checks.length, failures };
}
function nextActiveGoal(previous, scope, request, completion, checks) {
  if (completion.task.intent === "answer")
    return normalizeActiveGoal(previous, scope);
  if (completion.task.outcome === "fulfilled") return null;
  return { version: 1, scope, request: request.slice(0, 2000), checks };
}
function prepareActiveGoal(request, previous, scope) {
  const normalized = normalizeActiveGoal(previous, scope);
  const policy = require("./native-turn-policy.cjs");
  if (policy.continuationGoal(request, [], normalized)) return normalized;
  return policy.explicitEditRequest(request)
    ? { version: 1, scope, request: request.slice(0, 2000), checks: [] }
    : normalized;
}
// A complete, unambiguous primitive request needs no model planning round.
// Additional actions, ambiguous pictures and non-square framing use the agent.
function simpleGoalCommands(request, checks, observation, permission) {
  if (
    permission.mode === "read_only" ||
    checks.length !== 1 ||
    checks[0].shape !== "circle" ||
    !/^(?:(?:이|현재|프로필)\s*)?사진(?:을|은)?\s*원형으로\s*(?:잘라(?:서\s*들어가게)?|바꿔|변경해|만들어)\s*(?:해\s*)?(?:줘|주세요)(?:[.!]|\s*(?:지금은|현재는)\s*(?:너무\s*)?(?:네모(?:라|여서)|사각형(?:이라|이라서))\s*(?:부자연스러워|부자연스러워요)[.!]?)?$/u.test(
      request.trim(),
    )
  )
    return null;
  const check = checks[0];
  const slide = observation.slides.find((slide) =>
    slide.elements.some((element) => element.elementId === check.elementId),
  );
  const element = slide?.elements.find(
    (element) => element.elementId === check.elementId,
  );
  if (
    !element ||
    !Number.isFinite(element.width) ||
    Math.abs(element.width - element.height) > 1 ||
    element.onlyoffice?.locks?.noCrop ||
    element.onlyoffice?.locks?.noChangeShapeType ||
    verifyGoalChecks(checks, observation).passed
  )
    return null;
  return [
    { op: "crop_image", elementId: check.elementId, geometry: "ellipse" },
  ];
}
module.exports = {
  simpleGoalCommands,
  prepareActiveGoal,
  normalizeActiveGoal,
  goalChecks,
  verifyGoalChecks,
  nextActiveGoal,
};
