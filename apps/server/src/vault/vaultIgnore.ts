const IGNORED_SEGMENTS = new Set([
  ".atlas",
  ".git",
  ".next",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
]);

const toPosix = (value: string): string => value.replaceAll("\\", "/");

export function isIgnoredVaultRelativePath(relativePath: string): boolean {
  return toPosix(relativePath)
    .split("/")
    .some(
      (segment) => segment.length > 0 && (segment.startsWith(".") || IGNORED_SEGMENTS.has(segment)),
    );
}

export function isIgnoredVaultName(name: string): boolean {
  return name.startsWith(".") || IGNORED_SEGMENTS.has(name);
}

export const ignoredVaultWatchPatterns: ReadonlyArray<RegExp> = Array.from(
  IGNORED_SEGMENTS,
  (segment) => new RegExp(`(^|/)${segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(/|$)`),
).concat(/(^|\/)\.[^/]+(\/|$)/);
