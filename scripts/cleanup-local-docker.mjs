import { execFileSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SPELLBOOK_LABEL = "org.spellbook.component";
const LEGACY_COMPONENT_REFERENCE =
  /^spellbook-(?<component>web|document-worker|ai-connector|office-editor|browser-office)(?=[:@])/u;

export function componentFromImage(image) {
  if (typeof image.component === "string" && image.component.length > 0)
    return image.component;
  for (const reference of image.references ?? []) {
    const component =
      LEGACY_COMPONENT_REFERENCE.exec(reference)?.groups?.component;
    if (component) return component;
  }
  return null;
}

export function planSpellbookImageCleanup(
  images,
  referencedImageIds,
  { keepUnusedPerComponent = 0 } = {},
) {
  if (!Number.isInteger(keepUnusedPerComponent) || keepUnusedPerComponent < 0)
    throw new Error("keepUnusedPerComponent must be a non-negative integer.");
  const referenced = new Set(referencedImageIds);
  const managed = images
    .map((image) => ({ ...image, component: componentFromImage(image) }))
    .filter(
      (image) =>
        typeof image.id === "string" &&
        typeof image.component === "string" &&
        image.component.length > 0,
    );
  const byComponent = Map.groupBy(managed, (image) => image.component);
  const remove = [];
  const keep = [];
  for (const componentImages of byComponent.values()) {
    const ordered = [...componentImages].sort(
      (left, right) =>
        Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
        left.id.localeCompare(right.id),
    );
    let unusedKept = 0;
    for (const image of ordered) {
      const inUse = referenced.has(image.id);
      if (inUse || unusedKept < keepUnusedPerComponent) {
        keep.push({ ...image, reason: inUse ? "container" : "rollback" });
        if (!inUse) unusedKept += 1;
      } else {
        remove.push(image);
      }
    }
  }
  return { keep, remove };
}

function inspectJson(type, identifiers) {
  if (!identifiers.length) return [];
  return JSON.parse(
    execFileSync(
      "docker",
      ["inspect", `--type=${type}`, "--", ...identifiers],
      {
        encoding: "utf8",
      },
    ),
  );
}

function dockerState() {
  const containerIds = execFileSync("docker", ["ps", "-aq"], {
    encoding: "utf8",
  })
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  const referencedImageIds = inspectJson("container", containerIds).map(
    (container) => container.Image,
  );
  const imageIds = execFileSync(
    "docker",
    ["image", "ls", "-aq", "--no-trunc"],
    {
      encoding: "utf8",
    },
  )
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  const images = inspectJson("image", [...new Set(imageIds)]).map((image) => ({
    id: image.Id,
    createdAt: image.Created,
    component: image.Config?.Labels?.[SPELLBOOK_LABEL] ?? null,
    references: [...(image.RepoTags ?? []), ...(image.RepoDigests ?? [])],
  }));
  return { images, referencedImageIds };
}

function parseArguments(argv) {
  const options = { execute: false, keepUnusedPerComponent: 0 };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--") continue;
    if (value === "--execute") options.execute = true;
    else if (value === "--keep-unused-per-component")
      options.keepUnusedPerComponent = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${value}`);
  }
  return options;
}

function run(argv) {
  const options = parseArguments(argv);
  const { images, referencedImageIds } = dockerState();
  const plan = planSpellbookImageCleanup(images, referencedImageIds, options);
  if (options.execute && plan.remove.length)
    execFileSync(
      "docker",
      ["image", "rm", "--", ...plan.remove.map((image) => image.id)],
      { stdio: "inherit" },
    );
  if (options.execute)
    execFileSync("docker", ["builder", "prune", "--all", "--force"], {
      stdio: "inherit",
    });
  process.stdout.write(
    `${JSON.stringify(
      {
        mode: options.execute ? "execute" : "dry-run",
        keepUnusedPerComponent: options.keepUnusedPerComponent,
        kept: plan.keep.map(({ id, component, references, reason }) => ({
          id,
          component,
          references,
          reason,
        })),
        removed: plan.remove.map(({ id, component, references }) => ({
          id,
          component,
          references,
        })),
      },
      null,
      2,
    )}\n`,
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
