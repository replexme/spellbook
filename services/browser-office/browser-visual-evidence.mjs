/* SPDX-License-Identifier: MPL-2.0 */

// Which slides a browser observation shows the AI, and whether every changed
// slide was shown. The engine renders each one (harness "render-slide");
// keep selection and completion separate from the PPTX mutation transaction.
export function browserCaptureTargets(request, observation) {
  if (request?.suppressCapture === true) return [];
  const slideCount = observation?.slides?.length;
  if (!Number.isSafeInteger(slideCount) || slideCount < 1)
    throw new Error("Browser capture needs an observed presentation.");
  const targets =
    request?.operation === "observe" &&
    request.captureSlideIndexes !== undefined
      ? request.captureSlideIndexes
      : request?.operation === "observe"
        ? [
            Number.isSafeInteger(observation.textDetails?.slideIndex)
              ? observation.textDetails.slideIndex
              : observation.activeSlide,
          ]
        : observation.changedSlideIndexes?.length
          ? observation.changedSlideIndexes
          : [observation.activeSlide];
  if (
    !Array.isArray(targets) ||
    targets.length > 8 ||
    targets.some(
      (index) =>
        !Number.isSafeInteger(index) || index < 0 || index >= slideCount,
    )
  )
    throw new Error("invalid_capture_slide_indexes");
  return [...new Set(targets)].sort((left, right) => left - right);
}

export function withBrowserVisualEvidence(observation, images, targets = []) {
  const changed = observation.changedSlideIndexes ?? [];
  const required = [...new Set([...changed, ...targets])];
  return {
    ...observation,
    images,
    visualEvidenceComplete:
      required.length === 0 ||
      required.every((index) =>
        images.some((image) => image.slideIndex === index),
      ),
  };
}
