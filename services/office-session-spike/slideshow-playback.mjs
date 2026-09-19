import { createHash } from "node:crypto";

const DEFAULT_TIMEOUT_MS = 15_000;

const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function normalizeExpected(expected) {
  if (
    !expected ||
    !["transition", "animation", "interaction"].includes(expected.kind)
  )
    throw new Error(
      "Playback expectation must name transition, animation or interaction.",
    );
  if (!Number.isInteger(expected.slideIndex) || expected.slideIndex < 0)
    throw new Error("Playback expectation requires a non-negative slideIndex.");
  if (
    expected.kind === "interaction" &&
    (!expected.action ||
      !Number.isInteger(expected.targetSlideIndex) ||
      expected.targetSlideIndex < 0)
  )
    throw new Error(
      "Interaction playback requires an action and targetSlideIndex.",
    );
  return {
    ...expected,
    timeoutMs: expected.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

export function validatePlaybackEvidence(evidence, expected) {
  const expectation = normalizeExpected(expected);
  if (!evidence?.presentationInfo)
    throw new Error("Slideshow returned no presentation metadata.");
  if (evidence.slideIndex !== expectation.slideIndex)
    throw new Error("Slideshow started on a different slide.");
  if (!evidence.canvas?.width || !evidence.canvas?.height)
    throw new Error("Slideshow produced no renderable canvas.");

  if (expectation.kind === "transition") {
    const transition = evidence.presentationInfo.transition;
    if (!transition?.type || transition.type === "Invalid")
      throw new Error(
        "The edited transition was not exported to the web player.",
      );
    if (
      typeof expectation.durationSeconds === "number" &&
      Math.abs(
        Number(transition.durationMilliseconds) -
          expectation.durationSeconds * 1000,
      ) > 1
    )
      throw new Error(
        "The web player received a different transition duration.",
      );
    if (!evidence.transition?.activityCreated)
      throw new Error("The web player did not create a transition activity.");
    if ((evidence.transition?.renderCalls ?? 0) < 2)
      throw new Error("The transition did not render multiple canvas frames.");
    if (!evidence.transition?.ended)
      throw new Error("The transition did not reach its playback end event.");
  } else if (expectation.kind === "animation") {
    const animation = evidence.presentationInfo.animation;
    if (!animation?.present)
      throw new Error(
        "The edited animation was not exported to the web player.",
      );
    if (
      expectation.presetId &&
      !animation.presets.includes(expectation.presetId)
    )
      throw new Error(
        "The edited animation preset is missing from playback data.",
      );
    if (
      typeof expectation.durationSeconds === "number" &&
      !animation.durations.includes(`${expectation.durationSeconds}s`)
    )
      throw new Error(
        "The edited animation duration is missing from playback data.",
      );
    if (!evidence.animation?.started)
      throw new Error("The web player did not start an animation effect.");
    if (!evidence.animation?.ended)
      throw new Error("The animation did not reach its playback end event.");
    if ((evidence.animation?.frameSamples ?? 0) < 2)
      throw new Error("The animation playback was not sampled completely.");
    if ((evidence.animation?.frameFingerprints ?? 0) < 2)
      throw new Error(
        `The animation did not produce distinct composited frames (${evidence.animation?.frameFingerprints ?? 0}/${evidence.animation?.frameSamples ?? 0}).`,
      );
  } else {
    const matchingInteraction = evidence.presentationInfo.interactions?.find(
      ({ clickAction }) => clickAction?.action === expectation.action,
    );
    if (!matchingInteraction)
      throw new Error(
        "The edited interaction was not exported to the web player.",
      );
    if (!evidence.interaction?.executed)
      throw new Error("The web player did not execute the click interaction.");
    if (evidence.interaction?.targetSlideIndex !== expectation.targetSlideIndex)
      throw new Error("The click interaction reached a different slide.");
    if (!evidence.interaction?.targetRendered)
      throw new Error("The target slide did not finish rendering.");
  }

  return {
    kind: expectation.kind,
    slideIndex: expectation.slideIndex,
    actualWebPlayback: true,
    canvas: evidence.canvas,
    presentationInfo: evidence.presentationInfo,
    transition: evidence.transition,
    animation: evidence.animation,
    interaction: evidence.interaction,
  };
}

async function findOfficeFrame(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    for (const frame of page.frames()) {
      const ready = await frame
        .evaluate(() =>
          Boolean(
            window.app?.map?.slideShowPresenter?._onStartInWindow &&
              window.app?.map?._docLayer,
          ),
        )
        .catch(() => false);
      if (ready) return frame;
    }
    await wait(100);
  } while (Date.now() < deadline);
  throw new Error("Collabora slideshow runtime did not become available.");
}

async function waitForProbe(frame, predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  do {
    const state = await frame
      .evaluate(() => {
        const probe = window.__presentPlaybackProbe;
        if (!probe) return null;
        return {
          kind: probe.kind,
          slideIndex: probe.slideIndex,
          ready: probe.ready,
          presentationInfo: probe.presentationInfo,
          canvas: probe.canvas,
          transition: probe.transition,
          animation: {
            started: probe.animation.started,
            ended: probe.animation.ended,
          },
          interaction: probe.interaction,
        };
      })
      .catch(() => null);
    if (state && predicate(state)) return state;
    await wait(40);
  } while (Date.now() < deadline);
  throw new Error(message);
}

export async function verifySlideshowPlayback(page, expected) {
  const expectation = normalizeExpected(expected);
  // The browser Office runtime is an editor without a slideshow player, so
  // there is no web playback to observe on that surface. Say so explicitly
  // instead of waiting for Collabora's player; the edit itself is still
  // proven by Undo/Redo, save and reopen of the persisted PPTX.
  if (new URL(page.url()).searchParams.get("browserProbe") === "1")
    return {
      kind: expectation.kind,
      slideIndex: expectation.slideIndex,
      actualWebPlayback: false,
      surface: "browser-office",
      reason: "browser_runtime_has_no_slideshow_player",
    };
  const frame = await findOfficeFrame(page, expectation.timeoutMs);
  await frame.evaluate(({ kind, slideIndex, targetSlideIndex }) => {
    const presenter = window.app.map.slideShowPresenter;
    if (presenter.getCanvas()) presenter.endPresentation(true);
    const handler = presenter._slideShowHandler;
    const map = window.app.map;
    const probe = {
      kind,
      slideIndex,
      ready: false,
      presentationInfo: null,
      canvas: null,
      transition: {
        activityCreated: false,
        performCalls: 0,
        renderCalls: 0,
        ended: false,
      },
      animation: {
        started: false,
        ended: false,
      },
      interaction: {
        executed: false,
        targetSlideIndex: null,
        targetRendered: false,
      },
      restore: [],
    };
    window.__presentPlaybackProbe = probe;

    const wrap = (target, name, after) => {
      const original = target[name];
      if (typeof original !== "function")
        throw new Error(`slideshow_method_missing:${name}`);
      target[name] = function presentPlaybackWrappedMethod(...args) {
        const result = original.apply(this, args);
        after(result, args);
        return result;
      };
      probe.restore.push(() => {
        target[name] = original;
      });
    };
    wrap(handler, "createSlideTransition", (activity) => {
      probe.transition.activityCreated = Boolean(activity);
      if (!activity || typeof activity.perform !== "function") return;
      const perform = activity.perform;
      activity.perform = function presentPlaybackTransitionFrame(...args) {
        probe.transition.performCalls += 1;
        return perform.apply(this, args);
      };
      const animation = activity.aAnimation;
      if (!animation || typeof animation.render !== "function") return;
      const render = animation.render;
      animation.render = function presentPlaybackTransitionRender(...args) {
        probe.transition.renderCalls += 1;
        return render.apply(this, args);
      };
    });
    wrap(handler, "notifyTransitionEnd", () => {
      probe.transition.ended = true;
    });
    wrap(handler, "notifyNextEffectStart", () => {
      probe.animation.started = true;
    });
    wrap(handler, "notifyNextEffectEnd", () => {
      probe.animation.ended = true;
    });

    const onTransitionEnd = ({ slide }) => {
      if (slide === slideIndex) probe.transition.ended = true;
      if (kind === "interaction" && slide === targetSlideIndex)
        probe.interaction.targetRendered = true;
    };
    map.on("transitionend", onTransitionEnd);
    probe.restore.push(() => map.off("transitionend", onTransitionEnd));
    presenter._onStartInWindow({ startSlideNumber: slideIndex });
  }, expectation);

  try {
    await waitForProbe(
      frame,
      (state) => state.transition.ended,
      expectation.timeoutMs,
      "Slideshow did not finish loading the requested slide.",
    );
    await frame.evaluate(({ slideIndex }) => {
      const presenter = window.app.map.slideShowPresenter;
      const slide = presenter._presentationInfo?.slides?.[slideIndex];
      if (!slide) throw new Error("slideshow_slide_metadata_missing");
      const animationNodes = [];
      const visit = (value) => {
        if (!value || typeof value !== "object") return;
        if (!Array.isArray(value)) animationNodes.push(value);
        for (const child of Object.values(value))
          if (child && typeof child === "object") visit(child);
      };
      visit(slide.animations?.root);
      const probe = window.__presentPlaybackProbe;
      probe.presentationInfo = {
        transition: {
          type: slide.transitionType ?? null,
          subtype: slide.transitionSubtype ?? null,
          direction: slide.transitionDirection ?? null,
          durationMilliseconds: slide.transitionDuration ?? 0,
        },
        animation: {
          present: Boolean(slide.animations?.root),
          presets: [
            ...new Set(
              animationNodes
                .map((node) => node.presetId)
                .filter((value) => typeof value === "string" && value),
            ),
          ],
          durations: [
            ...new Set(
              animationNodes
                .map((node) => node.dur)
                .filter((value) => typeof value === "string" && value),
            ),
          ],
        },
        interactions: (slide.interactions ?? []).map((interaction) => ({
          bounds: interaction.bounds,
          clickAction: interaction.clickAction ?? null,
        })),
      };
      const canvas = presenter.getCanvas();
      probe.canvas = { width: canvas?.width ?? 0, height: canvas?.height ?? 0 };
      probe.ready = true;
    }, expectation);

    if (expectation.kind === "animation") {
      const canvas = frame
        .frameLocator("#slideshow-cypress-iframe")
        .locator("#slideshow-canvas");
      const frameHashes = new Set();
      let frameSamples = 0;
      const captureCompositedFrame = async () => {
        const png = await canvas.screenshot();
        frameSamples += 1;
        frameHashes.add(createHash("sha256").update(png).digest("hex"));
      };
      await captureCompositedFrame();
      await frame.evaluate(() => {
        const presenter = window.app.map.slideShowPresenter;
        const canvas = presenter.getCanvas();
        canvas.dispatchEvent(
          new canvas.ownerDocument.defaultView.MouseEvent("click", {
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      const sampleForMs = Math.min(
        expectation.timeoutMs,
        Math.max(700, (expectation.durationSeconds ?? 1) * 1_000 + 300),
      );
      const samplingDeadline = Date.now() + sampleForMs;
      do {
        await wait(40);
        await captureCompositedFrame();
      } while (Date.now() < samplingDeadline);
      await waitForProbe(
        frame,
        (state) => state.animation.started && state.animation.ended,
        expectation.timeoutMs,
        "Edited animation did not complete in the web player.",
      );
      await captureCompositedFrame();
      await frame.evaluate(
        (animationEvidence) => {
          Object.assign(
            window.__presentPlaybackProbe.animation,
            animationEvidence,
          );
        },
        {
          frameSamples,
          frameFingerprints: frameHashes.size,
          frameHashes: [...frameHashes],
        },
      );
    } else if (expectation.kind === "interaction") {
      const interaction = await frame.evaluate(({ action }) => {
        const presenter = window.app.map.slideShowPresenter;
        const navigator = presenter._slideShowNavigator;
        const slide =
          presenter._presentationInfo?.slides?.[navigator.currentSlideIndex];
        const match = slide?.interactions?.find(
          (candidate) => candidate.clickAction?.action === action,
        );
        if (!match?.bounds)
          throw new Error("slideshow_interaction_metadata_missing");
        const executed = navigator.tryExecuteInteractionAt(
          match.bounds.x + match.bounds.width / 2,
          match.bounds.y + match.bounds.height / 2,
        );
        return { executed };
      }, expectation);
      if (!interaction.executed)
        throw new Error("The web player rejected the click interaction.");
      const deadline = Date.now() + expectation.timeoutMs;
      let targetSlideIndex = null;
      do {
        targetSlideIndex = await frame
          .evaluate(
            () =>
              window.app.map.slideShowPresenter._slideShowNavigator
                .currentSlideIndex,
          )
          .catch(() => null);
        if (targetSlideIndex === expectation.targetSlideIndex) break;
        await wait(40);
      } while (Date.now() < deadline);
      await frame.evaluate(
        (value) => {
          Object.assign(window.__presentPlaybackProbe.interaction, value);
        },
        { executed: true, targetSlideIndex },
      );
      if (targetSlideIndex === expectation.targetSlideIndex)
        await waitForProbe(
          frame,
          (state) => state.interaction.targetRendered,
          expectation.timeoutMs,
          "The interaction target slide did not finish rendering.",
        );
    }

    const evidence = await frame.evaluate(() => {
      const probe = window.__presentPlaybackProbe;
      return {
        kind: probe.kind,
        slideIndex: probe.slideIndex,
        presentationInfo: probe.presentationInfo,
        canvas: probe.canvas,
        transition: probe.transition,
        animation: {
          started: probe.animation.started,
          ended: probe.animation.ended,
          frameSamples: probe.animation.frameSamples ?? 0,
          frameFingerprints: probe.animation.frameFingerprints ?? 0,
          frameHashes: probe.animation.frameHashes ?? [],
        },
        interaction: probe.interaction,
      };
    });
    return validatePlaybackEvidence(evidence, expectation);
  } finally {
    await frame
      .evaluate(() => {
        const probe = window.__presentPlaybackProbe;
        if (probe?.restore)
          for (const restore of [...probe.restore].reverse()) restore();
        const presenter = window.app?.map?.slideShowPresenter;
        if (presenter?.getCanvas()) presenter.endPresentation(true);
        delete window.__presentPlaybackProbe;
      })
      .catch(() => {});
  }
}
