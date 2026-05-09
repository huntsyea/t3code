import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const vaultSourceDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/vault",
);
const safeVaultWriteFile = path.join(vaultSourceDir, "SafeVaultWrite.ts");

async function collectVaultFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { recursive: true });
  return entries
    .filter((entry): entry is string => typeof entry === "string" && entry.endsWith(".ts"))
    .map((entry) => path.join(root, entry));
}

async function assertNoDirectAtomicWriteImports(root: string): Promise<void> {
  const files = await collectVaultFiles(root);
  const offenders: string[] = [];

  for (const filePath of files) {
    if (path.resolve(filePath) === path.resolve(safeVaultWriteFile)) continue;
    const content = await fs.readFile(filePath, "utf8");
    if (/import[\s\S]*atomicWrite|require[\s\S]*atomicWrite/.test(content)) {
      offenders.push(path.relative(root, filePath));
    }
  }

  if (offenders.length > 0) {
    throw new Error(`Direct atomicWrite imports found in vault files: ${offenders.join(", ")}`);
  }
}

describe("vault write discipline", () => {
  it("rejects direct atomicWrite imports under apps/server/src/vault", async () => {
    const probeDir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-write-discipline-"));
    const probeRoot = path.join(probeDir, "vault");
    await fs.mkdir(probeRoot, { recursive: true });

    const probeFile = path.join(probeRoot, "_probe.ts");

    try {
      await fs.writeFile(
        probeFile,
        'import { writeFileStringAtomically as atomicWrite } from "../atomicWrite.ts";\n',
      );

      await expect(assertNoDirectAtomicWriteImports(probeRoot)).rejects.toThrow(/_probe\.ts/);
    } finally {
      await fs.rm(probeDir, { recursive: true, force: true });
    }
  });

  it("passes when the vault tree only uses SafeVaultWrite", async () => {
    await expect(assertNoDirectAtomicWriteImports(vaultSourceDir)).resolves.toBeUndefined();
  });
});
