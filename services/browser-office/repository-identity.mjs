import { execFileSync } from "node:child_process";

export const browserRuntimeBuildInputPaths = Object.freeze([
  "services/browser-office/upstream.json",
  "services/browser-office/libreoffice/Dockerfile.toolchain",
  "services/browser-office/libreoffice/build-candidate-runtime.sh",
  "services/browser-office/libreoffice/patches",
  "services/browser-office/libreoffice/upstream.mjs",
  "services/browser-office/libreoffice/verify-source.mjs",
  "services/browser-office/libreoffice/write-build-receipt.mjs",
  "services/browser-office/libreoffice/runtime-package.mjs",
  "services/browser-office/libreoffice/verify-linked-filesystem.mjs",
]);

export function readRepositoryIdentity(repositoryRoot) {
  const run = (args) =>
    execFileSync("git", args, {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim();
  const revision = run(["rev-parse", "HEAD"]);
  if (!/^[0-9a-f]{40}$/u.test(revision))
    throw new Error("Browser verification source revision is not immutable.");
  return {
    revision,
    dirty:
      run(["status", "--porcelain=v1", "--untracked-files=normal"]).length > 0,
  };
}

export function readRepositoryPathEquivalence(
  repositoryRoot,
  buildSourceRevision,
  integrationSourceRevision,
  paths = browserRuntimeBuildInputPaths,
) {
  assertRevision(buildSourceRevision, "build source");
  assertRevision(integrationSourceRevision, "integration source");
  if (!Array.isArray(paths) || paths.length === 0)
    throw new Error("Runtime build input paths must not be empty.");

  const run = (revision, relativePath) => {
    if (
      typeof relativePath !== "string" ||
      relativePath.length === 0 ||
      relativePath.startsWith("/") ||
      relativePath.split("/").includes("..")
    )
      throw new Error(`Invalid runtime build input path: ${relativePath}`);
    const object = execFileSync(
      "git",
      ["rev-parse", "--verify", `${revision}:${relativePath}`],
      { cwd: repositoryRoot, encoding: "utf8" },
    ).trim();
    if (!/^[0-9a-f]{40,64}$/u.test(object))
      throw new Error(
        `Runtime build input ${relativePath} has no immutable Git object.`,
      );
    return object;
  };

  const inputs = paths.map((relativePath) => {
    const buildObject = run(buildSourceRevision, relativePath);
    const integrationObject = run(integrationSourceRevision, relativePath);
    return {
      path: relativePath,
      buildObject,
      integrationObject,
      exact: buildObject === integrationObject,
    };
  });
  return {
    buildSourceRevision,
    integrationSourceRevision,
    inputs,
    exact: inputs.every(({ exact }) => exact),
  };
}

function assertRevision(revision, label) {
  if (!/^[0-9a-f]{40}$/u.test(revision ?? ""))
    throw new Error(`Browser ${label} revision is not immutable.`);
}
