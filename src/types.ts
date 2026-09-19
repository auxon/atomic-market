/**
 * Generic listing shapes. Pet-specific fields (nickname, species, rarity…)
 * live in `metadata` — the order book only understands assets, prices,
 * swap offers, and settlement states.
 */

export type AssetKind = "ordinal" | "bsv21";
export type ListingStatus = "active" | "paid" | "sold" | "cancelled";

export interface Listing {
  origin: string;
  assetKind: AssetKind;
  title: string;
  image: string | null;
  description: string | null;
  metadata: Record<string, unknown>;
  priceSats: number;
  seller: string;
  sellerHandle: string | null;
  sellerUnlock: string | null;
  payScript: string | null;
  inputScript: string | null;
  tokenId: string | null;
  tokenAmount: string | null;
  feeBps: number;
  feeAddress: string;
  status: ListingStatus;
  buyTxid: string | null;
  buyerHandle: string | null;
  transferTxid: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface NewListing {
  origin: unknown;
  assetKind?: unknown;
  title?: unknown;
  image?: unknown;
  description?: unknown;
  metadata?: unknown;
  priceSats?: unknown;
  seller?: unknown;
  sellerHandle?: unknown;
  sellerUnlock?: unknown;
  payScript?: unknown;
  tokenId?: unknown;
  tokenAmount?: unknown;
  feeBps?: unknown;
  feeAddress?: unknown;
}

/** Minimal chain-tx view the verifier needs (WhatsOnChain shape). */
export interface ChainTx {
  txid: string;
  vin: Array<{ txid: string; vout: number }>;
  vout: Array<{ value: number; n: number; scriptPubKey: { hex: string; addresses?: string[] } }>;
}

export type FetchTx = (txid: string) => Promise<ChainTx | null>;
