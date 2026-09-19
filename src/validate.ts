/**
 * Pure validation for listings and swap math. No I/O, no chain reads —
 * chain truth is checked in verify.ts against fetched transactions.
 */
import type { AssetKind, Listing, NewListing } from "./types.ts";

export const MAX_FEE_BPS = 10000;
export const MAX_LISTINGS_TITLE = 120;
export const MAX_LISTINGS_DESC = 500;

export function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

/** Marketplace fee: basis points of price, minimum 1 sat. */
export function feeSats(priceSats: number, feeBps: number): number {
  return Math.max(1, Math.floor((priceSats * feeBps) / MAX_FEE_BPS));
}

export function parseOutpoint(origin: unknown): { txid: string; vout: number } | null {
  if (typeof origin !== "string") return null;
  const m = /^([0-9a-fA-F]{64})\.(\d{1,10})$/.exec(origin.trim());
  if (!m) return null;
  return { txid: m[1]!.toLowerCase(), vout: Number(m[2]) };
}

function isHex(s: unknown): s is string {
  return typeof s === "string" && s.length > 0 && s.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(s);
}

/** 25-byte P2PKH locking script: OP_DUP OP_HASH160 <20B> OP_EQUALVERIFY OP_CHECKSIG. */
export function isP2PKH(scriptHex: string): boolean {
  return /^[0-9a-fA-F]{50}$/.test(scriptHex) && scriptHex.toLowerCase().startsWith("76a914") && scriptHex.toLowerCase().endsWith("88ac");
}

function optStr(v: unknown, max: number, name: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || !v.trim() || v.length > max) fail("BAD_PARAM", `${name} must be 1-${max} chars`);
  return (v as string).trim();
}

function reqStr(v: unknown, max: number, name: string): string {
  const s = optStr(v, max, name);
  if (!s) fail("BAD_PARAM", `${name} is required`);
  return s;
}

/**
 * Normalize a client-submitted listing into a validated draft (no
 * timestamps/status). Throws BAD_PARAM with a human reason. Atomic offers
 * (sellerUnlock present) must carry the matching payScript; direct sales
 * carry neither.
 */
export function validateListing(body: NewListing): Omit<Listing,
  "status" | "buyTxid" | "buyerHandle" | "transferTxid" | "createdAt" | "updatedAt"> {
  if (!body || typeof body !== "object") fail("BAD_PARAM", "listing must be an object");
  const outpoint = parseOutpoint((body as NewListing).origin);
  if (!outpoint) fail("BAD_PARAM", "origin must be <64-hex-txid>.<vout>");
  const kind = (body as NewListing).assetKind ?? "ordinal";
  if (kind !== "ordinal" && kind !== "bsv21") fail("BAD_PARAM", "assetKind must be ordinal or bsv21");
  const assetKind = kind as AssetKind;
  const title = reqStr((body as NewListing).title, MAX_LISTINGS_TITLE, "title");
  const priceSats = Math.floor(Number((body as NewListing).priceSats));
  if (!Number.isFinite(priceSats) || priceSats < 1) fail("BAD_PARAM", "priceSats must be a positive sat number");
  const seller = reqStr((body as NewListing).seller, 64, "seller");
  const feeBps = (body as NewListing).feeBps === undefined ? 200 : Math.floor(Number((body as NewListing).feeBps));
  if (!Number.isFinite(feeBps) || feeBps < 0 || feeBps > MAX_FEE_BPS) {
    fail("BAD_PARAM", "feeBps must be 0-10000");
  }
  const feeAddress = reqStr((body as NewListing).feeAddress, 64, "feeAddress");
  const raw = body as NewListing;
  const sellerUnlock = raw.sellerUnlock === undefined || raw.sellerUnlock === null ? null : String(raw.sellerUnlock);
  const payScript = raw.payScript === undefined || raw.payScript === null ? null : String(raw.payScript);
  if (sellerUnlock !== null && !isHex(sellerUnlock)) fail("BAD_PARAM", "sellerUnlock must be hex");
  if (payScript !== null && !isP2PKH(payScript)) fail("BAD_PARAM", "payScript must be a P2PKH script");
  if ((sellerUnlock === null) !== (payScript === null)) {
    fail("BAD_PARAM", "atomic offers need both sellerUnlock and payScript; direct sales need neither");
  }
  let tokenId: string | null = null;
  let tokenAmount: string | null = null;
  if (assetKind === "bsv21") {
    const id = typeof raw.tokenId === "string" ? raw.tokenId.trim().toLowerCase() : "";
    if (!/^([0-9a-f]{64})_(\d+)$/.test(id)) fail("BAD_PARAM", "tokenId must be <64-hex-txid>_<vout>");
    tokenId = id;
    const amt = typeof raw.tokenAmount === "string" ? raw.tokenAmount.trim() : "";
    if (!/^\d+$/.test(amt) || amt === "0") fail("BAD_PARAM", "tokenAmount must be a positive base-unit integer string");
    tokenAmount = String(BigInt(amt));
  }
  let metadata: Record<string, unknown> = {};
  if (raw.metadata !== undefined && raw.metadata !== null) {
    if (typeof raw.metadata !== "object" || Array.isArray(raw.metadata)) {
      fail("BAD_PARAM", "metadata must be an object");
    }
    metadata = raw.metadata as Record<string, unknown>;
  }
  return {
    origin: `${outpoint!.txid}.${outpoint!.vout}`,
    assetKind,
    title,
    image: optStr(raw.image, 500, "image"),
    description: optStr(raw.description, MAX_LISTINGS_DESC, "description"),
    metadata,
    priceSats,
    seller,
    sellerHandle: optStr(raw.sellerHandle, 64, "sellerHandle"),
    sellerUnlock,
    payScript,
    tokenId,
    tokenAmount,
    feeBps,
    feeAddress,
  };
}
