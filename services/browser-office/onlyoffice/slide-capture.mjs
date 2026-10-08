/* SPDX-License-Identifier: MPL-2.0 */
// One drawing path for AI review, browser previews and server previews.
// This draws the live native slide; it does not reconstruct PPTX in HTML.
export function captureOnlyOfficeSlide(slideIndex, width = 1280) {
  const model = window.Asc?.editor?.WordControl?.m_oLogicDocument;
  if (!Number.isSafeInteger(slideIndex) || !model?.Slides[slideIndex])
    throw Error("slide_invalid");
  if (!Number.isSafeInteger(width) || width < 64 || width > 4096)
    throw Error("capture_width_invalid");
  const slide = model.Slides[slideIndex],
    canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = Math.round((width * slide.Height) / slide.Width);
  if (
    !Number.isSafeInteger(canvas.height) ||
    canvas.height < 1 ||
    canvas.width * canvas.height > 16777216
  )
    throw Error("capture_dimensions_invalid");
  const graphics = new AscCommon.CGraphics();
  graphics.init(
    canvas.getContext("2d"),
    canvas.width,
    canvas.height,
    slide.Width,
    slide.Height,
  );
  graphics.m_oFontManager = AscCommon.g_fontManager;
  graphics.transform(1, 0, 0, 1, 0, 0);
  const previous = AscCommon.IsShapeToImageConverter;
  try {
    AscCommon.IsShapeToImageConverter = true;
    slide.draw(graphics);
    return {
      slideIndex,
      width: canvas.width,
      height: canvas.height,
      pngBase64: canvas.toDataURL("image/png").split(",")[1],
    };
  } finally {
    AscCommon.IsShapeToImageConverter = previous;
  }
}
