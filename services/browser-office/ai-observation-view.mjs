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
    images: cache.observation.images ?? [],
    readMetrics: { count: 0, elapsedMs: 0 },
    observationCacheHit: true,
  };
}

// Detail for another slide may be grafted onto a trusted whole-deck read only
// while the live document and selection still match that read. The engine
// checks each text shape again; this check also rejects incomplete replies.
export function reusableAiObservationForSlide(cache, current, detail) {
  if (
    !reusableAiObservation(cache, {
      ...current,
      detailSlideIndex: cache?.detailSlideIndex,
    }) ||
    !Number.isSafeInteger(current.detailSlideIndex) ||
    detail?.slideIndex !== current.detailSlideIndex ||
    !Array.isArray(detail.elements)
  )
    return null;
  const slide = cache.observation.slides?.[current.detailSlideIndex];
  if (!slide) return null;
  const expected = (slide.elements ?? []).filter(
    (element) => typeof element.text === "string",
  );
  if (
    expected.length !== detail.elements.length ||
    expected.some(
      (element, index) =>
        detail.elements[index]?.elementId !== element.elementId ||
        detail.elements[index]?.text !== element.text ||
        !Array.isArray(detail.elements[index]?.paragraphs),
    )
  )
    return null;
  return {
    ...cache.observation,
    textDetails: {
      slideIndex: detail.slideIndex,
      elements: detail.elements.map(({ elementId, paragraphs }) => ({
        elementId,
        paragraphs,
      })),
    },
    images: cache.observation.images ?? [],
    readMetrics: { count: 0, elapsedMs: 0 },
    observationCacheHit: true,
  };
}

// Showing another slide changes the editor view, not the PPTX. Carry the
// whole-deck read across that view change only when both selections are empty
// and the live document identity is still exact. Keep the old detail index so
// an implicit detail request for the newly active slide cannot reuse it.
export function navigatedAiObservationCache(cache, current) {
  const previousDetail = cache?.observation?.textDetails?.slideIndex;
  if (
    !Number.isSafeInteger(cache?.documentChanges) ||
    !Number.isSafeInteger(current?.documentChanges) ||
    cache.documentChanges !== current.documentChanges ||
    cache.bytes !== current.bytes ||
    cache.revision !== current.revision ||
    !Number.isSafeInteger(current.activeSlide) ||
    !cache.observation.slides?.[current.activeSlide] ||
    !Number.isSafeInteger(previousDetail) ||
    cache.observation.activeSlide !== cache.activeSlide ||
    cache.selectedElementIds?.length !== 0 ||
    cache.observation.selectedElementIds?.length !== 0 ||
    current.selectedElementIds?.length !== 0
  )
    return null;
  return {
    ...cache,
    activeSlide: current.activeSlide,
    detailSlideIndex: previousDetail,
    observation: {
      ...cache.observation,
      activeSlide: current.activeSlide,
      selectedElementIds: [],
    },
  };
}

// Saving may update the document's modified flag but does not itself edit
// slide content. Reuse still requires the live counter, bytes, revision and
// selection checks above after the save has finished.
export function invalidatesAiObservationCache(message) {
  const viewOnlyCommands = [
    "Action_Save",
    "Action_GoToPage",
    "welcome-close",
    "Host_PostmessageReady",
    "User_Active",
  ];
  return Boolean(
    message?.type === "open" ||
      (message?.type === "command" &&
        !viewOnlyCommands.includes(message.messageId)) ||
      (message?.request &&
        !["observe", "selection", "reveal"].includes(
          message.request.operation,
        )),
  );
}
