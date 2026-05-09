import type { EnvironmentId, ProjectId, ThreadId, VaultEntry } from "@t3tools/contracts";

import { readEnvironmentConnection } from "../../environments/runtime";

export const TEMPLATES_DIR = ".atlas/templates";

const EXAMPLE_TEMPLATE_NAME = "meeting-notes.md";
const EXAMPLE_TEMPLATE_BODY = "# {{title}} - {{date}}\n\n## Notes\n";

// Template variables documented for end users:
//   {{title}}    → the user-provided note title
//   {{date}}     → current local date as YYYY-MM-DD
//   {{datetime}} → current ISO 8601 timestamp (UTC)
export function substituteTemplateVariables(
  template: string,
  variables: { readonly title: string; readonly now?: Date },
): string {
  const now = variables.now ?? new Date();
  const date = formatLocalDate(now);
  const datetime = now.toISOString();
  return template
    .replaceAll("{{title}}", variables.title)
    .replaceAll("{{date}}", date)
    .replaceAll("{{datetime}}", datetime);
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear().toString().padStart(4, "0");
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export interface TemplateDescriptor {
  readonly name: string;
  readonly relativePath: string;
}

function toTemplateDescriptor(entry: VaultEntry): TemplateDescriptor | null {
  if (entry.kind !== "file") return null;
  if (!entry.name.toLowerCase().endsWith(".md")) return null;
  const baseName = entry.name.slice(0, -".md".length);
  if (baseName.length === 0) return null;
  return { name: baseName, relativePath: entry.relativePath };
}

export async function listVaultTemplates(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}): Promise<ReadonlyArray<TemplateDescriptor>> {
  const connection = readEnvironmentConnection(input.environmentId);
  if (!connection) return [];

  const entries = await tryListTemplateEntries(connection, input.projectId);
  const descriptors = entries
    .map(toTemplateDescriptor)
    .filter((descriptor): descriptor is TemplateDescriptor => descriptor !== null)
    .toSorted((left, right) => left.name.localeCompare(right.name));

  if (descriptors.length > 0) {
    return descriptors;
  }

  const seededRelativePath = `${TEMPLATES_DIR}/${EXAMPLE_TEMPLATE_NAME}`;
  try {
    await connection.client.vault.writeNote({
      projectId: input.projectId,
      relativePath: seededRelativePath,
      content: EXAMPLE_TEMPLATE_BODY,
    });
  } catch {
    return [];
  }
  return [
    {
      name: EXAMPLE_TEMPLATE_NAME.slice(0, -".md".length),
      relativePath: seededRelativePath,
    },
  ];
}

async function tryListTemplateEntries(
  connection: NonNullable<ReturnType<typeof readEnvironmentConnection>>,
  projectId: ProjectId,
): Promise<ReadonlyArray<VaultEntry>> {
  try {
    const result = await connection.client.vault.listEntries({
      projectId,
      relativeDir: TEMPLATES_DIR,
    });
    return result.entries;
  } catch {
    return [];
  }
}

export function buildNoteRelativePathFromTitle(title: string): string | null {
  const cleaned = title
    // eslint-disable-next-line no-control-regex -- intentional: strip ASCII control chars from titles
    .replace(/[\u0000-\u001F]/g, "")
    .replace(/[\\/]/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  if (cleaned.length === 0) return null;
  const withoutSuffix = cleaned.toLowerCase().endsWith(".md")
    ? cleaned.slice(0, -".md".length).trim()
    : cleaned;
  if (withoutSuffix.length === 0) return null;
  return `${withoutSuffix}.md`;
}

export interface CreateNoteFromTemplateInput {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly template: TemplateDescriptor;
  readonly title: string;
}

export interface CreateNoteFromTemplateResult {
  readonly relativePath: string;
}

export async function createNoteFromTemplate(
  input: CreateNoteFromTemplateInput,
): Promise<CreateNoteFromTemplateResult> {
  const connection = readEnvironmentConnection(input.environmentId);
  if (!connection) {
    throw new Error("No connection to the environment.");
  }

  const relativePath = buildNoteRelativePathFromTitle(input.title);
  if (!relativePath) {
    throw new Error("Enter a valid note title.");
  }

  const templateRead = await connection.client.vault.readNote({
    projectId: input.projectId,
    relativePath: input.template.relativePath,
  });

  const content = substituteTemplateVariables(templateRead.content, {
    title: input.title.trim(),
  });

  await connection.client.vault.writeNote({
    projectId: input.projectId,
    relativePath,
    content,
  });

  await connection.client.tabs.openNoteTab({
    threadId: input.threadId,
    vaultId: input.projectId,
    relativePath,
  });

  return { relativePath };
}
