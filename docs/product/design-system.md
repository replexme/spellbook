# Design system

Status: adopted for every web screen (sign-in, file home, import, workspace, versions, compare, download, settings). Source: `apps/web/src/design-system/`.

Spellbook's reason to exist is that the AI looks at the same rendered slide the person sees, edits it, looks again and checks the result before presenting it. The interface has one job on top of that loop: let a person see in a few seconds **what the AI changed, what was checked, and how to undo it**. Every screen is composed from this system so that promise looks and behaves the same everywhere.

## Strategy

The system has four layers. A layer may only use the layers above it.

| Layer      | Where                                                   | Contents                                                                                                                                                                                                                                                                                                                                         |
| ---------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tokens     | `design-system/tokens.css`                              | Primitive palette (`--sb-*`) and semantic roles (`--ds-*`) for colour, type, space, shape, elevation, motion, layering and layout.                                                                                                                                                                                                               |
| Primitives | `design-system/components.css` + `*.tsx`                | Icon, Button, IconButton, Badge, Chip, Banner, Spinner, Progress, Segmented, Tabs, Menu, Dialog, fields, EmptyState, SlideImage, CheckList, StepList, FileMark, Brand.                                                                                                                                                                           |
| Patterns   | `design-system/patterns.css` + `components/workspace/*` | Product compositions: top bar, side panel, result card, running card, conversation log (requests, cards, direct-edit lines, requests waiting for the editor), composer with scope and model menus, restore confirmation, version list, compare view, phone slide viewer, opening view, file card, import and download dialogs, connection steps. |
| Screens    | `app/**`, `components/**`                               | Layout only. A screen arranges patterns and primitives; it does not introduce new colours, radii, shadows or type sizes.                                                                                                                                                                                                                         |

The living catalogue is the `/design-system` route (development builds, or `SPELLBOOK_DESIGN_GALLERY=1`). Review new work there first, then on the screen.

## Colour means something

| Role   | Token                      | Use it for                                                                                                          | Never for                                 |
| ------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Ink    | `--ds-action`, `--ds-text` | Text and the single primary action on a surface (Open, Download, Restore)                                           | Decoration                                |
| AI     | `--ds-ai*`                 | Things the AI did or is doing: the AI panel toggle, send, result-card header, AI versions, changed-element outlines | Generic primary buttons, links, selection |
| OK     | `--ds-ok*`                 | A check that code performed and passed                                                                              | "Looks good" copy, AI claims              |
| Warn   | `--ds-warn*`               | Something to look at: missing fonts, result not re-checked                                                          | Errors                                    |
| Danger | `--ds-danger*`             | Failure, destructive actions                                                                                        | Warnings                                  |
| Focus  | `--ds-focus`               | Keyboard focus rings                                                                                                | Anything else                             |

The embedded editor's own accent is neutral ink (`design-system/editor-theme.ts`). Its selection and active-tab colours are not AI actions, so they must not look like them.

## Checks are claims

`CheckList` renders verification lines. A line may show a check mark only when code actually performed that check, and every line carries an `evidence` string naming the data that proves it. Rules:

