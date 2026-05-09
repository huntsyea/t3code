import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { safeVaultWrite } from "../../src/vault/SafeVaultWrite.ts";

async function makeVaultFixture() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "safe-vault-write-"));
  const vaultRoot = path.join(parent, "vault");
  await fs.mkdir(vaultRoot);
  return { parent, vaultRoot };
}

describe("safeVaultWrite", () => {
  it("writes a file within the vault", async () => {
    const { vaultRoot, parent } = await makeVaultFixture();

    try {
      await Effect.runPromise(
        safeVaultWrite(vaultRoot, "notes/today.txt", "hello vault").pipe(
          Effect.provide(NodeServices.layer),
        ),
      );
      const written = await fs.readFile(path.join(vaultRoot, "notes/today.txt"), "utf8");

      expect(written).toBe("hello vault");
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it("rejects path traversal escapes", async () => {
    const { vaultRoot, parent } = await makeVaultFixture();

    try {
      await expect(
        Effect.runPromise(
          safeVaultWrite(vaultRoot, "../escape.txt", "blocked").pipe(
            Effect.provide(NodeServices.layer),
          ),
        ),
      ).rejects.toMatchObject({
        _tag: "SafeVaultWriteError",
        code: "PATH_ESCAPE",
        path: "../escape.txt",
      });
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it("rejects symlink escapes", async () => {
    const { vaultRoot, parent } = await makeVaultFixture();
    const outsideRoot = path.join(parent, "outside");
    const symlinkPath = path.join(vaultRoot, "escape-link");

    await fs.mkdir(outsideRoot);
    await fs.symlink(outsideRoot, symlinkPath, "dir");

    try {
      await expect(
        Effect.runPromise(
          safeVaultWrite(vaultRoot, "escape-link/note.txt", "blocked").pipe(
            Effect.provide(NodeServices.layer),
          ),
        ),
      ).rejects.toMatchObject({
        _tag: "SafeVaultWriteError",
        code: "PATH_ESCAPE",
        path: "escape-link/note.txt",
      });
      await expect(fs.access(path.join(outsideRoot, "note.txt"))).rejects.toThrow();
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it("rejects invalid paths", async () => {
    const { vaultRoot, parent } = await makeVaultFixture();

    try {
      await expect(
        Effect.runPromise(
          safeVaultWrite(vaultRoot, path.join(vaultRoot, "absolute.txt"), "blocked").pipe(
            Effect.provide(NodeServices.layer),
          ),
        ),
      ).rejects.toMatchObject({
        _tag: "SafeVaultWriteError",
        code: "PATH_INVALID",
        path: path.join(vaultRoot, "absolute.txt"),
      });
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });
});
