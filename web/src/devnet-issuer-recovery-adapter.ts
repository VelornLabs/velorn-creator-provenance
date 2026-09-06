import {
  clearDevnetIssuerRecoveryRecord,
  loadDevnetIssuerRecoveryRecord,
  saveDevnetIssuerRecoveryRecord,
  type DevnetIssuerRecoveryBinding,
  type DevnetIssuerRecoveryRecordV1,
  type SaveDevnetIssuerRecoveryResult,
  type SaveDevnetIssuerRecoveryInput,
} from "./devnet-issuer-recovery.js";

/** Captures the fixed storage functions without exposing storage to the UI. */
export interface DevnetIssuerRecoveryRecord {
  save(input: SaveDevnetIssuerRecoveryInput): Promise<SaveDevnetIssuerRecoveryResult>;
  load(input: DevnetIssuerRecoveryBinding): Promise<DevnetIssuerRecoveryRecordV1 | null>;
  clear(expected: DevnetIssuerRecoveryRecordV1): Promise<boolean>;
}

export function createDevnetIssuerRecoveryRecord(): DevnetIssuerRecoveryRecord {
  return Object.freeze({
    save: saveDevnetIssuerRecoveryRecord,
    load: loadDevnetIssuerRecoveryRecord,
    clear: clearDevnetIssuerRecoveryRecord,
  });
}
