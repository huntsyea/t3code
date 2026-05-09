import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopObservability from "./DesktopObservability.ts";

const MIGRATION_SKIPPED_MARKER = ".migration-skipped";
const LEGACY_USERDATA_DIR_NAME = "userdata";
const ATLAS_USERDATA_DIR_NAME = "userdata";

const MIGRATE_BUTTON_INDEX = 0;
const SKIP_BUTTON_INDEX = 1;
const DONT_ASK_AGAIN_BUTTON_INDEX = 2;

export interface DesktopAtlasMigrationShape {
  readonly run: Effect.Effect<void>;
}

export class DesktopAtlasMigration extends Context.Service<
  DesktopAtlasMigration,
  DesktopAtlasMigrationShape
>()("t3/desktop/AtlasMigration") {}

const { logInfo, logWarning, logError } =
  DesktopObservability.makeComponentLogger("desktop-atlas-migration");

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const electronDialog = yield* ElectronDialog.ElectronDialog;

  const legacyUserdataPath = environment.path.join(
    environment.legacyBaseDir,
    LEGACY_USERDATA_DIR_NAME,
  );
  const atlasUserdataPath = environment.path.join(environment.baseDir, ATLAS_USERDATA_DIR_NAME);
  const migrationSkippedMarkerPath = environment.path.join(
    environment.baseDir,
    MIGRATION_SKIPPED_MARKER,
  );

  const directoryHasEntries = (dirPath: string) =>
    fileSystem.readDirectory(dirPath).pipe(
      Effect.map((entries) => entries.length > 0),
      Effect.orElseSucceed(() => false),
    );

  const pathExists = (target: string) =>
    fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false));

  const writeMigrationSkippedMarker = Effect.gen(function* () {
    yield* fileSystem.makeDirectory(environment.baseDir, { recursive: true }).pipe(Effect.ignore);
    yield* fileSystem.writeFileString(migrationSkippedMarkerPath, "").pipe(
      Effect.catchCause((cause) =>
        logWarning("failed to write migration-skipped marker", {
          path: migrationSkippedMarkerPath,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

  const performCopy = Effect.gen(function* () {
    yield* logInfo("copying legacy userdata to atlas baseDir", {
      source: legacyUserdataPath,
      destination: atlasUserdataPath,
    });
    yield* fileSystem.makeDirectory(environment.baseDir, { recursive: true }).pipe(Effect.ignore);
    yield* fileSystem.copy(legacyUserdataPath, atlasUserdataPath, {
      overwrite: false,
      preserveTimestamps: true,
    });
    yield* logInfo("legacy userdata copied", {
      destination: atlasUserdataPath,
    });
  });

  const showMigrationFailureDialog = (message: string, detail: string) =>
    electronDialog.showMessageBox({
      type: "error",
      title: "Migration failed",
      message,
      detail,
      buttons: ["OK"],
    });

  const promptAndMigrate = Effect.gen(function* () {
    const result = yield* electronDialog.showMessageBox({
      type: "question",
      title: "Existing T3 Code data found",
      message:
        "Migrate your projects, threads, and settings to Atlas? You can do this later from Settings.",
      buttons: ["Migrate now", "Skip for now", "Don't ask again"],
      defaultId: MIGRATE_BUTTON_INDEX,
      cancelId: SKIP_BUTTON_INDEX,
      noLink: true,
    });

    switch (result.response) {
      case MIGRATE_BUTTON_INDEX: {
        const copyExit = yield* Effect.exit(performCopy);
        if (Exit.isFailure(copyExit)) {
          const causeText = Cause.pretty(copyExit.cause);
          yield* logError("legacy userdata migration failed", {
            source: legacyUserdataPath,
            destination: atlasUserdataPath,
            cause: causeText,
          });
          yield* showMigrationFailureDialog(
            "Atlas could not migrate your T3 Code data.",
            `Your original data at ${legacyUserdataPath} was not modified.\n\n${causeText}`,
          );
        }
        return;
      }
      case DONT_ASK_AGAIN_BUTTON_INDEX: {
        yield* writeMigrationSkippedMarker;
        yield* logInfo("user declined further migration prompts");
        return;
      }
      case SKIP_BUTTON_INDEX:
      default: {
        yield* logInfo("user skipped migration for this launch");
        return;
      }
    }
  });

  const run = Effect.gen(function* () {
    if (environment.isDevelopment) return;

    const markerExists = yield* pathExists(migrationSkippedMarkerPath);
    if (markerExists) return;

    const legacyExists = yield* pathExists(legacyUserdataPath);
    if (!legacyExists) return;

    const atlasHasEntries = yield* directoryHasEntries(atlasUserdataPath);
    if (atlasHasEntries) return;

    yield* promptAndMigrate;
  }).pipe(
    Effect.catchCause((cause) =>
      logWarning("atlas migration check aborted", { cause: Cause.pretty(cause) }),
    ),
    Effect.withSpan("desktop.atlasMigration.run"),
  );

  return DesktopAtlasMigration.of({ run });
});

export const layer = Layer.effect(DesktopAtlasMigration, make);
