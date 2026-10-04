/* SPDX-License-Identifier: MPL-2.0 */
import { createProductArtifactAuthority } from "./product-artifact.mjs";
import { trimSessionProductHistory } from "./product-history.mjs";
import { assertArtifactMatchesObservation } from "./harness/product-persistence.mjs";

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
  ])
    if (typeof engine?.[name] !== "function")
      throw new TypeError("Missing engine port: " + name);
  if (typeof validateCommand !== "function" || !operationContracts || !journal)
    throw new TypeError("Product contracts and recovery journal are required");
  const artifacts = createProductArtifactAuthority({
    inspect: (bytes) => engine.inspect(bytes),
  });
  let current = null,
    base = null,
    commands = [],
    undo = [],
    redo = [],
    failed = false;
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
    const value = await engine.observe();
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
  const checkpoint = async (state) =>
    journal.save({
      fileName: state.fileName ?? "document.pptx",
      baseBytes: base.bytes,
      candidateBytes: state.bytes,
      commands,
      artifactReceipt: state.receipt,
      commandGroups: [
        ...undo.map((entry) => entry.commands),
        ...redo.toReversed().map((entry) => entry.commands),
      ],
      appliedGroups: undo.length,
    });
  const liveMatches = async (expected) => {
    const live = await observe();
    if (live.revision !== expected.revision)
      throw Error("product_document_changed");
    return live;
  };
  const history = async (direction) => {
    ready();
    await liveMatches(current.observation);
    const from = direction === "undo" ? undo : redo,
      to = direction === "undo" ? redo : undo;
    const entry = from.at(-1);
    if (!entry) return false;
    const target = direction === "undo" ? entry.before : entry.after;
    try {
      await engine[direction]();
      const live = await observe();
      await verifyObservation(target.observation, live);
      // Undo/Redo are allowed to reuse only the exact previously inspected file.
      await artifacts.require(target.bytes, target.observation.revision);
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
      return true;
    } catch (error) {
      // Restore a failed history move; leave the journal and retained histories intact.
      try {
        await engine[direction === "undo" ? "redo" : "undo"]();
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
        commands = [];
        undo = [];
        redo = [];
        failed = false;
        return structuredClone(observation);
      }),
    observe: () =>
      serial(async () => {
        ready();
        return observe();
      }),
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
          current = accepted;
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
        base = saved;
        commands = [];
        // Native Undo remains available, but journal deltas now have a new base.
        undo = [];
        redo = [];
        return structuredClone(receipt);
      }),
    recover: () =>
      serial(async () => {
        const recovery = await journal.load();
        if (!recovery) return null;
        const receipt = recovery.metadata.artifactReceipt;
        if (!receipt) throw Error("product_recovery_evidence_missing");
        const inspected = await engine.inspect(recovery.candidateBytes.slice());
        const accepted = await admit(
          recovery.candidateBytes,
          inspected,
          receipt,
        );
        const baseObservation = await engine.inspect(
          recovery.baseBytes.slice(),
        );
        const restoredBase = await admit(recovery.baseBytes, baseObservation);
        const groups = recovery.metadata.commandGroups;
        if (!groups) {
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
        return structuredClone(live);
      }),
    status: () => ({
      ready: !!current && !failed,
      commands: commands.length,
      undo: undo.length,
      redo: redo.length,
    }),
  };
}
