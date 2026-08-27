import {
  MAX_COMPUTE_UNIT_LIMIT,
  estimateComputeUnitLimitFactory,
  updateOrAppendSetComputeUnitLimitInstruction,
  updateOrAppendSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import {
  appendTransactionMessageInstructions,
  assertIsFullySignedTransaction,
  assertIsSendableTransaction,
  assertIsTransactionMessageWithBlockhashLifetime,
  assertIsTransactionWithinSizeLimit,
  assertIsTransactionWithBlockhashLifetime,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Commitment,
  type Instruction,
  type MicroLamports,
  type Rpc,
  type RpcSubscriptions,
  type Signature,
  type SolanaRpcApi,
  type SolanaRpcSubscriptionsApi,
  type TransactionMessage,
  type TransactionMessageWithBlockhashLifetime,
  type TransactionMessageWithFeePayer,
  type TransactionSigner,
} from "@solana/kit";

export interface SasClient {
  rpc: Rpc<SolanaRpcApi>;
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
}

export function createSasClient(httpUrl: string, websocketUrl: string): SasClient {
  return {
    rpc: createSolanaRpc(httpUrl),
    rpcSubscriptions: createSolanaRpcSubscriptions(websocketUrl),
  };
}

async function createDefaultTransaction(
  client: SasClient,
  feePayer: TransactionSigner,
  computeLimit: number = MAX_COMPUTE_UNIT_LIMIT,
  feeMicroLamports: MicroLamports = 1n as MicroLamports,
) {
  const { value: latestBlockhash } = await client.rpc.getLatestBlockhash().send();
  return pipe(
    createTransactionMessage({ version: 0 }),
    (transaction) => setTransactionMessageFeePayerSigner(feePayer, transaction),
    (transaction) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, transaction),
    (transaction) => updateOrAppendSetComputeUnitPriceInstruction(feeMicroLamports, transaction),
    (transaction) => updateOrAppendSetComputeUnitLimitInstruction(computeLimit, transaction),
  );
}

async function signAndSendTransaction(
  client: SasClient,
  transactionMessage: TransactionMessage &
    TransactionMessageWithFeePayer &
    TransactionMessageWithBlockhashLifetime,
  commitment: Commitment = "confirmed",
): Promise<Signature> {
  assertIsTransactionMessageWithBlockhashLifetime(transactionMessage);
  const signedTransaction = await signTransactionMessageWithSigners(transactionMessage);
  const signature = getSignatureFromTransaction(signedTransaction);

  assertIsFullySignedTransaction(signedTransaction);
  assertIsTransactionWithinSizeLimit(signedTransaction);
  assertIsSendableTransaction(signedTransaction);
  assertIsTransactionWithBlockhashLifetime(signedTransaction);

  await sendAndConfirmTransactionFactory(client)(signedTransaction, { commitment });
  return signature;
}

export async function sendAndConfirmInstructions(
  client: SasClient,
  payer: TransactionSigner,
  instructions: Instruction[],
): Promise<Signature> {
  const simulationTransaction = await pipe(
    await createDefaultTransaction(client, payer),
    (transaction) => appendTransactionMessageInstructions(instructions, transaction),
  );
  const estimateCompute = estimateComputeUnitLimitFactory({ rpc: client.rpc });
  const computeUnitLimit = await estimateCompute(simulationTransaction);

  return pipe(
    await createDefaultTransaction(client, payer, computeUnitLimit),
    (transaction) => appendTransactionMessageInstructions(instructions, transaction),
    (transaction) => signAndSendTransaction(client, transaction),
  );
}
