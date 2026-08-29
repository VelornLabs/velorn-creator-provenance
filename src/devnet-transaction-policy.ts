import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import type { AccountMeta, Instruction, ReadonlyUint8Array } from "@solana/kit";

/**
 * Pinned only for the isolated Devnet walkthrough.
 *
 * Phantom automatically adds priority-fee instructions when a transaction has
 * none. Supplying a small, explicit policy keeps the transaction bytes stable
 * across wallet review while still leaving the exact fee visible to the user.
 */
export const LOCAL_DEVNET_SINGLE_SAS_COMPUTE_UNIT_LIMIT = 200_000;
export const LOCAL_DEVNET_COMBINED_ENROLLMENT_COMPUTE_UNIT_LIMIT = 400_000;
export const LOCAL_DEVNET_COMPUTE_UNIT_PRICE_MICROLAMPORTS = 1_000n;
export const LOCAL_DEVNET_COMPUTE_BUDGET_INSTRUCTION_COUNT = 2;

export function createPinnedLocalDevnetComputeBudgetInstructions(
  computeUnitLimit: number,
): readonly Instruction[] {
  if (
    computeUnitLimit !== LOCAL_DEVNET_SINGLE_SAS_COMPUTE_UNIT_LIMIT &&
    computeUnitLimit !== LOCAL_DEVNET_COMBINED_ENROLLMENT_COMPUTE_UNIT_LIMIT
  ) {
    throw new TypeError("unsupported local Devnet compute-unit limit");
  }
  return Object.freeze([
    getSetComputeUnitLimitInstruction({
      units: computeUnitLimit,
    }),
    getSetComputeUnitPriceInstruction({
      microLamports: LOCAL_DEVNET_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
    }),
  ]);
}

function bytesEqual(
  left: ReadonlyUint8Array | undefined,
  right: ReadonlyUint8Array | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function accountsEqual(
  left: readonly AccountMeta[] | undefined,
  right: readonly AccountMeta[] | undefined,
): boolean {
  const leftAccounts = left ?? [];
  const rightAccounts = right ?? [];
  return (
    leftAccounts.length === rightAccounts.length &&
    leftAccounts.every(
      (account, index) =>
        account.address === rightAccounts[index]?.address &&
        account.role === rightAccounts[index]?.role,
    )
  );
}

export function hasExactPinnedLocalDevnetComputeBudget(
  instructions: readonly Instruction[],
  computeUnitLimit: number,
): boolean {
  const expected = createPinnedLocalDevnetComputeBudgetInstructions(
    computeUnitLimit,
  );
  if (instructions.length < expected.length) return false;
  return expected.every((instruction, index) => {
    const candidate = instructions[index];
    return (
      candidate !== undefined &&
      candidate.programAddress === instruction.programAddress &&
      accountsEqual(candidate.accounts, instruction.accounts) &&
      bytesEqual(candidate.data, instruction.data)
    );
  });
}
