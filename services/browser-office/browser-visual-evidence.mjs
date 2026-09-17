/* SPDX-License-Identifier: MPL-2.0 */

// LibreOffice's GraphicExportFilter is not packaged in the browser runtime.
// A browser observation therefore captures the actual canvas after the UNO
// operation has returned. Keep capture selection and completion semantics
// separate from the editor's PPTX mutation transaction.
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
