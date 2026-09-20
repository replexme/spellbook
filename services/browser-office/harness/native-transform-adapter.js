/* SPDX-License-Identifier: MPL-2.0 */

"use strict";

(function installBrowserNativeTransformAdapter(global) {
  const mutationContracts = global.spellbookMutationContracts;
  if (!mutationContracts || typeof mutationContracts !== "object")
    throw new Error("Browser native mutation contract is unavailable.");
  // Format-excluded operations are never offered; operations the contract
  // marks unavailable in the browser runtime (for example media, whose avmedia
  // module the WASM build compiles out) are not advertised by this engine.
  const candidateOperations = Object.freeze(
    Object.entries(mutationContracts)
      .filter(
        ([, contract]) =>
          contract.availability !== "format_excluded" &&
          !(contract.unavailableIn ?? []).includes("browser"),
      )
      .map(([operation]) => operation),
  );

  const objectPropertyTypes = Object.freeze({
    Name: "string",
    Title: "string",
    Description: "string",
    Decorative: "boolean",
    TextLeftDistance: "long",
    TextRightDistance: "long",
    TextUpperDistance: "long",
    TextLowerDistance: "long",
    TextAutoGrowHeight: "boolean",
    TextAutoGrowWidth: "boolean",
    TextWordWrap: "boolean",
    Shadow: "boolean",
    ShadowColor: "long",
    ShadowTransparence: "short",
    ShadowXDistance: "long",
    ShadowYDistance: "long",
    ShadowBlur: "long",
    MoveProtect: "boolean",
    SizeProtect: "boolean",
    LineColor: "long",
    LineWidth: "long",
    FillTransparence: "short",
    LineTransparence: "short",
    RotateAngle: "long",
    LineStyle: "line-style",
    FillColor: "long",
    FillGradientName: "string",
    FillHatchName: "string",
    FillStyle: "fill-style",
    GlowEffectRadius: "long",
    GlowEffectColor: "long",
    GlowEffectTransparency: "short",
    SoftEdgeRadius: "long",
    Loop: "boolean",
    Mute: "boolean",
    VolumeDB: "short",
    Zoom: "media-zoom",
    FontWorkStyle: "long",
    FontWorkAdjust: "long",
    FontWorkDistance: "long",
    FontWorkStart: "long",
    FontWorkMirror: "boolean",
    FontWorkOutline: "boolean",
    D3DMaterialColor: "long",
    D3DMaterialEmission: "long",
    D3DMaterialSpecular: "long",
    D3DMaterialSpecularIntensity: "short",
    D3DDoubleSided: "boolean",
    NavigationOrder: "long",
  });

  function createSpellbookBrowserNativeAdapter({ uno, runtimeIdentity }) {
    if (!uno?.Any || !uno?.type || !uno?.idl)
      throw new Error("Browser UNO bridge is unavailable.");
    const admitted =
      global.spellbookBrowserRuntimeAdmitted?.(runtimeIdentity) === true;
    const nativeSlideStructureReady =
      admitted && runtimeIdentity.nativeSlideStructureReady === true;
    const supportedOperations = Object.freeze(
      admitted ? [...candidateOperations] : [],
    );

    const any = (typeName, value) => new uno.Any(uno.type[typeName], value);
    const propertyValue = (name, typeName, value) =>
      new uno.idl.com.sun.star.beans.PropertyValue({
        Name: name,
        Value: new uno.Any(
          typeof typeName === "string" ? uno.type[typeName] : typeName,
          value,
        ),
      });
    const propertySequence = (entries) =>
      new uno.Any(
        uno.type.sequence(
          uno.type.struct(uno.idl.com.sun.star.beans.PropertyValue),
        ),
        entries,
      );
    const assertSingleEntry = (command) => {
      const entries = Object.entries(command ?? {});
      if (entries.length !== 1)
        throw new Error("Browser native transform must contain one command.");
      return entries[0];
    };
    const assertIndex = (value, maximum, label) => {
      if (!Number.isSafeInteger(value) || value < 0 || value >= maximum)
        throw new Error(`${label} is out of range.`);
      return value;
    };
    const assertRecord = (value, label) => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`${label} must be an object.`);
      return value;
    };
    const assertExactKeys = (value, allowed, label) => {
      const keys = Object.keys(value);
      if (keys.some((key) => !allowed.includes(key)))
        throw new Error(`${label} contains an unsupported field.`);
      return keys;
    };
    const parsePath = (suffix, label) => {
      if (!/^\d+(?:\/\d+)*$/u.test(suffix))
        throw new Error(`${label} has an invalid object path.`);
      return suffix.split("/").map(Number);
    };
    const resolveShape = (page, path, label) => {
      let shape = page;
      for (const index of path) {
        if (typeof shape.getCount !== "function")
          throw new Error(`${label} does not resolve to a shape collection.`);
        assertIndex(index, shape.getCount(), label);
        shape = shape.getByIndex(index);
      }
      return shape;
    };
    const propertyWrite = (target, name, typeName, value) => () =>
      target.setPropertyValue(name, any(typeName, value));
    const selectAllText = (shape, label) => {
      if (
        typeof shape.createTextCursor !== "function" ||
        typeof shape.getString !== "function"
      )
        throw new Error(`${label} has no editable text.`);
      const cursor = shape.createTextCursor();
      cursor.gotoStart(false);
      cursor.gotoEnd(true);
      return cursor;
    };
    const moveCursorRight = (cursor, count, expand, label) => {
      let remaining = count;
      while (remaining > 0) {
        const step = Math.min(remaining, 32767);
        if (!cursor.goRight(step, expand))
          throw new Error(`${label} is unavailable.`);
        remaining -= step;
      }
    };

    const registry = [
      {
        match: (key) => key === "JumpToSlide",
        prepare: ({ value, controller, pages, state }) => {
          const slideIndex = assertIndex(
            value,
            pages.getCount(),
            "Browser native slide target",
          );
          const page = pages.getByIndex(slideIndex);
          state.currentPage = page;
          return {
            mutates: false,
            apply: () => controller.setCurrentPage(page),
          };
        },
      },
      {
        match: (key) => key === "DuplicateSlide",
        prepare: ({ value, controller, pages, dispatch }) => {
          const slideIndex = assertIndex(
            value,
            pages.getCount(),
            "Browser duplicate slide target",
          );
          return {
            mutates: true,
            apply: () => {
              controller.setCurrentPage(pages.getByIndex(slideIndex));
              dispatch(".uno:DuplicatePage");
            },
          };
        },
      },
      {
        match: (key) => key === "InsertMasterSlide",
        prepare: ({ value, controller, dispatch, model, pages, state }) => {
          const masterPages = model.getMasterPages();
          const masterIndex = assertIndex(
            value,
            masterPages.getCount(),
            "Browser insert slide master",
          );
          const sourcePage = state.currentPage;
          let sourceIndex = -1;
          for (let index = 0; index < pages.getCount(); index += 1) {
            if (uno.sameUnoObject(sourcePage, pages.getByIndex(index))) {
              sourceIndex = index;
              break;
            }
          }
          if (sourceIndex < 0)
            throw new Error("Browser insert slide source is unavailable.");
          const masterPage = masterPages.getByIndex(masterIndex);
          return {
            mutates: true,
            apply: () => {
              controller.setCurrentPage(sourcePage);
              dispatch(".uno:InsertPage");
              if (pages.getCount() <= sourceIndex + 1)
                throw new Error(
                  "Browser slide insertion did not create a page.",
                );
              const insertedPage = pages.getByIndex(sourceIndex + 1);
              if (typeof insertedPage.setMasterPage === "function")
                insertedPage.setMasterPage(masterPage);
              controller.setCurrentPage(insertedPage);
            },
          };
        },
      },
      {
        match: (key) => key === "DeleteSlide",
        prepare: ({ value, controller, pages }) => {
          const slideIndex = assertIndex(
            value,
            pages.getCount(),
            "Browser delete slide target",
          );
          if (pages.getCount() === 1)
            throw new Error("The final browser slide cannot be deleted.");
          const targetPage = pages.getByIndex(slideIndex);
          const survivingPage = pages.getByIndex(
            slideIndex + 1 < pages.getCount() ? slideIndex + 1 : slideIndex - 1,
          );
          return {
            mutates: true,
            nativeUndoManaged: true,
            apply: () => {
              controller.setCurrentPage(survivingPage);
              pages.remove(targetPage);
            },
          };
        },
      },
      {
        match: (key) => key.startsWith("MoveSlide."),
        prepare: ({ key, value, controller, pages, dispatch }) => {
          const sourceIndex = assertIndex(
            Number(key.slice("MoveSlide.".length)),
            pages.getCount(),
            "Browser move slide source",
          );
          const targetIndex = assertIndex(
            value,
            pages.getCount(),
            "Browser move slide destination",
          );
          return {
            mutates: sourceIndex !== targetIndex,
            apply: () => {
              controller.setCurrentPage(pages.getByIndex(sourceIndex));
              const command =
                targetIndex < sourceIndex
                  ? ".uno:MovePageUp"
                  : ".uno:MovePageDown";
              for (
                let step = 0;
                step < Math.abs(targetIndex - sourceIndex);
                step += 1
              )
                dispatch(command);
            },
          };
        },
      },
      {
        match: (key) => key === "RenameSlide",
        prepare: ({ value, state }) => {
          if (typeof value !== "string" || !value.trim())
            throw new Error("Browser slide name is invalid.");
          const page = state.currentPage;
          return { mutates: true, apply: () => page.setName(value) };
        },
      },
      {
        match: (key) => key === "SetSlideVisible",
        prepare: ({ value, state }) => {
          if (typeof value !== "boolean")
            throw new Error("Browser slide visibility is invalid.");
          const page = state.currentPage;
          return {
            mutates: true,
            apply: propertyWrite(page, "Visible", "boolean", value),
          };
        },
      },
      {
        match: (key) => key === "ChangeLayout",
        prepare: ({ value, model, state }) => {
          const layout = assertRecord(value, "Browser slide layout");
          assertExactKeys(
            layout,
            ["MasterIndex", "Layout"],
            "Browser slide layout",
          );
          const masterPages = model.getMasterPages();
          const masterIndex = assertIndex(
            layout.MasterIndex,
            masterPages.getCount(),
            "Browser slide layout master",
          );
          if (!Number.isSafeInteger(layout.Layout))
            throw new Error("Browser slide layout is invalid.");
          const page = state.currentPage;
          const master = masterPages.getByIndex(masterIndex);
          return {
            mutates: true,
            apply: () => {
              if (typeof page.setMasterPage !== "function")
                throw new Error("Browser slide master API is unavailable.");
              page.setMasterPage(master);
              page.setPropertyValue("Layout", any("short", layout.Layout));
            },
          };
        },
      },
      {
        match: (key) => key === "SetSlideTransition",
        prepare: ({ value, state }) => {
          const transition = assertRecord(value, "Browser slide transition");
          assertExactKeys(
            transition,
            ["Type", "Subtype", "Direction", "FadeColor", "Duration"],
            "Browser slide transition",
          );
          if (
            !Number.isSafeInteger(transition.Type) ||
            !Number.isSafeInteger(transition.Subtype) ||
            typeof transition.Direction !== "boolean" ||
            !Number.isSafeInteger(transition.FadeColor) ||
            typeof transition.Duration !== "number" ||
            !Number.isFinite(transition.Duration)
          )
            throw new Error("Browser slide transition is invalid.");
          const page = state.currentPage;
          const writes = [
            propertyWrite(page, "TransitionType", "short", transition.Type),
            propertyWrite(
              page,
              "TransitionSubtype",
              "short",
              transition.Subtype,
            ),
            propertyWrite(
              page,
              "TransitionDirection",
              "boolean",
              transition.Direction,
            ),
            propertyWrite(
              page,
              "TransitionFadeColor",
              "long",
              transition.FadeColor,
            ),
            propertyWrite(
              page,
              "TransitionDuration",
              "double",
              transition.Duration,
            ),
          ];
          return {
            mutates: true,
            apply: () => writes.forEach((write) => write()),
          };
        },
      },
      {
        match: (key) => key === "SetSlideProperties",
        prepare: ({ value, state }) => {
          const properties = assertRecord(value, "Browser slide properties");
          const propertyTypes = {
            IsFooterVisible: "boolean",
            FooterText: "string",
            IsPageNumberVisible: "boolean",
            IsDateTimeVisible: "boolean",
            IsDateTimeFixed: "boolean",
            DateTimeText: "string",
            DateTimeFormat: "long",
            HighResDuration: "double",
            AutoAdvance: "boolean",
            IsBackgroundObjectsVisible: "boolean",
          };
          const names = assertExactKeys(
            properties,
            Object.keys(propertyTypes),
            "Browser slide properties",
          );
          if (!names.length)
            throw new Error("Browser slide properties are empty.");
          if (
            Object.hasOwn(properties, "HighResDuration") &&
            properties.AutoAdvance === false
          )
            throw new Error(
              "Browser slide duration requires automatic advance.",
            );
          const writes = names.map((name) => {
            const typeName = propertyTypes[name];
            const propertyValue = properties[name];
            if (
              (typeName === "string" && typeof propertyValue !== "string") ||
              (typeName === "boolean" && typeof propertyValue !== "boolean") ||
              (typeName === "long" && !Number.isSafeInteger(propertyValue)) ||
              (typeName === "double" &&
                (typeof propertyValue !== "number" ||
                  !Number.isFinite(propertyValue)))
            )
              throw new Error(
                `Browser slide property ${name} has the wrong type.`,
              );
            if (
              name === "HighResDuration" &&
              (propertyValue < 0 || propertyValue > 86400)
            )
              throw new Error("Browser slide duration is out of range.");
            return name === "AutoAdvance"
              ? propertyWrite(
                  state.currentPage,
                  "Change",
                  "long",
                  propertyValue ? 1 : 0,
                )
              : propertyWrite(state.currentPage, name, typeName, propertyValue);
          });
          if (
            Object.hasOwn(properties, "HighResDuration") &&
            !Object.hasOwn(properties, "AutoAdvance")
          )
            writes.push(propertyWrite(state.currentPage, "Change", "long", 1));
          return {
            mutates: true,
            apply: () => writes.forEach((write) => write()),
          };
        },
      },
      {
        match: (key) => key === "SetSlideSize",
        prepare: ({ value, pages }) => {
          const size = assertRecord(value, "Browser slide size");
          assertExactKeys(
            size,
            ["Width", "Height", "ScaleContent"],
            "Browser slide size",
          );
          if (
            !Number.isSafeInteger(size.Width) ||
            size.Width < 1000 ||
            size.Width > 100000 ||
            !Number.isSafeInteger(size.Height) ||
            size.Height < 1000 ||
            size.Height > 100000 ||
            typeof size.ScaleContent !== "boolean"
          )
            throw new Error("Browser slide size is invalid.");
          const page = pages.getByIndex(0);
          return {
            mutates: true,
            nativeUndoManaged: true,
            apply: () =>
              page.setPropertyValue(
                "SpellbookSlideSizeCommand",
                propertySequence([
                  propertyValue("Width", "long", size.Width),
                  propertyValue("Height", "long", size.Height),
                  propertyValue("ScaleContent", "boolean", size.ScaleContent),
                ]),
              ),
          };
        },
      },
      {
        match: (key) => key === "SetMasterTheme",
        prepare: ({ value, model }) => {
          const theme = assertRecord(value, "Browser master theme");
          const textFields = [
            "Name",
            "ColorSchemeName",
            "FontSchemeName",
            "MajorLatin",
            "MajorAsian",
            "MajorComplex",
            "MinorLatin",
            "MinorAsian",
            "MinorComplex",
          ];
          assertExactKeys(
            theme,
            ["MasterIndex", "Colors", ...textFields],
            "Browser master theme",
          );
          const masters = model.getMasterPages();
          const masterIndex = assertIndex(
            theme.MasterIndex,
            masters.getCount(),
            "Browser master theme target",
          );
          if (
            textFields.some(
              (name) =>
                typeof theme[name] !== "string" ||
                !theme[name] ||
                theme[name].length > 255,
            ) ||
            !Array.isArray(theme.Colors) ||
            theme.Colors.length !== 12 ||
            theme.Colors.some(
              (color) =>
                !Number.isSafeInteger(color) || color < 0 || color > 16777215,
            )
          )
            throw new Error("Browser master theme is invalid.");
          const master = masters.getByIndex(masterIndex);
          return {
            mutates: true,
            nativeUndoManaged: true,
            apply: () =>
              master.setPropertyValue(
                "SpellbookThemeCommand",
                propertySequence([
                  ...textFields.map((name) =>
                    propertyValue(name, "string", theme[name]),
                  ),
                  propertyValue(
                    "Colors",
                    uno.type.sequence(uno.type.long),
                    theme.Colors,
                  ),
                ]),
              ),
          };
        },
      },
      {
        match: (key) => key.startsWith("SetAnimationTiming."),
        prepare: ({ key, value, state }) => {
          const timing = assertRecord(value, "Browser animation timing");
          assertExactKeys(
            timing,
            [
              "EffectIndex",
              "SequenceIndex",
              "ExpectedPresetId",
              "Duration",
              "Delay",
              "Start",
            ],
            "Browser animation timing",
          );
          const objectPath = key.slice("SetAnimationTiming.".length);
          parsePath(objectPath, "Browser animation target");
          if (
            !Number.isSafeInteger(timing.SequenceIndex) ||
            timing.SequenceIndex < 0 ||
            timing.SequenceIndex > 199 ||
            typeof timing.ExpectedPresetId !== "string" ||
            !timing.ExpectedPresetId ||
            timing.ExpectedPresetId.length > 128 ||
            typeof timing.Duration !== "number" ||
            !Number.isFinite(timing.Duration) ||
            timing.Duration < 0.001 ||
            timing.Duration > 60 ||
            typeof timing.Delay !== "number" ||
            !Number.isFinite(timing.Delay) ||
            timing.Delay < 0 ||
            timing.Delay > 60 ||
            !["on-click", "with-previous", "after-previous"].includes(
              timing.Start,
            )
          )
            throw new Error("Browser animation timing is invalid.");
          // Writing XAnimationNode members directly changed the slide without
          // any native Undo action. The engine command records UndoAnimation
          // and applies the effect's own setters, as the server command does.
          return {
            mutates: true,
            nativeUndoManaged: true,
            apply: () =>
              state.currentPage.setPropertyValue(
                "SpellbookAnimationCommand",
                propertySequence([
                  propertyValue("Action", "string", "timing"),
                  propertyValue("ObjectPath", "string", objectPath),
                  propertyValue("SequenceIndex", "long", timing.SequenceIndex),
                  propertyValue(
                    "ExpectedPresetId",
                    "string",
                    timing.ExpectedPresetId,
                  ),
                  propertyValue("Duration", "double", timing.Duration),
                  propertyValue("Delay", "double", timing.Delay),
                  propertyValue("Start", "string", timing.Start),
                ]),
              ),
          };
        },
      },
      {
        match: (key) =>
          [
            "AddAnimationEffect.",
            "RemoveAnimationEffect.",
            "ReplaceAnimationEffect.",
            "MoveAnimationEffect.",
          ].some((prefix) => key.startsWith(prefix)),
        prepare: ({ key, value, state }) => {
          const prefixes = {
            AddAnimationEffect: "add",
            RemoveAnimationEffect: "remove",
            ReplaceAnimationEffect: "replace",
            MoveAnimationEffect: "move",
          };
          const operationName = key.slice(0, key.indexOf("."));
          const action = prefixes[operationName];
          const objectPath = key.slice(key.indexOf(".") + 1);
          parsePath(objectPath, "Browser animation target");
          const animation = assertRecord(value, "Browser animation effect");
          const allowed = {
            add: ["PresetId", "Duration", "Delay", "Start", "InsertIndex"],
            remove: ["SequenceIndex", "ExpectedPresetId"],
            replace: ["SequenceIndex", "ExpectedPresetId", "PresetId"],
            move: ["SequenceIndex", "ExpectedPresetId", "TargetIndex"],
          }[action];
          assertExactKeys(animation, allowed, "Browser animation effect");
          const preset = animation.PresetId;
          const expectedPreset = animation.ExpectedPresetId;
          if (
            (preset !== undefined &&
              (typeof preset !== "string" ||
                !/^ooo-(entrance|emphasis|exit|motionpath)-[A-Za-z0-9._-]+$/u.test(
                  preset,
                ) ||
                preset.length > 128)) ||
            (expectedPreset !== undefined &&
              (typeof expectedPreset !== "string" ||
                !expectedPreset ||
                expectedPreset.length > 128)) ||
            (animation.SequenceIndex !== undefined &&
              (!Number.isSafeInteger(animation.SequenceIndex) ||
                animation.SequenceIndex < 0 ||
                animation.SequenceIndex > 199)) ||
            (animation.InsertIndex !== undefined &&
              (!Number.isSafeInteger(animation.InsertIndex) ||
                animation.InsertIndex < 0 ||
                animation.InsertIndex > 199)) ||
            (animation.TargetIndex !== undefined &&
              (!Number.isSafeInteger(animation.TargetIndex) ||
                animation.TargetIndex < 0 ||
                animation.TargetIndex > 199)) ||
            (action === "add" &&
              (typeof animation.Duration !== "number" ||
                !Number.isFinite(animation.Duration) ||
                animation.Duration < 0.001 ||
                animation.Duration > 60 ||
                typeof animation.Delay !== "number" ||
                !Number.isFinite(animation.Delay) ||
                animation.Delay < 0 ||
                animation.Delay > 60 ||
                !["on-click", "with-previous", "after-previous"].includes(
                  animation.Start,
                )))
          )
            throw new Error("Browser animation effect is invalid.");
          const entries = [
            propertyValue("Action", "string", action),
            propertyValue("ObjectPath", "string", objectPath),
          ];
          for (const [name, entry] of Object.entries(animation))
            entries.push(
              propertyValue(
                name,
                typeof entry === "number" && Number.isInteger(entry)
                  ? "long"
                  : typeof entry === "number"
                    ? "double"
                    : "string",
                entry,
              ),
            );
          return {
            mutates: true,
            nativeUndoManaged: true,
            apply: () =>
              state.currentPage.setPropertyValue(
                "SpellbookAnimationCommand",
                propertySequence(entries),
              ),
          };
        },
      },
      {
        match: (key) => key === "SetNotes",
        prepare: ({ value, state }) => {
          if (typeof value !== "string")
            throw new Error("Browser speaker notes are invalid.");
          const notesPage = state.currentPage.getNotesPage();
          let notesShape = null;
          for (let index = 0; index < notesPage.getCount(); index += 1) {
            const candidate = notesPage.getByIndex(index);
            if (String(candidate.getShapeType()).endsWith("NotesShape")) {
              notesShape = candidate;
              break;
            }
          }
          if (!notesShape || typeof notesShape.setString !== "function")
            throw new Error(
              "Browser speaker notes placeholder is unavailable.",
            );
          return {
            mutates: true,
            apply: () => notesShape.setString(value),
          };
        },
      },
      {
        match: (key) => key.startsWith("SetTextRange."),
        prepare: ({ key, value, state }) => {
          const replacement = assertRecord(value, "Browser text range");
          assertExactKeys(
            replacement,
            ["Paragraph", "Start", "End", "ExpectedText", "Text"],
            "Browser text range",
          );
          if (
            !Number.isSafeInteger(replacement.Paragraph) ||
            replacement.Paragraph < 0 ||
            !Number.isSafeInteger(replacement.Start) ||
            replacement.Start < 0 ||
            !Number.isSafeInteger(replacement.End) ||
            replacement.End < replacement.Start ||
            typeof replacement.ExpectedText !== "string" ||
            typeof replacement.Text !== "string"
          )
            throw new Error("Browser text range is invalid.");
          const path = parsePath(
            key.slice("SetTextRange.".length),
            "Browser text range target",
          );
          const shape = resolveShape(
            state.currentPage,
            path,
            "Browser text range target",
          );
          if (
            typeof shape.getString !== "function" ||
            typeof shape.createTextCursor !== "function"
          )
            throw new Error("Browser text range target has no editable text.");
          const paragraphs = shape.getString().split("\n");
          assertIndex(
            replacement.Paragraph,
            paragraphs.length,
            "Browser text paragraph",
          );
          const paragraph = paragraphs[replacement.Paragraph];
          if (
            replacement.End > paragraph.length ||
            paragraph.slice(replacement.Start, replacement.End) !==
              replacement.ExpectedText
          )
            throw new Error("Browser text range changed after observation.");
          const absoluteStart =
            paragraphs
              .slice(0, replacement.Paragraph)
              .reduce((length, text) => length + text.length + 1, 0) +
            replacement.Start;
          const cursor = shape.createTextCursor();
          cursor.gotoStart(false);
          moveCursorRight(
            cursor,
            absoluteStart,
            false,
            "Browser text range start",
          );
          const rangeLength = replacement.End - replacement.Start;
          moveCursorRight(cursor, rangeLength, true, "Browser text range end");
          if (cursor.getString() !== replacement.ExpectedText)
            throw new Error("Browser text range selection changed.");
          return {
            mutates: true,
            apply: () => cursor.setString(replacement.Text),
          };
        },
      },
      {
        match: (key) => key.startsWith("SetTextProperties."),
        prepare: ({ key, value, state }) => {
          const properties = assertRecord(value, "Browser text properties");
          const names = assertExactKeys(
            properties,
            [
              "Bold",
              "Kerning",
              "Escapement",
              "EscapementHeight",
              "FontColor",
              "FontFamily",
              "FontHeightPoints",
              "Italic",
              "LanguageTag",
              "CaseMap",
              "ParagraphAlignment",
              "Strikethrough",
              "Underline",
            ],
            "Browser text properties",
          );
          if (!names.length)
            throw new Error("Browser text properties are empty.");
          const path = parsePath(
            key.slice("SetTextProperties.".length),
            "Browser text property target",
          );
          const shape = resolveShape(
            state.currentPage,
            path,
            "Browser text property target",
          );
          const cursor = selectAllText(shape, "Browser text property target");
          const css = uno.idl.com.sun.star;
          const writes = [];
          const addWrite = (name, typeName, propertyValue) =>
            writes.push(propertyWrite(cursor, name, typeName, propertyValue));
          if (Object.hasOwn(properties, "FontHeightPoints")) {
            if (
              typeof properties.FontHeightPoints !== "number" ||
              !Number.isFinite(properties.FontHeightPoints) ||
              properties.FontHeightPoints <= 0 ||
              properties.FontHeightPoints > 400
            )
              throw new Error("Browser font height is invalid.");
            for (const name of [
              "CharHeight",
              "CharHeightAsian",
              "CharHeightComplex",
            ])
              addWrite(name, "float", properties.FontHeightPoints);
          }
          if (Object.hasOwn(properties, "FontFamily")) {
            if (
              typeof properties.FontFamily !== "string" ||
              !properties.FontFamily.trim() ||
              properties.FontFamily.length > 255 ||
              /[\u0000-\u001f]/u.test(properties.FontFamily)
            )
              throw new Error("Browser font family is invalid.");
            for (const name of [
              "CharFontName",
              "CharFontNameAsian",
              "CharFontNameComplex",
            ])
              addWrite(name, "string", properties.FontFamily);
          }
          if (Object.hasOwn(properties, "Bold")) {
            if (typeof properties.Bold !== "boolean")
              throw new Error("Browser font weight is invalid.");
            for (const name of [
              "CharWeight",
              "CharWeightAsian",
              "CharWeightComplex",
            ])
              addWrite(name, "float", properties.Bold ? 150 : 100);
          }
          if (Object.hasOwn(properties, "Italic")) {
            if (typeof properties.Italic !== "boolean")
              throw new Error("Browser font posture is invalid.");
            const posture = properties.Italic
              ? css.awt.FontSlant.ITALIC
              : css.awt.FontSlant.NONE;
            const postureType = uno.type.enum(css.awt.FontSlant);
            for (const name of [
              "CharPosture",
              "CharPostureAsian",
              "CharPostureComplex",
            ])
              writes.push(() =>
                cursor.setPropertyValue(
                  name,
                  new uno.Any(postureType, posture),
                ),
              );
          }
          if (Object.hasOwn(properties, "FontColor")) {
            if (
              !Number.isSafeInteger(properties.FontColor) ||
              properties.FontColor < 0 ||
              properties.FontColor > 0xffffff
            )
              throw new Error("Browser font color is invalid.");
            addWrite("CharColor", "long", properties.FontColor);
          }
          if (Object.hasOwn(properties, "Underline")) {
            if (typeof properties.Underline !== "boolean")
              throw new Error("Browser underline is invalid.");
            addWrite(
              "CharUnderline",
              "short",
              properties.Underline
                ? css.awt.FontUnderline.SINGLE
                : css.awt.FontUnderline.NONE,
            );
          }
          if (Object.hasOwn(properties, "Strikethrough")) {
            if (typeof properties.Strikethrough !== "boolean")
              throw new Error("Browser strikethrough is invalid.");
            addWrite(
              "CharStrikeout",
              "short",
              properties.Strikethrough
                ? css.awt.FontStrikeout.SINGLE
                : css.awt.FontStrikeout.NONE,
            );
          }
          if (Object.hasOwn(properties, "ParagraphAlignment")) {
            const paragraphAdjust = {
              left: css.style.ParagraphAdjust.LEFT,
              center: css.style.ParagraphAdjust.CENTER,
              right: css.style.ParagraphAdjust.RIGHT,
              justify: css.style.ParagraphAdjust.BLOCK,
            }[properties.ParagraphAlignment];
            if (paragraphAdjust === undefined)
              throw new Error("Browser paragraph alignment is invalid.");
            writes.push(() =>
              cursor.setPropertyValue(
                "ParaAdjust",
                new uno.Any(
                  uno.type.enum(css.style.ParagraphAdjust),
                  paragraphAdjust,
                ),
              ),
            );
          }
          if (Object.hasOwn(properties, "Kerning")) {
            if (
              !Number.isSafeInteger(properties.Kerning) ||
              properties.Kerning < -32768 ||
              properties.Kerning > 32767
            )
              throw new Error("Browser text kerning is invalid.");
            // Kerning arrives in 1/100 mm, which is also the unit of Impress
            // CharKerning; converting it to twips stored 57% of the request.
            addWrite("CharKerning", "short", properties.Kerning);
          }
          if (Object.hasOwn(properties, "LanguageTag")) {
            if (
              typeof properties.LanguageTag !== "string" ||
              !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/u.test(
                properties.LanguageTag,
              )
            )
              throw new Error("Browser text language is invalid.");
            const parts = properties.LanguageTag.split("-");
            const locale = new css.lang.Locale({
              Language: parts[0].toLowerCase(),
              Country:
                parts.length > 1 && /^[A-Za-z]{2}$/u.test(parts.at(-1))
                  ? parts.at(-1).toUpperCase()
                  : "",
              Variant:
                parts.length > 1 && !/^[A-Za-z]{2}$/u.test(parts.at(-1))
                  ? parts.slice(1).join("-")
                  : parts.length > 2
                    ? parts.slice(1, -1).join("-")
                    : "",
            });
            for (const name of [
              "CharLocale",
              "CharLocaleAsian",
              "CharLocaleComplex",
            ])
              writes.push(() =>
                cursor.setPropertyValue(
                  name,
                  new uno.Any(uno.type.struct(css.lang.Locale), locale),
                ),
              );
          }
          if (Object.hasOwn(properties, "CaseMap")) {
            const caseMap = {
              none: 0,
              uppercase: 1,
              lowercase: 2,
              title: 3,
              small_caps: 4,
            }[properties.CaseMap];
            if (caseMap === undefined)
              throw new Error("Browser text case is invalid.");
            addWrite("CharCaseMap", "short", caseMap);
          }
          const hasEscapement = Object.hasOwn(properties, "Escapement");
          const hasEscapementHeight = Object.hasOwn(
            properties,
            "EscapementHeight",
          );
          if (hasEscapement !== hasEscapementHeight)
            throw new Error("Browser text escapement is incomplete.");
          if (hasEscapement) {
            if (
              !Number.isSafeInteger(properties.Escapement) ||
              properties.Escapement < -100 ||
              properties.Escapement > 100 ||
              !Number.isSafeInteger(properties.EscapementHeight) ||
              properties.EscapementHeight < 1 ||
              properties.EscapementHeight > 100
            )
              throw new Error("Browser text escapement is invalid.");
            addWrite("CharEscapement", "short", properties.Escapement);
            addWrite(
              "CharEscapementHeight",
              "byte",
              properties.EscapementHeight,
            );
          }
          return {
            mutates: true,
            apply: () => writes.forEach((write) => write()),
          };
        },
      },
      {
        match: (key) => key.startsWith("SetParagraphProperties."),
        prepare: ({ key, value, state }) => {
          const payload = assertRecord(value, "Browser paragraph properties");
          const names = assertExactKeys(
            payload,
            [
              "Paragraph",
              "LeftMargin",
              "RightMargin",
              "FirstLineIndent",
              "TopMargin",
              "BottomMargin",
              "Direction",
              "ListType",
              "Level",
              "Prefix",
              "Suffix",
              "StartWith",
              "BulletCharacter",
            ],
            "Browser paragraph properties",
          );
          if (!names.includes("Paragraph"))
            throw new Error("Browser paragraph index is required.");
          if (names.length === 1)
            throw new Error("Browser paragraph properties are empty.");
          const path = parsePath(
            key.slice("SetParagraphProperties.".length),
            "Browser paragraph target",
          );
          const shape = resolveShape(
            state.currentPage,
            path,
            "Browser paragraph target",
          );
          if (typeof shape.createEnumeration !== "function")
            throw new Error("Browser paragraph target has no paragraphs.");
          const paragraphs = [];
          const enumeration = shape.createEnumeration();
          while (enumeration.hasMoreElements())
            paragraphs.push(enumeration.nextElement());
          const paragraphIndex = assertIndex(
            payload.Paragraph,
            paragraphs.length,
            "Browser paragraph",
          );
          const paragraph = paragraphs[paragraphIndex];
          if (typeof paragraph.setPropertyValue !== "function")
            throw new Error("Browser paragraph is not editable.");
          const css = uno.idl.com.sun.star;
          const writes = [];
          const addWrite = (name, typeName, propertyValue) =>
            writes.push(
              propertyWrite(paragraph, name, typeName, propertyValue),
            );
          for (const [payloadName, unoName] of [
            ["LeftMargin", "ParaLeftMargin"],
            ["RightMargin", "ParaRightMargin"],
            ["FirstLineIndent", "ParaFirstLineIndent"],
            ["TopMargin", "ParaTopMargin"],
            ["BottomMargin", "ParaBottomMargin"],
          ]) {
            if (!Object.hasOwn(payload, payloadName)) continue;
            const minimum = payloadName === "FirstLineIndent" ? -100000 : 0;
            if (
              !Number.isSafeInteger(payload[payloadName]) ||
              payload[payloadName] < minimum ||
              payload[payloadName] > 100000
            )
              throw new Error(`Browser paragraph ${payloadName} is invalid.`);
            addWrite(unoName, "long", payload[payloadName]);
          }
          if (Object.hasOwn(payload, "Direction")) {
            const valueByName = {
              "left-to-right": css.text.WritingMode2.LR_TB,
              "right-to-left": css.text.WritingMode2.RL_TB,
              "top-to-bottom": css.text.WritingMode2.TB_RL,
            };
            if (!Object.hasOwn(valueByName, payload.Direction))
              throw new Error("Browser paragraph direction is invalid.");
            addWrite("WritingMode", "short", valueByName[payload.Direction]);
          }
          if (Object.hasOwn(payload, "ListType")) {
            if (
              !["none", "bullet", "number"].includes(payload.ListType) ||
              !Number.isSafeInteger(payload.Level) ||
              payload.Level < 0 ||
              payload.Level > 9 ||
              typeof payload.Prefix !== "string" ||
              typeof payload.Suffix !== "string" ||
              !Number.isSafeInteger(payload.StartWith) ||
              payload.StartWith < 1 ||
              payload.StartWith > 32767 ||
              (payload.ListType === "bullet" &&
                (typeof payload.BulletCharacter !== "string" ||
                  [...payload.BulletCharacter].length !== 1))
            )
              throw new Error("Browser paragraph list is invalid.");
            if (payload.ListType === "none") {
              addWrite("NumberingLevel", "short", -1);
            } else {
              const rules = paragraph.getPropertyValue("NumberingRules");
              const numberingType =
                payload.ListType === "bullet"
                  ? css.style.NumberingType.CHAR_SPECIAL
                  : css.style.NumberingType.ARABIC;
              // The engine starts from the level's current format and applies
              // only the named fields, so the untouched fields (indent, font,
              // graphic) are not read back and resent without their types.
              const values = [
                propertyValue("NumberingType", "short", numberingType),
                propertyValue("Prefix", "string", payload.Prefix),
                propertyValue("Suffix", "string", payload.Suffix),
                propertyValue("StartWith", "short", payload.StartWith),
              ];
              if (payload.ListType === "bullet")
                values.push(
                  propertyValue(
                    "BulletChar",
                    "string",
                    payload.BulletCharacter,
                  ),
                );
              writes.push(() => {
                rules.replaceByIndex(payload.Level, propertySequence(values));
                paragraph.setPropertyValue(
                  "NumberingRules",
                  new uno.Any(
                    uno.type.interface(css.container.XIndexReplace),
                    rules,
                  ),
                );
                paragraph.setPropertyValue(
                  "NumberingLevel",
                  new uno.Any(uno.type.short, payload.Level),
                );
              });
            }
          }
          return {
            mutates: true,
            apply: () => writes.forEach((write) => write()),
          };
        },
      },
      {
        match: (key) => key.startsWith("SetObjectProperties."),
        prepare: ({ key, value, state }) => {
          const properties = assertRecord(value, "Browser object properties");
          const names = assertExactKeys(
            properties,
            Object.keys(objectPropertyTypes),
            "Browser object properties",
          );
          if (!names.length)
            throw new Error("Browser object properties are empty.");
          const path = parsePath(
            key.slice("SetObjectProperties.".length),
            "Browser object target",
          );
          const shape = resolveShape(
            state.currentPage,
            path,
            "Browser object target",
          );
          const css = uno.idl.com.sun.star;
          const writes = names.map((name) => {
            const typeName = objectPropertyTypes[name];
            const propertyValue = properties[name];
            if (
              (typeName === "string" && typeof propertyValue !== "string") ||
              (typeName === "boolean" && typeof propertyValue !== "boolean") ||
              (typeName === "fill-style" &&
                (!Number.isSafeInteger(propertyValue) ||
                  propertyValue < 0 ||
                  propertyValue > 4)) ||
              (typeName === "line-style" &&
                (!Number.isSafeInteger(propertyValue) ||
                  propertyValue < 0 ||
                  propertyValue > 2)) ||
              (typeName === "media-zoom" &&
                (!Number.isSafeInteger(propertyValue) ||
                  propertyValue < 0 ||
                  propertyValue > 8)) ||
              (["short", "long"].includes(typeName) &&
                !Number.isSafeInteger(propertyValue))
            )
              throw new Error(
                `Browser object property ${name} has the wrong type.`,
              );
            if (typeName === "fill-style")
              return () =>
                shape.setPropertyValue(
                  name,
                  new uno.Any(
                    uno.type.enum(css.drawing.FillStyle),
                    [
                      css.drawing.FillStyle.NONE,
                      css.drawing.FillStyle.SOLID,
                      css.drawing.FillStyle.GRADIENT,
                      css.drawing.FillStyle.HATCH,
                      css.drawing.FillStyle.BITMAP,
                    ][propertyValue],
                  ),
                );
            if (typeName === "line-style")
              return () =>
                shape.setPropertyValue(
                  name,
                  new uno.Any(
                    uno.type.enum(css.drawing.LineStyle),
                    [
                      css.drawing.LineStyle.NONE,
                      css.drawing.LineStyle.SOLID,
                      css.drawing.LineStyle.DASH,
                    ][propertyValue],
                  ),
                );
            if (typeName === "media-zoom")
              return () =>
                shape.setPropertyValue(
                  name,
                  new uno.Any(
                    uno.type.enum(css.media.ZoomLevel),
                    [
                      css.media.ZoomLevel.NOT_AVAILABLE,
                      css.media.ZoomLevel.ORIGINAL,
                      css.media.ZoomLevel.FIT_TO_WINDOW,
                      css.media.ZoomLevel.FIT_TO_WINDOW_FIXED_ASPECT,
                      css.media.ZoomLevel.FULLSCREEN,
                      css.media.ZoomLevel.ZOOM_1_TO_4,
                      css.media.ZoomLevel.ZOOM_1_TO_2,
                      css.media.ZoomLevel.ZOOM_2_TO_1,
                      css.media.ZoomLevel.ZOOM_4_TO_1,
                    ][propertyValue],
                  ),
                );
            return propertyWrite(shape, name, typeName, propertyValue);
          });
          return {
            mutates: true,
            apply: () => writes.forEach((write) => write()),
          };
        },
      },
      {
        match: (key) => key.startsWith("SetDiagramNode."),
        prepare: ({ key, value, state }) => {
          const payload = assertRecord(value, "Browser diagram mutation");
          assertExactKeys(
            payload,
            ["Action", "ExpectedText", "Occurrence", "Text"],
            "Browser diagram mutation",
          );
          if (
            !["set", "add", "delete"].includes(payload.Action) ||
            typeof payload.ExpectedText !== "string" ||
            typeof payload.Text !== "string" ||
            !Number.isSafeInteger(payload.Occurrence)
          )
            throw new Error("Browser diagram mutation is invalid.");
          const shape = resolveShape(
            state.currentPage,
            parsePath(
              key.slice("SetDiagramNode.".length),
              "Browser diagram target",
            ),
            "Browser diagram target",
          );
          return {
            mutates: true,
            apply: () =>
              shape.setPropertyValue(
                "SpellbookDiagramMutation",
                any("string", JSON.stringify(payload)),
              ),
          };
        },
      },
      {
        match: (key) => key.startsWith("SetEquationSource."),
        prepare: ({ key, value, state }) => {
          const payload = assertRecord(value, "Browser equation mutation");
          assertExactKeys(
            payload,
            ["ExpectedSource", "Source"],
            "Browser equation mutation",
          );
          if (
            typeof payload.ExpectedSource !== "string" ||
            typeof payload.Source !== "string"
          )
            throw new Error("Browser equation mutation is invalid.");
          const shape = resolveShape(
            state.currentPage,
            parsePath(
              key.slice("SetEquationSource.".length),
              "Browser equation target",
            ),
            "Browser equation target",
          );
          return {
            mutates: true,
            apply: () =>
              shape.setPropertyValue(
                "SpellbookEquationMutation",
                any("string", JSON.stringify(payload)),
              ),
          };
        },
      },
      {
        match: (key) => key.startsWith("ReplaceWithInsertedObject."),
        prepare: ({ key, value, state }) => {
          const oldPath = parsePath(
            key.slice("ReplaceWithInsertedObject.".length),
            "Browser old asset target",
          );
          const newPath = parsePath(value, "Browser inserted asset target");
          if (oldPath.length !== 1 || newPath.length !== 1)
            throw new Error(
              "Browser asset replacement requires top-level objects.",
            );
          const inserted = resolveShape(
            state.currentPage,
            newPath,
            "Browser inserted asset target",
          );
          return {
            mutates: true,
            apply: () =>
              inserted.setPropertyValue(
                "SpellbookReplaceObject",
                any("long", oldPath[0]),
              ),
          };
        },
      },
      {
        match: (key) => key.startsWith("DuplicateObject."),
        prepare: ({ key, value, state }) => {
          const payload = assertRecord(value, "Browser duplicate object");
          if (Object.keys(payload).length)
            throw new Error("Browser duplicate object payload must be empty.");
          const path = parsePath(
            key.slice("DuplicateObject.".length),
            "Browser duplicate object target",
          );
          const shape = resolveShape(
            state.currentPage,
            path,
            "Browser duplicate object target",
          );
          // The browser runtime has no system clipboard, so Copy and Paste
          // inserted nothing; the engine clones the object directly above
          // its source instead.
          return {
            mutates: true,
            apply: () =>
              shape.setPropertyValue(
                "SpellbookDuplicateObject",
                any("boolean", true),
              ),
          };
        },
      },
      {
        match: (key) => key.startsWith("SetGraphicCrop."),
        prepare: ({ key, value, state }) => {
          const crop = assertRecord(value, "Browser graphic crop");
          assertExactKeys(
            crop,
            ["Left", "Top", "Right", "Bottom"],
            "Browser graphic crop",
          );
          if (
            [crop.Left, crop.Top, crop.Right, crop.Bottom].some(
              (candidate) => !Number.isSafeInteger(candidate) || candidate < 0,
            )
          )
            throw new Error("Browser graphic crop is invalid.");
          const path = parsePath(
            key.slice("SetGraphicCrop.".length),
            "Browser graphic target",
          );
          const shape = resolveShape(
            state.currentPage,
            path,
            "Browser graphic target",
          );
          const graphicCrop = new uno.idl.com.sun.star.text.GraphicCrop(crop);
          return {
            mutates: true,
            apply: () =>
              shape.setPropertyValue(
                "GraphicCrop",
                new uno.Any(
                  uno.type.struct(uno.idl.com.sun.star.text.GraphicCrop),
                  graphicCrop,
                ),
              ),
          };
        },
      },
      {
        match: (key) => key.startsWith("SetObjectInteraction."),
        prepare: ({ key, value, pages, state }) => {
          const interaction = assertRecord(value, "Browser object interaction");
          assertExactKeys(
            interaction,
            ["Action", "Target", "TargetSlideIndex"],
            "Browser object interaction",
          );
          const path = parsePath(
            key.slice("SetObjectInteraction.".length),
            "Browser interaction target",
          );
          const shape = resolveShape(
            state.currentPage,
            path,
            "Browser interaction target",
          );
          const css = uno.idl.com.sun.star;
          const clickActions = {
            none: css.presentation.ClickAction.NONE,
            external_url: css.presentation.ClickAction.DOCUMENT,
            internal_slide: css.presentation.ClickAction.BOOKMARK,
            next_slide: css.presentation.ClickAction.NEXTPAGE,
            previous_slide: css.presentation.ClickAction.PREVPAGE,
            first_slide: css.presentation.ClickAction.FIRSTPAGE,
            last_slide: css.presentation.ClickAction.LASTPAGE,
            end_show: css.presentation.ClickAction.STOPPRESENTATION,
          };
          if (!Object.hasOwn(clickActions, interaction.Action))
            throw new Error("Browser object interaction action is invalid.");
          let bookmark = "";
          if (interaction.Action === "external_url") {
            if (typeof interaction.Target !== "string" || !interaction.Target)
              throw new Error(
                "Browser external interaction target is invalid.",
              );
            bookmark = interaction.Target;
          } else if (interaction.Action === "internal_slide") {
            const targetIndex = assertIndex(
              interaction.TargetSlideIndex,
              pages.getCount(),
              "Browser interaction slide target",
            );
            bookmark = pages.getByIndex(targetIndex).getName();
          } else if (
            interaction.Target !== undefined ||
            interaction.TargetSlideIndex !== undefined
          ) {
            throw new Error(
              "Browser navigation interaction has an unexpected target.",
            );
          }
          return {
            mutates: true,
            apply: () => {
              shape.setPropertyValue(
                "OnClick",
                new uno.Any(
                  uno.type.enum(css.presentation.ClickAction),
                  clickActions[interaction.Action],
                ),
              );
              shape.setPropertyValue("Bookmark", any("string", bookmark));
            },
          };
        },
      },
    ];

    function transformSlides({ commands, controller, dispatch, model, pages }) {
      if (!Array.isArray(commands) || !commands.length)
        throw new Error("Browser native transform list is empty.");
      const state = { currentPage: controller.getCurrentPage() };
      const prepared = commands.map((command) => {
        const [key, value] = assertSingleEntry(command);
        const handler = registry.find((candidate) => candidate.match(key));
        if (!handler)
          throw new Error(`Unsupported browser native transform: ${key}`);
        return handler.prepare({
          key,
          value,
          controller,
          model,
          pages,
          dispatch,
          state,
        });
      });
      if (!prepared.some(({ mutates }) => mutates)) {
        for (const { apply } of prepared) apply();
        return;
      }
      const mutations = prepared.filter(({ mutates }) => mutates);
      if (mutations.every(({ nativeUndoManaged }) => nativeUndoManaged)) {
        for (const { apply } of prepared) apply();
        return;
      }

      const undo = model.getUndoManager();
      const undoCount = undo.getAllUndoActionTitles().length;
      let contextOpen = false;
      try {
        undo.enterUndoContext("AI presentation edit");
        contextOpen = true;
        for (const { apply } of prepared) apply();
        undo.leaveUndoContext();
        contextOpen = false;
      } catch (error) {
        if (contextOpen) undo.leaveUndoContext();
        if (undo.getAllUndoActionTitles().length > undoCount) undo.undo();
        throw error;
      }
    }

    const stockStructuralKey = (key) =>
      key === "JumpToSlide" ||
      key === "DuplicateSlide" ||
      key.startsWith("MoveSlide.");
    const supportsTransform = (commands) => {
      if (!Array.isArray(commands) || commands.length === 0) return false;
      const keys = commands.map((command) => {
        const entries = Object.entries(command ?? {});
        return entries.length === 1 ? entries[0][0] : null;
      });
      if (keys.some((key) => key === null)) return false;
      if (keys.includes("DeleteSlide") && !nativeSlideStructureReady)
        return false;
      if (!admitted && !keys.every(stockStructuralKey)) return false;
      return keys.every((key) =>
        registry.some((candidate) => candidate.match(key)),
      );
    };

    return Object.freeze({
      supportedOperations,
      supportsTransform,
      transformSlides,
      engineIdentity: admitted
        ? Object.freeze({
            patchLevel: runtimeIdentity.patchLevel,
            publicCommit: runtimeIdentity.publicCommit ?? null,
            engineImage: "browser-wasm",
            patchSeriesSha256: runtimeIdentity.patchSeriesSha256,
            collaboraSourceCommit: null,
            browserSourceCommit: runtimeIdentity.buildCommit,
          })
        : null,
    });
  }

  global.createSpellbookBrowserNativeAdapter =
    createSpellbookBrowserNativeAdapter;
})(globalThis);
