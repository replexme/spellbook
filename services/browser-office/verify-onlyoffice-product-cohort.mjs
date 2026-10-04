/* SPDX-License-Identifier: MPL-2.0 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readRepositoryIdentity, repositoryIdentityStable } from "./repository-identity.mjs";

const flag = (name, fallback = null) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const manifestPath = flag("--cases");
if (!manifestPath) throw Error("A complete canonical case manifest is required (--cases)");
const sourceRoot = path.resolve(import.meta.dirname, "../..");
const source = readRepositoryIdentity(sourceRoot);
if (source.dirty) throw Error("Commit implementation before recording cohort evidence");
const registryBytes = await fs.readFile(path.join(sourceRoot,"contracts/native-edit-capabilities.json"));
const operationContracts=JSON.parse(registryBytes).mutationModel.operations;
const canonicalOperations = Object.keys(operationContracts).filter(operation=>operationContracts[operation].availability!=="format_excluded");
const excludedOperations=Object.keys(operationContracts).filter(operation=>operationContracts[operation].availability==="format_excluded");
const manifestBytes = await fs.readFile(path.resolve(manifestPath));
const manifest = JSON.parse(manifestBytes);
const entries = manifest.cases;
if (!Array.isArray(entries) || new Set(entries.map(entry => entry.operation)).size !== entries.length)
  throw Error("Case manifest must contain unique canonical operations");
const extras = entries.filter(entry => !canonicalOperations.includes(entry.operation));
if (extras.length) throw Error("Noncanonical operations in case manifest");
// Honor the manifest order, retaining explicit missing-case results for every
// supported operation. This allows common failure paths to run first.
const operations = [...entries.map(entry=>entry.operation),...canonicalOperations.filter(operation=>!entries.some(entry=>entry.operation===operation))];
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const output = path.resolve(flag("--output", "artifacts/onlyoffice-product-cohort"));
await fs.mkdir(output,{recursive:false});
await fs.writeFile(path.join(output,"case-manifest.json"),manifestBytes);
const requiredStages = [
  "original-open-and-file-admission",
  "canonical-command-live-apply-file-reopen-journal",
  "undo-exact-approved-package",
  "native-failure-rollback-retains-old-redo",
  "journal-failure-restores-native-and-source-baselines",
  "whole-batch-preflight-before-native-history",
  "redo-exact-approved-package",
  "native-editor-buttons-reconcile-with-product-history",
  "real-keyboard-human-edit-admitted-with-earlier-ai-history",
  "stale-command-refused",
  "recovery-exact-file-readback",
  "recovered-mixed-human-and-ai-history-keeps-exact-files",
  "wrong-save-ack-keeps-recovery",
  "acknowledged-exact-file-save",
  "acknowledged-save-keeps-earlier-undo-and-redo",
];
const results = [], report = {
  source, registrySha256:sha256(registryBytes), manifestSha256:sha256(manifestBytes),
  canonicalCount:operations.length, excludedOperations, newBuilds:0, requiredStages, results,
  status:"running", sourceStable:true,
};
const persist = () => fs.writeFile(path.join(output,"results.json"),JSON.stringify(report,null,2));
const timeoutMs = Number(flag("--case-timeout-ms","600000"));
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 60000 || timeoutMs > 3600000)
  throw Error("Invalid case timeout");
await persist();
for (const operation of operations) {
  if (!repositoryIdentityStable(source,readRepositoryIdentity(sourceRoot))) {
    report.sourceStable=false;report.status="source-changed";await persist();process.exitCode=1;break;
  }
  const entry = entries.find(entry => entry.operation === operation);
  if (!entry) {
    results.push({operation,status:"missing-case"});await persist();continue;
  }
  const directory = path.join(output,operation), args = [
    path.join(sourceRoot,"services/browser-office/verify-onlyoffice-product-session.mjs"),
    "--operation",operation,"--manual-flow","--output",directory,
  ];
  const options = {
    "--candidate-root":entry.candidateRoot ?? manifest.candidateRoot,
    "--input":entry.input ?? manifest.input,
    "--slide-index":entry.slideIndex ?? 0,
    "--element-index":entry.elementIndex,
    "--command-json":entry.commandFile,
    "--resources-json":entry.resourceFile ?? manifest.resourceFile,
    "--image-asset-id":entry.imageAssetId ?? manifest.imageAssetId,
    "--media-asset-id":entry.mediaAssetId ?? manifest.mediaAssetId,
    "--existing-document-tool":manifest.documentTool,
    "--document-tool-sha256":manifest.documentToolSha256,
  };
  for (const [name,value] of Object.entries(options)) if (value != null) args.push(name,String(value));
  // Resource/case paths and original input hashes remain reviewable alongside
  // evidence. No implicit fixture creation or build fallback exists here.
  let inputHash;
  try { inputHash=sha256(await fs.readFile(path.resolve(options["--input"]))); }
  catch(error) {results.push({operation,status:"missing-input",error:error.message});await persist();continue;}
  const started = Date.now();
  const log = await fs.open(path.join(output,operation+".log"),"wx");
  let timedOut=false;
  const child = spawn(process.execPath,args,{cwd:sourceRoot,detached:true,stdio:["ignore",log.fd,log.fd]});
  const terminate = () => {try {process.kill(-child.pid,"SIGTERM");} catch {}};
  let killTimer;
  const timer = setTimeout(() => {
    timedOut=true;terminate();
    killTimer=setTimeout(()=>{try {process.kill(-child.pid,"SIGKILL");} catch {}},5000);
  },timeoutMs);
  const exit = await new Promise(resolve => {
    child.once("error",error=>resolve({error:error.message}));
    child.once("exit",(code,signal)=>resolve({code,signal}));
  });
  clearTimeout(timer);clearTimeout(killTimer);await log.close();
  let evidence;
  try {evidence=JSON.parse(await fs.readFile(path.join(directory,"report.json"),"utf8"));} catch {}
  const stages=evidence?.stages??[],missingStages=requiredStages.filter(stage=>!stages.includes(stage));
  const passed=exit.code===0&&!timedOut&&evidence?.status==="product-session-command-verified"&&missingStages.length===0;
  results.push({operation,status:passed?"passed":"failed",inputSha256:inputHash,elapsedMs:Date.now()-started,
    exit,timedOut,missingStages,evidence:path.relative(output,path.join(directory,"report.json")),
    timings:evidence?.timings??null,error:evidence?.error??evidence?.errors??null});
  await persist();
  process.stdout.write(JSON.stringify({operation,status:results.at(-1).status,completed:results.length,total:operations.length})+"\n");
}
report.sourceStable &&= repositoryIdentityStable(source,readRepositoryIdentity(sourceRoot));
report.passed=results.filter(result=>result.status==="passed").length;
report.status=report.sourceStable&&report.passed===operations.length?"verified":"incomplete";
report.finishedAt=new Date().toISOString();await persist();
if (report.status!=="verified") process.exitCode=1;
