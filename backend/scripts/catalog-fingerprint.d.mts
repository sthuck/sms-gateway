/** Ambient types for catalog-fingerprint.mjs (imported from Vitest). */
export const EXPECTED_CATALOG_PATH: string;
export function captureCatalog(client: unknown): Promise<CatalogFingerprint>;
export function assertMigratorOwnership(client: unknown): Promise<string[]>;
export function stableStringify(catalog: CatalogFingerprint): string;
export function diffCatalogs(
  left: CatalogFingerprint,
  right: CatalogFingerprint,
  labels?: { leftLabel?: string; rightLabel?: string },
): string[];
export function loadExpectedCatalog(): CatalogFingerprint;
export function diffAgainstExpected(actual: CatalogFingerprint): string[];
export function formatCatalogDiffs(diffs: string[], header?: string): string;

export type CatalogFingerprint = {
  version: number;
  roles: unknown[];
  tables: unknown[];
  policies: unknown[];
  functions: unknown[];
  namespaces: unknown[];
  database: unknown;
  defaultAcls: unknown[];
};
