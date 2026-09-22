import { storageError } from "./errors";
import type { ObjectStat, StorageVerificationRecord, StorageVersionOptions } from "./types";

export interface ExactStorageVersion {
  immutableGeneration?: string;
  immutableVersion?: string;
}

function clean(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || /[\0\r\n]/.test(value)) {
    throw storageError("storage_version_invalid");
  }
  return value;
}

/** Normalize all accepted aliases and reject two names for different values. */
export function exactVersion(options: StorageVersionOptions | undefined): ExactStorageVersion {
  if (!options) return {};
  const generation = clean(options.immutableGeneration);
  const expectedGeneration = clean(options.expectedImmutableGeneration);
  const aliasGeneration = clean(options.generation);
  const version = clean(options.immutableVersion);
  const expectedVersion = clean(options.expectedImmutableVersion);
  const aliasVersion = clean(options.version);
  const generations = [generation, expectedGeneration, aliasGeneration].filter((value): value is string => value !== undefined);
  const versions = [version, expectedVersion, aliasVersion].filter((value): value is string => value !== undefined);
  if (new Set(generations).size > 1 || new Set(versions).size > 1) throw storageError("storage_version_mismatch");
  return { immutableGeneration: generations[0], immutableVersion: versions[0] };
}

export function hasExactVersion(version: ExactStorageVersion | undefined): boolean {
  return Boolean(version?.immutableGeneration || version?.immutableVersion);
}

export function assertExactVersion(actual: ExactStorageVersion | undefined, expected: ExactStorageVersion | undefined, requireExpected = false): ExactStorageVersion {
  const actualVersion = exactVersion(actual);
  const expectedVersion = exactVersion(expected);
  if (requireExpected && !hasExactVersion(expectedVersion)) throw storageError("storage_version_missing");
  if (hasExactVersion(expectedVersion)) {
    if (expectedVersion.immutableGeneration !== undefined && actualVersion.immutableGeneration === undefined) throw storageError("storage_version_missing");
    if (expectedVersion.immutableVersion !== undefined && actualVersion.immutableVersion === undefined) throw storageError("storage_version_missing");
    if (expectedVersion.immutableGeneration !== undefined && actualVersion.immutableGeneration !== expectedVersion.immutableGeneration) throw storageError("storage_version_mismatch");
    if (expectedVersion.immutableVersion !== undefined && actualVersion.immutableVersion !== expectedVersion.immutableVersion) throw storageError("storage_version_mismatch");
  }
  return actualVersion;
}

export function versionFromRecord(value: ObjectStat | StorageVerificationRecord): ExactStorageVersion {
  return exactVersion(value);
}
