import capabilities from "../../../../contracts/native-edit-capabilities.json";
import type { Sql, TransactionSql } from "postgres";
import { NATIVE_AGENT_LEASE_SECONDS } from "./job-delivery";

export interface NativePackageChangeBudget {
  contractVersion: "1.0";
  allowedCategories: string[];
  targetSlideIndexes: number[] | null;
  allowedExactParts: null;
  allowPartCreationOrDeletion: boolean;
}

export interface NativeSaveChangePolicy {
  origin: "ai" | "human";
  budget: NativePackageChangeBudget;
  taskIds: string[];
}

interface CompletedNativeTask {
  id: string;
  request: unknown;
  result: unknown;
}

interface NativeSaveTask extends CompletedNativeTask {
  taskStatus: string;
  turnStatus: string;
  changed: boolean;
  reviewed: boolean;
}

type MutationOperation = keyof typeof capabilities.mutationModel.operations;
type MutationFamily = keyof typeof capabilities.mutationModel.families;

const forbiddenHumanCategories = new Set(["custom_xml", "macros", "unknown"]);

export function humanNativeSavePolicy(): NativeSaveChangePolicy {
  return {
    origin: "human",
    budget: {
      contractVersion: "1.0",
      allowedCategories:
        capabilities.mutationModel.changeBudgetContract.categories.filter(
          (category) => !forbiddenHumanCategories.has(category),
        ),
      targetSlideIndexes: null,
      allowedExactParts: null,
      allowPartCreationOrDeletion: true,
    },
    taskIds: [],
  };
}

export function reviewedAiSavePolicy(
  tasks: CompletedNativeTask[],
): NativeSaveChangePolicy {
  const operations = new Set<MutationOperation>();
  const families = new Set<MutationFamily>();
  const targetSlideIndexes = new Set<number>();

  for (const task of tasks) {
    const request = objectValue(task.request);
    const result = objectValue(task.result);
    const changedSlideIndexes = result.changedSlideIndexes;
    if (
      !Array.isArray(changedSlideIndexes) ||
      changedSlideIndexes.length === 0 ||
      changedSlideIndexes.some(
        (index) => !Number.isSafeInteger(index) || Number(index) < 0,
      )
    )
      continue;
    for (const index of changedSlideIndexes)
      targetSlideIndexes.add(Number(index));

    if (
      typeof request.operation === "string" &&
      request.operation in capabilities.mutationModel.operations &&
      capabilities.mutationModel.operations[
        request.operation as MutationOperation
      ].execution === "platform_asset"
    ) {
      addOperation(request.operation, operations, families);
      continue;
    }
    if (request.operation === "edit") {
      addOperation(objectValue(request.command).op, operations, families);
      continue;
    }
    if (request.operation === "edit_batch" && request.dryRun !== true) {
      if (!Array.isArray(request.commands) || request.commands.length === 0)
        throw new Error("native_ai_change_budget_missing_commands");
      for (const command of request.commands)
        addOperation(objectValue(command).op, operations, families);
    }
  }

  if (families.size === 0 || targetSlideIndexes.size === 0)
    throw new Error("native_ai_change_evidence_missing");

  const allowedCategories = new Set<string>();
  let allowPartCreationOrDeletion = false;
  for (const familyName of families) {
    const family = capabilities.mutationModel.families[familyName];
    for (const category of family.changeBudget) allowedCategories.add(category);
    if (
      "allowPartCreationOrDeletion" in family &&
      family.allowPartCreationOrDeletion
    )
      allowPartCreationOrDeletion = true;
  }
  for (const operationName of operations) {
    const identity =
      capabilities.mutationModel.operations[operationName].identityEffect;
    if (identity === "create" || identity === "delete")
      allowPartCreationOrDeletion = true;
  }

  return {
    origin: "ai",
    budget: {
      contractVersion: "1.0",
      allowedCategories: [...allowedCategories].sort(),
      targetSlideIndexes: [...targetSlideIndexes].sort(
        (left, right) => left - right,
      ),
      allowedExactParts: null,
      allowPartCreationOrDeletion,
    },
    taskIds: tasks.map((task) => task.id).sort(),
  };
}

export async function loadNativeSaveChangePolicy(
  sql: Sql | TransactionSql,
  sessionId: string,
  saveRevision: number,
): Promise<NativeSaveChangePolicy> {
  // A request running in the browser records its editor calls when it ends,
  // so a save while it runs could carry edits no review has covered yet.
  const [browserTurn] = await sql`
    select 1 from spellbook_native_turns turn
    join spellbook_jobs job on job.id=turn.job_id
    where turn.session_id=${sessionId} and turn.status='running'
      and job.status='running' and job.payload->>'execution'='browser'
      and job.heartbeat_at > now() - ${NATIVE_AGENT_LEASE_SECONDS} * interval '1 second'
    limit 1
  `;
  if (browserTurn) throw new Error("native_ai_change_review_pending");
  const tasks = await sql`
    select task.id::text,task.request,task.result,
      task.status as "taskStatus",turn.status as "turnStatus",
      turn.changed,turn.reviewed
    from spellbook_native_tasks task
    join spellbook_native_turns turn on turn.id=task.turn_id
    where task.session_id=${sessionId}
      and task.save_revision_at_create=${saveRevision}
    order by task.created_at,task.id
  `;
  return nativeSavePolicyFromTasks(
    tasks.map((task) => ({
      id: String(task.id),
      request: task.request,
      result: task.result,
      taskStatus: String(task.taskStatus),
      turnStatus: String(task.turnStatus),
      changed: task.changed === true,
      reviewed: task.reviewed === true,
    })),
  );
}

export function nativeSavePolicyFromTasks(
  tasks: NativeSaveTask[],
): NativeSaveChangePolicy {
  const mutations = tasks.filter((task) => {
    const request = objectValue(task.request);
    return (
      request.operation !== "observe" &&
      !(request.operation === "edit_batch" && request.dryRun === true)
    );
  });
  if (!mutations.length) return humanNativeSavePolicy();
  if (
    mutations.some(
      (task) =>
        task.taskStatus !== "completed" ||
        task.turnStatus !== "completed" ||
        !task.changed ||
        !task.reviewed,
    )
  )
    throw new Error("native_ai_change_review_pending");
  return reviewedAiSavePolicy(mutations);
}

function addOperation(
  rawOperation: unknown,
  operations: Set<MutationOperation>,
  families: Set<MutationFamily>,
): void {
  if (
    typeof rawOperation !== "string" ||
    !(rawOperation in capabilities.mutationModel.operations)
  )
    throw new Error("native_ai_change_budget_unknown_operation");
  const operation = rawOperation as MutationOperation;
  const contract = capabilities.mutationModel.operations[operation];
  if (contract.availability === "format_excluded")
    throw new Error("native_ai_change_budget_excluded_operation");
  operations.add(operation);
  families.add(contract.family as MutationFamily);
}

function objectValue(value: unknown): Record<string, any> {
  return value && typeof value === "object"
    ? (value as Record<string, any>)
    : {};
}
