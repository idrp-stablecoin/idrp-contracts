export interface SendResult {
  txHash: string; // EVM: receipt.transactionHash
  scanLink: string; // LayerZero Scan link for cross-chain tracking
}
