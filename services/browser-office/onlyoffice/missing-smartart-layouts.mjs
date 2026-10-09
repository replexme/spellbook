/* SPDX-License-Identifier: AGPL-3.0-only */
// The pinned SDK has algorithms for vList5/hList1, but excludes them from
// generation. Restore only missing drawing caches; retain every authored cache.
// Recovered native diagrams must also survive clone, export and cold readback.
export function installOnlyOfficeMissingSmartArtLayouts(paragraphFormat) {
  const key = Symbol.for("spellbook.onlyoffice.missingSmartArtLayouts/v1");
  if (globalThis[key]) return;
  const format = globalThis.AscFormat;
  if (
    typeof format?.CBodyPr?.prototype?.setDefault !== "function" ||
    typeof format?.SmartArt?.prototype?.isCanGenerateSmartArt !== "function" ||
    typeof format?.SmartArt?.prototype?.copy2 !== "function" ||
    typeof format?.SmartArt?.prototype?.recalculate !== "function" ||
    typeof format?.TextAlgorithm?.prototype?.applyTxXfrmSettings !==
      "function" ||
    typeof format?.ExecuteNoHistory !== "function" ||
    typeof paragraphFormat !== "function"
  )
    throw Error("onlyoffice_missing_smartart_layouts_sdk_unavailable");
  const body = format.CBodyPr.prototype;
  const setDefault = body.setDefault;
  body.setDefault = function (...args) {
    const result = setDefault.apply(this, args);
    if (this.spcCol === false) this.spcCol = 0;
    return result;
  };
  const prototype = format.SmartArt.prototype;
  const recovered = new WeakSet();
  const original = prototype.isCanGenerateSmartArt;
  prototype.isCanGenerateSmartArt = function () {
    const type = this.getTypeOfSmartArt();
    if (
      (type === 7 || type === 29) &&
      this.drawing &&
      Array.isArray(this.drawing.spTree)
    ) {
      if (recovered.has(this)) return true;
      if (this.drawing.spTree.length === 0) {
        recovered.add(this);
        return true;
      }
    }
    return original.call(this);
  };
  const text = format.TextAlgorithm.prototype;
  const copy = prototype.copy2;
  prototype.copy2 = function (target, ...args) {
    const result = copy.call(this, target, ...args);
    if (recovered.has(this)) recovered.add(target);
    return result;
  };
  // Font fitting runs after node generation and writes fractional spacing.
  // Use the shared writer-representable values before observing or exporting.
  const recalculate = prototype.recalculate;
  prototype.recalculate = function (...args) {
    const result = recalculate.apply(this, args);
    if (!recovered.has(this)) return result;
    format.ExecuteNoHistory(
      function () {
        const visit = (shape) => {
          if (!shape) return;
          for (const paragraph of shape.txBody?.content?.Content ?? []) {
            const spacing = paragraph.Pr?.Spacing;
            if (!spacing) continue;
            const values = {};
            if (Number.isFinite(spacing.Before))
              values.topMargin = spacing.Before * 100;
            if (Number.isFinite(spacing.After))
              values.bottomMargin = spacing.After * 100;
            const patch = paragraphFormat(values).spacing;
            if (Object.keys(patch).length) paragraph.Set_Spacing(patch, false);
          }
          for (const child of shape.spTree ?? []) visit(child);
        };
        visit(this.drawing);
      },
      this,
      [],
    );
    return result;
  };
  // Explicit point bounds are already merged into the generated native shape.
  // Text must use those same bounds rather than the algorithm's old shadow box.
  const apply = text.applyTxXfrmSettings;
  text.applyTxXfrmSettings = function (shape, contentShadowShape) {
    const authored =
      shape.getSmartArtInfo()?.contentPoint?.[0]?.point?.spPr?.xfrm;
    const transform = shape.spPr?.xfrm;
    const shadow = this.parentNode.getShape();
    if (
      !authored ||
      !(authored.extX > 0 && authored.extY > 0) ||
      contentShadowShape ||
      !transform ||
      ![transform.offX, transform.offY, transform.extX, transform.extY].every(
        Number.isFinite,
      ) ||
      transform.extX <= 0 ||
      transform.extY <= 0
    )
      return apply.call(this, shape, contentShadowShape);
    const saved = {
      x: shadow.x,
      y: shadow.y,
      width: shadow.width,
      height: shadow.height,
      rot: shadow.rot,
    };
    try {
      Object.assign(shadow, {
        x: transform.offX,
        y: transform.offY,
        width: transform.extX,
        height: transform.extY,
        rot: transform.rot ?? 0,
      });
      return apply.call(this, shape, contentShadowShape);
    } finally {
      Object.assign(shadow, saved);
    }
  };
  globalThis[key] = true;
}
