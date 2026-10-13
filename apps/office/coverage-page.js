// Runs every operation the document view supports once against the open
// deck (in the check host page; see check.mjs --coverage). Each result is
// {op, ok, error?, detail?}; an op whose target the deck lacks is skipped.
window.runCoverage = async function runCoverage() {
  const { request } = window.check;
  const contract = await (await fetch("native-edit-capabilities.json")).json();
  const blank = Object.fromEntries(Object.keys(contract.toolInputSchema.properties).map((k) => [k, null]));
  const permission = { mode: "document", slideIndexes: [], elementIds: [] };
  let obs = await request({ operation: "observe", detailSlideIndex: null });
  const results = [];
  const all = () => obs.slides.flatMap((s) => s.elements.flatMap((e) => [e, ...(e.elements ?? [])]));
  const top = () => obs.slides.flatMap((s) => s.elements);
  const find = (test) => all().find(test);
  const slideOf = (id) => Number(id.split("/")[0]);
  const observeSlide = async (i) => (obs = await request({ operation: "observe", detailSlideIndex: i }));
  const run = async (op, args, extra = {}) => {
    try {
      const command = { ...blank, op, ...args };
      const r = await request({ operation: "edit", expectedRevision: obs.revision, expectedSlides: JSON.stringify(obs.slides), permission, command, ...extra });
      obs = r;
      results.push({ op, ok: true, changed: r.changedSlideIndexes });
      return r;
    } catch (e) {
      results.push({ op, ok: false, error: e.message.slice(0, 300) });
      return null;
    }
  };
  const skip = (op, why) => results.push({ op, ok: null, skipped: why });
  const asset = async (id, bytes, mediaType) => {
    await request({ operation: "register_asset", assetId: id, assetBytes: bytes, mediaType }, [bytes]);
  };
  const png = () => Uint8Array.from(atob(obs.images[0].pngBase64), (c) => c.charCodeAt(0)).buffer;
  const wav = () => {
    const n = 8000, b = new ArrayBuffer(44 + n), v = new DataView(b);
    const s = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    s(0, "RIFF"); v.setUint32(4, 36 + n, true); s(8, "WAVE"); s(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); s(36, "data"); v.setUint32(40, n, true);
    for (let i = 0; i < n; i++) v.setUint8(44 + i, 128 + Math.round(60 * Math.sin(i / 8)));
    return b;
  };
  const text = () => find((e) => e.text && e.text.trim().length >= 3 && !e.elements && e.kind !== "table");
  const shape = () => find((e) => e.kind === "shape" && !e.elements) ?? find((e) => e.kind === "text");

  // Slides and document.
  await run("rename_slide", { slideIndex: 0, name: "첫 쪽" });
  await run("set_slide_hidden", { slideIndex: obs.slides.length - 1, hidden: true });
  await run("set_slide_hidden", { slideIndex: obs.slides.length - 1, hidden: false });
  await run("set_speaker_notes", { slideIndex: 0, text: "발표 메모\n둘째 줄" });
  await run("set_background", { slideIndex: 0, color: 0xf5f5f0 });
  await run("set_slide_transition", { slideIndex: 0, transitionEffect: "push-from-right", transitionDuration: 0.7 });
  await run("set_slide_layout", { slideIndex: 1, masterIndex: obs.slides[1].masterIndex ?? 0, layout: obs.masters[obs.slides[1].masterIndex ?? 0].layouts.length > 1 ? 1 : 0 });
  await run("insert_slide", { slideIndex: 0, masterIndex: 0, layout: 0, name: "새 쪽" });
  await run("duplicate_slide", { slideIndex: 1 });
  await run("move_slide", { slideIndex: 2, targetSlideIndex: 0 });
  await run("delete_slide", { slideIndex: 0 });
  await run("delete_slide", { slideIndex: 0 });
  const uuid = () => `{${crypto.randomUUID().toUpperCase()}}`;
  await run("set_sections", { sections: [{ id: uuid(), name: "앞부분", startSlideIndex: 0 }, ...(obs.slides.length > 2 ? [{ id: uuid(), name: "뒷부분", startSlideIndex: 2 }] : [])] });
  await run("set_master_theme", { masterIndex: 0, theme: { name: "검증", colorSchemeName: "검증", colors: [0, 0xffffff, 0x1f2937, 0xf3f4f6, 0x2563eb, 0xdc2626, 0x16a34a, 0xf59e0b, 0x7c3aed, 0x0891b2, 0x2563eb, 0x7c3aed], fontSchemeName: "검증", majorLatin: "Arial", majorAsian: "맑은 고딕", majorComplex: "Arial", minorLatin: "Arial", minorAsian: "맑은 고딕", minorComplex: "Arial" } });
  const w = obs.width, h = obs.height;
  await run("set_slide_size", { width: w, height: h, scaleContent: false });

  // Creation on slide 0.
  await run("add_text_box", { slideIndex: 0, x: 1000, y: 1000, width: 9000, height: 2000, text: "검증 상자\n둘째 문단입니다", name: "검증 상자" });
  await run("add_shape", { slideIndex: 0, x: 11000, y: 1000, width: 3000, height: 3000, geometry: "ellipse", color: 0x2563eb, name: "검증 원" });
  await run("add_shape", { slideIndex: 0, x: 15000, y: 1000, width: 3000, height: 3000, geometry: "rectangle", color: 0x16a34a, name: "검증 사각" });
  await run("add_connector", { slideIndex: 0, x: 1000, y: 4000, width: 6000, height: 2000, connectorKind: "straight", color: 0x111111, name: "검증 연결선" });
  await run("add_freeform", { slideIndex: 0, x: 8000, y: 5000, width: 3000, height: 2000, points: [{ x: 0, y: 0 }, { x: 3000, y: 0 }, { x: 1500, y: 2000 }], closed: true, color: 0xf59e0b, name: "검증 자유형" });
  await run("add_table", { slideIndex: 0, x: 1000, y: 8000, width: 12000, height: 3000, cells: [["가", "나", "다"], ["1", "2", "3"]], name: "검증 표" });
  const named = (n) => obs.slides[0].elements.find((e) => e.objectName === n);
  const box = named("검증 상자"), circle = named("검증 원"), rect = named("검증 사각"), conn = named("검증 연결선"), table = named("검증 표");
  results.push({ op: "(named creations found)", ok: !!(box && circle && rect && conn && table), detail: [box, circle, rect, conn, table].map((e) => e?.elementId ?? null) });

  // Text and character format on the new box.
  if (box) {
    const id = () => named("검증 상자").elementId;
    await run("replace_text", { elementId: id(), text: "바뀐 상자 글\n둘째 문단입니다" });
    await run("font_size", { elementId: id(), size: 20 });
    for (const op of ["bold", "italic", "underline", "strikethrough"]) await run(op, { elementId: id(), [op]: true });
    await run("strikethrough", { elementId: id(), strikethrough: false });
    await run("font_family", { elementId: id(), family: "Arial" });
    await run("font_color", { elementId: id(), color: 0x1f2937 });
    await run("text_shadow", { elementId: id(), shadow: true, color: 0, shadowOffsetX: 100, shadowOffsetY: 100, shadowBlur: 100, opacity: 40 });
    await run("paragraph_alignment", { elementId: id(), alignment: "center" });
    await run("set_character_spacing", { elementId: id(), spacing: 1 });
    await run("set_text_language", { elementId: id(), languageTag: "ko-KR" });
    await run("set_text_case", { elementId: id(), textCase: "uppercase" });
    await run("set_script_position", { elementId: id(), script: "superscript" });
    await run("set_script_position", { elementId: id(), script: "normal" });
    await run("text_autofit", { elementId: id(), autofit: true });
    await run("set_text_box", { elementId: id(), marginLeft: 254, marginRight: 254, marginTop: 127, marginBottom: 127, autoGrowHeight: true, autoGrowWidth: false, wordWrap: true });
    await observeSlide(0);
    const d = obs.textDetails.elements.find((e) => e.elementId === id());
    const p = d.paragraphs[1];
    await run("set_paragraph_format", { elementId: id(), paragraphId: p.paragraphId, paragraphFormat: { leftMargin: 500, rightMargin: null, firstLineIndent: null, topMargin: 200, bottomMargin: null, direction: null } });
    await run("set_paragraph_list", { elementId: id(), paragraphId: p.paragraphId, paragraphList: { type: "bullet", level: 0, prefix: "", suffix: "", startWith: 1, bulletCharacter: "•" } });
    await observeSlide(0);
    const d2 = obs.textDetails.elements.find((e) => e.elementId === id());
    const p2 = d2.paragraphs[0];
    await run("replace_text_range", { elementId: id(), paragraphId: p2.paragraphId, startOffset: p2.startOffset, endOffset: p2.startOffset + 2, expectedText: p2.text.slice(0, 2), text: "새" });
    await run("set_fontwork", { elementId: id(), fontwork: { preset: "textArchUp" } });
    await run("set_fontwork", { elementId: id(), fontwork: { preset: null } });
  } else skip("text ops", "box missing");

  // Shape format, geometry, order.
  if (circle) {
    const id = () => named("검증 원").elementId;
    await run("fill_color", { elementId: id(), color: 0xdc2626 });
    await run("set_shape_fill", { elementId: id(), shapeFill: { type: "solid", color: 0x7c3aed, opacity: 80, catalogName: null } });
    await run("fill_opacity", { elementId: id(), opacity: 70 });
    await run("line_color", { elementId: id(), color: 0x111111 });
    await run("line_width", { elementId: id(), size: 1 });
    await run("line_opacity", { elementId: id(), opacity: 90 });
    await run("set_line_style", { elementId: id(), lineStyle: { dash: "dash", startArrow: null, endArrow: null } });
    await run("set_shape_shadow", { elementId: id(), shadow: true, color: 0, shadowOffsetX: 150, shadowOffsetY: 150, shadowBlur: 200, opacity: 35 });
    await run("set_shape_effects", { elementId: id(), shapeEffects: { glowRadius: 300, glowColor: 0xf59e0b, glowOpacity: 60, softEdgeRadius: null } });
    await run("move", { elementId: id(), x: 12000, y: 1500 });
    await run("resize", { elementId: id(), width: 3500, height: 3500 });
    await run("rotate", { elementId: id(), degrees: 20 });
    await run("flip", { elementId: id(), axis: "horizontal" });
    await run("z_order", { elementId: id(), position: "back" });
    await run("set_alt_text", { elementId: id(), title: null, description: "보라색 원", decorative: false });
    await run("set_shape_name", { elementId: id(), name: "검증 원" });
    await run("set_object_lock", { elementId: id(), lockPosition: true, lockSize: null, printable: null });
    await run("set_object_lock", { elementId: id(), lockPosition: false, lockSize: null, printable: null });
    await run("set_object_interaction", { elementId: id(), interaction: "next_slide", url: null, description: null, targetSlideIndex: null });
    await run("duplicate_element", { elementId: id(), name: "검증 원 복사", x: 16000, y: 5000 });
    const copy = named("검증 원 복사");
    if (copy) await run("delete_element", { elementId: copy.elementId });
    else skip("delete_element", "copy missing");
  } else skip("shape ops", "circle missing");

  if (circle && rect && box) {
    const ids = () => [named("검증 원").elementId, named("검증 사각").elementId];
    await run("align", { elementIds: ids(), alignment: "top" });
    await run("distribute", { elementIds: [named("검증 상자").elementId, ...ids()], axis: "horizontal" });
    await run("set_reading_order", { elementIds: obs.slides[0].elements.map((e) => e.elementId).reverse() });
    await run("group", { elementIds: ids() });
    const group = obs.slides[0].elements.find((e) => e.kind === "group" && e.elements?.some((c) => c.objectName === "검증 원"));
    if (group) await run("ungroup", { elementId: group.elementId });
    else skip("ungroup", "group missing");
  }
  if (conn && circle && rect) {
    await run("set_connector", { elementId: named("검증 연결선").elementId, connector: { kind: "standard", start: { x: 0, y: 0 }, end: { x: 0, y: 0 }, startElementId: named("검증 원").elementId, endElementId: named("검증 사각").elementId, startGluePoint: null, endGluePoint: null } });
  }

  // Tables.
  if (table) {
    const id = () => named("검증 표").elementId;
    await run("set_table_cell", { elementId: id(), row: 0, column: 0, text: "첫 칸" });
    await run("insert_table_rows", { elementId: id(), index: 1, count: 1 });
    await run("insert_table_columns", { elementId: id(), index: 1, count: 1 });
    await run("delete_table_columns", { elementId: id(), index: 1, count: 1 });
    await run("delete_table_rows", { elementId: id(), index: 1, count: 1 });
    await run("set_table_row_height", { elementId: id(), index: 0, height: 1200 });
    await run("set_table_column_width", { elementId: id(), index: 0, width: 5000 });
    const border = { color: 0x111111, width: 100 };
    await run("set_table_cell_format", { elementId: id(), row: 0, column: 0, tableCellFormat: { fillColor: 0xfde68a, fillOpacity: null, fontColor: null, fontSize: null, fontFamily: null, bold: null, underline: null, strikethrough: null, textShadow: null, characterSpacing: null, paragraphAlignment: null, marginLeft: 100, marginRight: 100, marginTop: 50, marginBottom: 50, borderTop: border, borderRight: border, borderBottom: border, borderLeft: border } });
    await run("merge_table_cells", { elementId: id(), startRow: 0, endRow: 0, startColumn: 0, endColumn: 1 });
    await run("split_table_cell", { elementId: id(), row: 0, column: 0, rows: 1, columns: 1 });
  }

  // Charts.
  const chart = find((e) => e.chart);
  if (chart) {
    const id = chart.elementId;
    await run("set_chart_data", { elementId: id, data: chart.chart.data.map((r) => r.map((v) => (v ?? 0) + 1)), rowDescriptions: null, columnDescriptions: null });
    await run("set_chart_format", { elementId: id, chartFormat: { title: "검증 차트", legendVisible: true, legendPosition: "bottom", categoryAxisVisible: null, valueAxisVisible: null, showValues: true, showCategoryNames: null, showSeriesNames: null, seriesColors: null } });
    await run("set_chart_type", { elementId: id, chartType: "line" });
  } else ["set_chart_data", "set_chart_format", "set_chart_type"].forEach((op) => skip(op, "no chart"));

  // SmartArt.
  const smart = find((e) => e.smartartNodes?.length);
  if (smart) {
    const n = smart.smartartNodes[0];
    await run("set_smartart_node", { elementId: smart.elementId, smartartNode: { expectedText: n.text, occurrence: n.occurrence, text: n.text + " 수정" } });
    await run("add_smartart_node", { elementId: smart.elementId, smartartNode: { expectedText: null, occurrence: 0, text: "새 항목" } });
    await run("delete_smartart_node", { elementId: smart.elementId, smartartNode: { expectedText: "새 항목", occurrence: 0, text: null } });
  } else ["set_smartart_node", "add_smartart_node", "delete_smartart_node"].forEach((op) => skip(op, "no SmartArt"));

  // Pictures and media (assets transferred like the web app does).
  await observeSlide(0);
  await asset("asset-png", png(), "image/png");
  await run("insert_image", { slideIndex: 0, assetId: "asset-png", x: 20000, y: 8000, width: 4000, height: 2250, name: "검증 그림" });
  const pic = named("검증 그림") ?? find((e) => e.kind === "image");
  if (pic) {
    await run("crop_image", { elementId: pic.elementId, left: 0.1, top: 0, right: 0.1, bottom: 0, geometry: "rectangle" });
    await asset("asset-png-2", png(), "image/png");
    await run("replace_image", { elementId: pic.elementId, assetId: "asset-png-2" });
  }
  await asset("asset-wav", wav(), "audio/wav");
  await run("insert_media", { slideIndex: 0, assetId: "asset-wav", x: 26000, y: 1000, width: 1500, height: 1500, name: "검증 소리" });
  const media = named("검증 소리") ?? find((e) => e.kind === "audio" || e.kind === "video");
  if (media) {
    await asset("asset-wav-2", wav(), "audio/wav");
    await run("replace_media", { elementId: media.elementId, assetId: "asset-wav-2" });
  }

  // Animations on the new box.
  if (box) {
    const id = () => named("검증 상자")?.elementId ?? box.elementId;
    await run("add_animation_effect", { elementId: id(), presetId: "ooo-entrance-fade", duration: 0.6, delay: 0, start: "on-click" });
    await run("add_animation_effect", { elementId: id(), presetId: "ooo-emphasis-spin", duration: 1, delay: 0, start: "after-previous" });
    const anims = () => obs.slides[slideOf(id())].animations ?? [];
    const first = anims().find((a) => a.elementId === id());
    if (first) {
      await run("set_animation_timing", { elementId: id(), animationId: first.animationId, duration: 0.8, delay: 0.2, start: "with-previous" });
      const last = anims().filter((a) => a.elementId === id()).at(-1);
      await run("move_animation_effect", { elementId: id(), animationId: last.animationId, animationIndex: 0 });
      const again = anims().find((a) => a.elementId === id());
      await run("replace_animation_effect", { elementId: id(), animationId: again.animationId, presetId: "ooo-entrance-wipe" });
      const rm = anims().find((a) => a.elementId === id());
      await run("remove_animation_effect", { elementId: id(), animationId: rm.animationId });
    } else skip("animation timing", "added animation not observed");
  }

  // Comments.
  await run("add_comment", { slideIndex: 0, text: "검증 메모", author: "AI", initials: "AI", x: 1000, y: 1000 });
  const comments = () => obs.slides[0].comments ?? [];
  if (comments().length) {
    await run("edit_comment", { slideIndex: 0, commentIndex: comments().length - 1, text: "고친 메모", author: "AI" });
    await run("delete_comment", { slideIndex: 0, commentIndex: comments().length - 1 });
  }

  // Existing content of the deck.
  const t = text();
  if (t) await run("replace_text", { elementId: t.elementId, text: t.text + " (확인)" });
  return results;
};
