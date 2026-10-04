/* SPDX-License-Identifier: MPL-2.0 */
import { createProductArtifactAuthority } from "./product-artifact.mjs";
import {
  reconcileNativeHistoryRevision,
  recordManualProductCheckpoint,
  trimSessionProductHistory,
} from "./product-history.mjs";
import { assertArtifactMatchesObservation } from "./harness/product-persistence.mjs";

import {
  captureProductRecoveryHistory,
  validateProductRecoveryHistory,
} from "./product-recovery-history.mjs";

// Engine ports own native operations. The existing product artifact authority
// owns exact-file admission for edits, history, saves and recovery alike.
export function createProductSession({
  engine,
  journal,
  validateCommand,
  operationContracts,
  verifyObservation = assertArtifactMatchesObservation,
}) {
  for (const name of [
    "open",
    "observe",
    "preflight",
    "begin",
    "apply",
    "finish",
    "snapshot",
    "undo",
    "redo",
    "inspect",
    "verifyIntent",
  ])
    if (typeof engine?.[name] !== "function")
      throw new TypeError("Missing engine port: " + name);
  if (typeof validateCommand !== "function" || !operationContracts || !journal)
    throw new TypeError("Product contracts and recovery journal are required");
  const artifacts = createProductArtifactAuthority({
    inspect: (bytes) => engine.inspect(bytes),
    persistenceState: engine.persistenceState,
  });
  let current = null,
    base = null,
    commands = [],
    undo = [],
    redo = [],
    failed = false,
    savedDigest = null,
    acceptedNativeToken = null,
    lastObservedNativeToken = null;
  let queue = Promise.resolve();
  const serial = (fn) => {
    const task = queue.then(fn);
    queue = task.catch(() => {});
    return task;
  };
  const ready = () => {
    if (!current || failed) throw Error("product_session_not_ready");
  };
  const observe = async () => {
    const priorToken = await readNativeToken();
    const value = await engine.observe();
    const token = await readNativeToken();
    if (priorToken !== token) throw Error("product_document_changed");
    lastObservedNativeToken = token;
    if (!value?.revision || !value.slides?.length)
      throw Error("product_observation_incomplete");
    return structuredClone(value);
  };
  const admit = async (bytes, expected, recoveredReceipt = null) => {
    const owned = bytes.slice();
    const receipt = await artifacts.admit({
      bytes: owned,
      modelRevision: expected.revision,
      verify: (actual) => verifyObservation(expected, actual),
      recoveredReceipt,
    });
    return { bytes: owned, observation: structuredClone(expected), receipt };
  };
  const boundHistory = () => {
    if (trimSessionProductHistory(undo, redo)) {
      base = undo[0]?.before ?? redo.at(-1)?.before ?? current;
      commands = undo.flatMap((entry) => entry.commands);
    }
  };
  const checkpoint = async (state) => {
    const snapshotHistory = [...undo, ...redo].some(
      (entry) =>
        entry.native === false ||
        entry.commands.some((c) => c.persistence === "native_snapshot"),
    );
    return journal.save({
      fileName: state.fileName ?? "document.pptx",
      baseBytes: base.bytes,
      candidateBytes: state.bytes,
      commands,
      artifactReceipt: state.receipt,
      commandGroups: snapshotHistory
        ? null
        : [
            ...undo.map((entry) => entry.commands),
            ...redo.toReversed().map((entry) => entry.commands),
          ],
      appliedGroups: snapshotHistory ? null : undo.length,
      ...(snapshotHistory
        ? captureProductRecoveryHistory(base, state, undo, redo)
        : {}),
    });
  };
  const invalidateNativeHistory = () => {
    for (const entry of [...undo, ...redo]) entry.native = false;
  };
  const readNativeToken = async () => {
    if (!engine.changeToken) return null;
    const token = await engine.changeToken();
    if (typeof token !== "string" || !token)
      throw Error("product_native_change_token_invalid");
    return token;
  };
  const acceptNativeToken = () => {
    acceptedNativeToken = lastObservedNativeToken;
  };
  const manualCheckpoint = async (reason) => {
    ready();
    let live = await observe();
    if (live.revision === current.observation.revision) {
      if (acceptedNativeToken !== lastObservedNativeToken)
        throw Error("product_unobserved_native_edit");
      return false;
    }
    // Reuse the shared history matcher when the person presses the native
    // editor's Undo/Redo. A request batch is one native history entry.
    const marker = (entry) =>
      entry.commands.length === 1 ? entry.commands[0] : entry;
    const wrapped = (entry) => ({
      ...entry,
      originalEntry: entry,
      command: marker(entry),
      beforeRevision: entry.before.observation.revision,
      afterRevision: entry.after.observation.revision,
    });
    const previous = { commands, undo, redo, base };
    const matchedUndo = undo.map(wrapped),
      matchedRedo = redo.map(wrapped),
      matchedCommands = undo.map(marker);
    const sourceUndo = undo.at(-1),
      sourceRedo = redo.at(-1);
    const known = reconcileNativeHistoryRevision({
      commands: matchedCommands,
      undoHistory: matchedUndo,
      redoHistory: matchedRedo,
      currentBytes: current.bytes,
      currentRevision: current.observation.revision,
      observedRevision: live.revision,
    });
    if (known) {
      const moved = known.direction === "undo" ? sourceUndo : sourceRedo;
      const target = known.direction === "undo" ? moved.before : moved.after;
      await verifyObservation(target.observation, live);
      await artifacts.require(target.bytes, target.observation.revision);
      await engine.bindArtifact?.(target.bytes.slice());
      await liveMatches(target.observation);
      undo = matchedUndo.map((entry) => entry.originalEntry);
      redo = matchedRedo.map((entry) => entry.originalEntry);
      commands = undo.flatMap((entry) => entry.commands);
      const wasNative = moved.native;
      moved.native = false;
      try {
        await checkpoint(target);
      } catch (error) {
        ({ commands, undo, redo, base } = previous);
        moved.native = wasNative;
        throw error;
      }
      current = target;
      acceptNativeToken();
      return true;
    }

    if (await engine.prepareManualCheckpoint?.()) live = await observe();
    const bytes = await engine.snapshot({
      before: current.observation,
      edited: live,
      commands: null,
      authorize: (bytes) => admit(bytes, live),
    });
    const accepted = await admit(bytes, live);
    await liveMatches(live);
    const nextCommands = commands.slice();
    const entries = undo.map((entry) => ({
      command: entry.commands.length === 1 ? entry.commands[0] : null,
      beforeBytes: entry.before.bytes,
      afterBytes: entry.after.bytes,
      beforeRevision: entry.before.observation.revision,
      afterRevision: entry.after.observation.revision,
      beforeSlides: entry.before.observation.slides,
    }));
    const priorEntry = entries.at(-1);
    const manual = recordManualProductCheckpoint({
      commands: nextCommands,
      undoHistory: entries,
      redoHistory: [],
      beforeBytes: current.bytes,
      afterBytes: accepted.bytes,
      beforeRevision: current.observation.revision,
      afterRevision: live.revision,
      beforeSlides: current.observation.slides,
      reason,
    });
    const coalesced =
      priorEntry?.command?.sourceOperations?.[0] === "manual_edit";
    undo = coalesced ? undo.slice(0, -1) : undo.slice();
    if (manual) {
      const before = coalesced ? previous.undo.at(-1).before : current;
      undo.push({
        before,
        after: accepted,
        commands: [manual],
        beforeBytes: before.bytes,
        afterBytes: accepted.bytes,
        native: false,
      });
    }
    redo = [];
    commands = nextCommands;
    boundHistory();
    try {
      await checkpoint(accepted);
    } catch (error) {
      ({ commands, undo, redo, base } = previous);
      throw error;
    }
    current = accepted;
    acceptNativeToken();
    return true;
  };
  const liveMatches = async (expected) => {
    const live = await observe();
    if (live.revision !== expected.revision)
      throw Error("product_document_changed");
    return live;
  };
  const history = async (direction) => {
    ready();
    await manualCheckpoint("before_product_history");
    await liveMatches(current.observation);
    const from = direction === "undo" ? undo : redo,
      to = direction === "undo" ? redo : undo;
    const entry = from.at(-1);
    if (!entry) return false;
    const target = direction === "undo" ? entry.before : entry.after;
    try {
      if (entry.native === false) {
        await engine.open(target.bytes.slice());
        invalidateNativeHistory();
      } else await engine[direction]();
      const live = await observe();
      await verifyObservation(target.observation, live);
      // Undo/Redo are allowed to reuse only the exact previously inspected file.
      await artifacts.require(target.bytes, target.observation.revision);
      if (entry.native !== false)
        await engine.bindArtifact?.(target.bytes.slice());
      await liveMatches(target.observation);
      const nextCommands =
        direction === "undo"
          ? commands.slice(0, -entry.commands.length)
          : [...commands, ...entry.commands];
      const previousCommands = commands;
      commands = nextCommands;
      from.pop();
      to.push(entry);
      try {
        await checkpoint(target);
      } catch (error) {
        commands = previousCommands;
        to.pop();
        from.push(entry);
        throw error;
      }
      current = target;
      acceptNativeToken();
      return true;
    } catch (error) {
      // Restore a failed history move; leave the journal and retained histories intact.
      try {
        if (entry.native === false) {
          await engine.open(current.bytes.slice());
          invalidateNativeHistory();
        } else await engine[direction === "undo" ? "redo" : "undo"]();
        await engine.bindArtifact?.(current.bytes.slice());
        await liveMatches(current.observation);
      } catch (restoreError) {
        failed = true;
        throw Error("product_history_restore_failed:" + restoreError.message, {
          cause: error,
        });
      }
      throw error;
    }
  };
  return {
    open: (bytes) =>
      serial(async () => {
        await engine.open(bytes.slice());
        const observation = await observe();
        const accepted = await admit(bytes, observation);
        current = accepted;
        base = accepted;
        savedDigest = accepted.receipt.candidateSha256;
        commands = [];
        undo = [];
        redo = [];
        failed = false;
        acceptNativeToken();
        return structuredClone(observation);
      }),
    observe: () =>
      serial(async () => {
        ready();
        await manualCheckpoint("human_edit_observed");
        return observe();
      }),
    checkpointManual: (reason = "human_edit") =>
      serial(() => manualCheckpoint(reason)),
    apply: (request) =>
      serial(async () => {
        ready();
        const input = structuredClone(request);
        if (
          !input?.commands?.length ||
          input.commands.length > 50 ||
          typeof input.expectedRevision !== "string"
        )
          throw Error("product_command_request_invalid");
        await manualCheckpoint("before_ai_edit");
        const before = await liveMatches(current.observation);
        if (before.revision !== input.expectedRevision)
          throw Error("product_command_stale_observation");
        for (const command of input.commands) {
          if (
            !Object.hasOwn(operationContracts, command.op) ||
            !validateCommand(command)
          )
            throw Error("product_command_contract_invalid");
        }
        // Bind every target and validate every operation before creating native history.
        const prepared = await engine.preflight(input.commands, before);
        await liveMatches(before);
        const token = await engine.begin();
        let committed = false;
        try {
          for (const command of prepared) await engine.apply(command);
          const edited = await observe();
          await engine.verifyIntent(before, edited, input.commands);
          if (edited.revision === before.revision) {
            await engine.finish(token, false);
            await liveMatches(before);
            return { observation: structuredClone(before), changed: false };
          }
          const bytes = await engine.snapshot({
            before,
            edited,
            commands: input.commands,
            authorize: (bytes) => admit(bytes, edited),
          });
          const accepted = await admit(bytes, edited);
          await liveMatches(edited);
          const priorCommands = commands;
          const entry = {
            before: current,
            after: accepted,
            commands: input.commands,
            beforeBytes: current.bytes,
            afterBytes: accepted.bytes,
          };
          const priorUndo = undo,
            priorRedo = redo,
            priorBase = base;
          undo = [...undo, entry];
          redo = [];
          commands = [...commands, ...input.commands];
          boundHistory();
          try {
            await checkpoint(accepted);
          } catch (error) {
            commands = priorCommands;
            undo = priorUndo;
            redo = priorRedo;
            base = priorBase;
            throw error;
          }
          try {
            await engine.finish(token, true);
            committed = true;
          } catch (error) {
            commands = priorCommands;
            undo = priorUndo;
            redo = priorRedo;
            base = priorBase;
            try {
              await checkpoint(current);
            } catch {
              failed = true;
            }
            throw error;
          }
          await liveMatches(edited);
          current = accepted;
          acceptNativeToken();
          return {
            observation: structuredClone(edited),
            artifactReceipt: structuredClone(accepted.receipt),
          };
        } catch (error) {
          try {
            if (committed) {
              await engine.undo();
              /* The failed committed point cannot preserve a previous Redo branch. */ failed = true;
            } else await engine.finish(token, false);
            await liveMatches(before);
          } catch (restoreError) {
            failed = true;
            throw Error(
              "product_mutation_restore_failed:" + restoreError.message,
              { cause: error },
            );
          }
          throw error;
        }
      }),
    undo: () => serial(() => history("undo")),
    redo: () => serial(() => history("redo")),
    save: (persist) =>
      serial(async () => {
        ready();
        if (typeof persist !== "function")
          throw Error("product_persistence_callback_required");
        await manualCheckpoint("before_product_save");
        await liveMatches(current.observation);
        const saved = current;
        const receipt = await artifacts.require(
          saved.bytes,
          saved.observation.revision,
        );
        const acknowledgement = await persist(
          saved.bytes.slice(),
          structuredClone(receipt),
        );
        if (acknowledgement?.candidateSha256 !== receipt.candidateSha256)
          throw Error("product_save_acknowledgement_mismatch");
        // A provider may still accept direct human edits during the external write.
        await liveMatches(saved.observation);
        await journal.clear();
        savedDigest = saved.receipt.candidateSha256;
        // Saving acknowledges a file; it does not erase the editor history.
        // A later edit journals the same retained, bounded history from its base.
        return structuredClone(receipt);
      }),
    recover: () =>
      serial(async () => {
        const recovery = await journal.load();
        if (!recovery) return null;
        const receipt = recovery.metadata.artifactReceipt;
        if (!receipt) throw Error("product_recovery_evidence_missing");
        const inspected = await artifacts.inspect(recovery.candidateBytes);
        const accepted = await admit(
          recovery.candidateBytes,
          inspected,
          receipt,
        );
        const baseObservation = await artifacts.inspect(recovery.baseBytes);
        const restoredBase = await admit(recovery.baseBytes, baseObservation);
        const groups = recovery.metadata.commandGroups;
        if (recovery.metadata.productHistory) {
          validateProductRecoveryHistory(
            recovery.metadata.productHistory,
            recovery.historyArtifacts,
          );
          const states = new Map();
          for (const artifact of recovery.historyArtifacts) {
            const observation = await artifacts.inspect(artifact.bytes);
            const state = await admit(
              artifact.bytes,
              observation,
              artifact.artifactReceipt,
            );
            states.set(state.receipt.candidateSha256, state);
          }
          const entry = (value) => ({
            before: states.get(value.before),
            after: states.get(value.after),
            commands: structuredClone(value.commands),
            beforeBytes: states.get(value.before).bytes,
            afterBytes: states.get(value.after).bytes,
            native: false,
          });
          const restoredUndo = recovery.metadata.productHistory.undo.map(entry),
            restoredRedo = recovery.metadata.productHistory.redo.map(entry);
          if (
            (restoredUndo.at(-1)?.after.receipt.candidateSha256 &&
              restoredUndo.at(-1).after.receipt.candidateSha256 !==
                accepted.receipt.candidateSha256) ||
            (restoredRedo.at(-1)?.before.receipt.candidateSha256 &&
              restoredRedo.at(-1).before.receipt.candidateSha256 !==
                accepted.receipt.candidateSha256) ||
            JSON.stringify(restoredUndo.flatMap((e) => e.commands)) !==
              JSON.stringify(recovery.metadata.commands)
          )
            throw Error("product_recovery_history_cursor_mismatch");
          await engine.open(accepted.bytes.slice());
          await verifyObservation(inspected, await observe());
          base = restoredBase;
          current = accepted;
          commands = structuredClone(recovery.metadata.commands);
          undo = restoredUndo;
          redo = restoredRedo;
        } else if (!groups) {
          await engine.open(accepted.bytes.slice());
          await verifyObservation(inspected, await observe());
          base = accepted;
          current = accepted;
          commands = [];
          undo = [];
          redo = [];
        } else {
          // Recreate native transactions from the original, retaining request grouping.
          // Verify the recorded candidate before replay and the final model after it.
          const appliedGroups = recovery.metadata.appliedGroups;
          if (
            !Number.isSafeInteger(appliedGroups) ||
            appliedGroups < 0 ||
            appliedGroups > groups.length ||
            JSON.stringify(groups.slice(0, appliedGroups).flat()) !==
              JSON.stringify(recovery.metadata.commands)
          )
            throw Error("product_recovery_history_invalid");
          const restoredUndo = [];
          await engine.open(restoredBase.bytes.slice());
          await verifyObservation(baseObservation, await observe());
          let previous = restoredBase;
          for (const group of groups) {
            if (
              !group.length ||
              group.some(
                (c) =>
                  !Object.hasOwn(operationContracts, c.op) ||
                  !validateCommand(c),
              )
            )
              throw Error("product_recovery_command_invalid");
            const prepared = await engine.preflight(
              group,
              previous.observation,
            );
            const token = await engine.begin();
            try {
              for (const command of prepared) await engine.apply(command);
              const edited = await observe();
              await engine.verifyIntent(previous.observation, edited, group);
              const bytes = await engine.snapshot({
                before: previous.observation,
                edited,
                commands: group,
                authorize: (bytes) => admit(bytes, edited),
              });
              const after = await admit(bytes, edited);
              await liveMatches(edited);
              await engine.finish(token, true);
              restoredUndo.push({
                before: previous,
                after,
                commands: group,
                beforeBytes: previous.bytes,
                afterBytes: after.bytes,
              });
              previous = after;
            } catch (error) {
              failed = true;
              try {
                await engine.finish(token, false);
              } catch {}
              throw error;
            }
          }
          const restoredRedo = [];
          while (restoredUndo.length > appliedGroups) {
            await engine.undo();
            const entry = restoredUndo.pop();
            await verifyObservation(entry.before.observation, await observe());
            restoredRedo.push(entry);
          }
          await verifyObservation(inspected, await observe());
          // Reuse the exact retained package at the restored cursor.
          if (restoredUndo.length) restoredUndo.at(-1).after = accepted;
          if (restoredRedo.length) restoredRedo.at(-1).before = accepted;
          base = restoredBase;
          current = accepted;
          commands = structuredClone(recovery.metadata.commands);
          undo = restoredUndo;
          redo = restoredRedo;
          boundHistory();
        }
        const live = await observe();
        failed = false;
        acceptNativeToken();
        return structuredClone(live);
      }),
    status: () => ({
      ready: !!current && !failed,
      modified: !!current && current.receipt.candidateSha256 !== savedDigest,
      commands: commands.length,
      undo: undo.length,
      redo: redo.length,
    }),
  };
}
