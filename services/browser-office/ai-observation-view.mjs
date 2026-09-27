/* SPDX-License-Identifier: MPL-2.0 */

// The editor retains the complete observation for permission, revision and
// persistence checks. Only this smaller view is sent to the AI model.
export function aiObservationView(observation) {
  if (!observation || !Array.isArray(observation.slides))
    throw new Error("AI observation needs a presentation.");
  const detailSlides = new Set([
    Number.isSafeInteger(observation.textDetails?.slideIndex)
      ? observation.textDetails.slideIndex
      : observation.activeSlide,
    ...(observation.changedSlideIndexes ?? []),
  ]);
  const { images, readMetrics, modelView, ...state } = observation;
  return {
    ...state,
    detailSlideIndexes: [...detailSlides].sort((a, b) => a - b),
    slides: observation.slides.map((slide) => {
      if (detailSlides.has(slide.slideIndex)) return slide;
      return {
        slideIndex: slide.slideIndex,
        name: slide.name,
        layoutName: slide.layoutName,
        hidden: slide.hidden,
        detailAvailable: true,
        elements: (slide.elements ?? []).map((element) => {
          const text = typeof element.text === "string" ? element.text : null;
          return {
            elementId: element.elementId,
            parentElementId: element.parentElementId,
            name: element.name,
            kind: element.kind,
            text:
              text === null ? null : Array.from(text).slice(0, 160).join(""),
            ...(text !== null ? { textLength: text.length } : {}),
            x: element.x,
            y: element.y,
            width: element.width,
            height: element.height,
          };
        }),
      };
    }),
  };
}

// A missing change listener or a changed selection fails closed to a fresh
// engine read. The caller also verifies the counter after visual capture.
export function reusableAiObservation(cache, current) {
  if (
    !cache ||
    !Number.isSafeInteger(cache.documentChanges) ||
    !Number.isSafeInteger(current.documentChanges) ||
    cache.documentChanges !== current.documentChanges ||
    cache.bytes !== current.bytes ||
    cache.revision !== current.revision ||
    cache.detailSlideIndex !== current.detailSlideIndex ||
    cache.activeSlide !== current.activeSlide ||
    JSON.stringify(cache.selectedElementIds) !==
      JSON.stringify(current.selectedElementIds)
  )
    return null;
  return {
    ...cache.observation,
    images: [],
    readMetrics: { count: 0, elapsedMs: 0 },
    observationCacheHit: true,
  };
}