- Show what was checked, in the same words, on the result card, in version history and in the download dialog.
- A check that does not exist yet is either omitted or shown as a grey dash line (`na`). It is never phrased as done. PowerPoint reopening is not automated today, so no screen may say "PowerPoint compatible".
- Information that is not a check (what a file or the editor engine allows) uses the `info` tone, never a check mark. The import summary's "what AI cannot change" lines are information: they come from the document worker's element graph and, where they depend on the engine, from what the running editor reported it can do.
- A result card's check lines are exactly: re-checked by the AI (`turn.reviewed`), no new overlap and no element pushed off the slide (the edit's layout-audit delta), and "the other slides did not change" (the editor's before/after states compared slide by slide; omitted when slides were added, removed or moved, or the masters changed).
- "Changed / not changed / not re-checked" comes from the editor's transaction record and the turn's review flag, not from the assistant's wording. When the AI says it changed something and the record says nothing changed, the screen follows the record.

## Composition rules

1. **The slide is the hero.** One top bar, one save state, one set of undo and redo. In the Collabora editor the duplicate logo, file name, save button, undo/redo, editing-mode switch and status-bar save text are hidden (`services/office-editor/host-bridge.css`), its document-type colour becomes the neutral accent Spellbook passes at launch, and missing Korean ribbon labels are filled from `localization-ko-overrides.json`. A few labels that come from the editing engine itself (for example transition names) stay in English.
2. **Every AI request ends in a result card** in one of six states: changed, changed but not re-checked, no change, answered only, could not change (including "the request needed more than the chosen scope", with a widen-and-retry action), stopped. The card lists changed slides and elements (several slides are grouped per slide: "5번 · 4곳 · 텍스트 상자 3, 바닥글 1"), before/after images, checks, undo, compare and "show it on the slide" (selects the changed element in the editor). Outlines of changed elements are drawn only on images of the slide itself; a whole-editor-window capture is labelled as such and gets no outlines. A card that finishes while the person watches shows its before image changing into the after image once; nothing else animates.
3. **The screenshots the AI looked at stay only in the page.** The server drops them when a request ends; after a reload the card shows the saved versions' previews and says so ("저장본 미리보기").
4. **Undo follows fixed rules; the imported original always remains.**

   | Situation                                                | Card button                                             | What happens                                                                                                                                                                                                |
   | -------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | The latest request, and nothing changed after it         | 되돌리기 (모두 되돌리기 when it changed several slides) | The editor undoes exactly that request's undo steps, only if the document is still in the state the request left and only if the result equals the state before it; the next save is recorded as that undo. |
   | A direct edit or save came after it, or an older request | 이 요청 전으로 돌아가기                                 | A confirmation names what else goes back ("그 뒤의 직접 수정(10:31–10:38)과 AI 요청 1건(10:42)"), then the version saved just before the request is restored as a new version and the editor reopens.       |
   | The editor cannot undo exactly                           | (same button)                                           | The same confirmation opens with a line saying a saved version is used instead.                                                                                                                             |

   Restoring never deletes history. Saves no person changed (the baseline save the editor makes before AI editing, once per editor load) are kept for lineage but not listed. Direct edits appear in the conversation as one line per run ("직접 수정함 · 10:31–10:38").

5. **Scope is visible before sending and follows the editor.** The chip above the request box names what is selected ("선택 · 제목 (3번)") or the slide ("범위 · 3번 슬라이드") from the editor's selection notices; the scope menu describes each option for the current selection. Suggestions are offered only for edits the running editor engine reports it can do.
6. **Waiting shows the person's own file.** Opening shows the saved slide previews where the slide list and canvas will be, the past requests and cards, and keeps a request written meanwhile ("편집기가 열리는 대로 보낼게요") to send once the editor is ready. A running request shows the slide the AI is looking at and four stages (보기 → 고치기 → 다시 보기 → 검토) placed from the agent's own progress labels. Failing to open states the cause, says the file is safe, and retries on its own with a countdown, or when the network returns.
7. **Phones view, ask and decide; editing stays on large screens.** On a phone the saved slide previews and the AI panel share the screen; the editor keeps running out of sight (asked into edit mode) so requests, cards, undo and download work.
8. **Failures state the reason and the next action.** No raw server messages, no English, no "try again later" without a reason. Import failures come from reason codes (the upload checks and the document worker's `errorCode`) and the file card repeats the short reason.
9. **Korean copy, 해요체 for guidance and status, 합니다체 only for the one product promise line.** Buttons say exactly what they do.

## Type, space and shape

- Type scale: seven steps, 11.5 · 12.5 · 13 · 14 · 16 · 18 · 26 px. Body text is 14 px; dense workspace text is 12.5–13 px. Numbers that line up use `ds-tabular`.
- Space: 4 px rhythm (`--ds-space-*`).
- Controls: 26 / 30 / 40 px heights. Radius: 8 px controls, 12 px cards and panels, 14 px dialogs. The compare view is a full-window dialog (`size="full"`).
- Elevation: shadows mark what floats (menus, dialogs, the opening pill) and slide images that stand for a page.
- Motion: 120–180 ms with `--ds-ease`. Spinners only while work is actually running. `prefers-reduced-motion` disables animation.

## Accessibility

- Every icon-only control has a label (`IconButton` requires one).
- Menus close on outside pointer, Escape, focus leaving, and window blur (clicking into the editor iframe); Escape returns focus to the trigger (`useDismiss`).
- ⌘S (Ctrl+S) saves from anywhere on the page; ⌘Z / ⇧⌘Z undo and redo in the editor when focus is not in a text field. Inside the editor frame the editor's own keys apply.
- Dialogs use the native `<dialog>` element for focus trapping and Escape.
- Tabs and segmented controls support arrow keys, Home and End.
- Status text changes are announced with `role="status"`; failures use `role="alert"`.

## Enforcement

`apps/web/src/design-system/design-system.test.ts` runs with the unit tests and fails when:

- a screen uses a class name the system's stylesheets do not define;
- a stylesheet exists outside `design-system/` (legacy files not rendered by any route are allowlisted and may only shrink), or the root layout stops loading the four system layers;
- a colour literal appears outside `tokens.css`;
- the editor theme drifts from the token values, or `host-bridge.css` stops reading the accent Spellbook passes;
- the AI colour is assigned to any role other than `--ds-ai`;
- a font size falls outside the seven type steps, or the control heights drift from 26 / 30 / 40 px;
- an icon path starts outside its 24 × 24 box;
- focus rings, reduced motion or the visually-hidden helper leave the base layer, or the editor stops opening with the tabbed ribbon.

The end-to-end suite captures the catalogue and every screen at desktop, tablet and phone widths and fails on horizontal overflow.

## Adding to the system

1. Check whether an existing primitive or pattern with a new variant covers the need.
2. Add tokens only for a new role, never for a single screen.
3. Add the primitive or pattern with its states to the `/design-system` catalogue.
4. Use it on the screen. If a screen needs a one-off style, the system is missing something; add it to the system instead.
