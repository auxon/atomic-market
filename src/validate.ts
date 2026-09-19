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

const SEQ_FINAL = 0xffffffff;

function outpointOf(txid: unknown, vout: unknown): string | null {
  if (typeof txid !== "string" || !/^[0-9a-fA-F]{64}$/.test(txid)) return null;
  const n = Number(vout);
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) return null;
  return `${txid.toLowerCase()}.${n}`;
}

function offerInput(v: unknown, i: number): { txid: string; vout: number; scriptHex: string; sequence: number } {
  if (!v || typeof v !== "object") fail("BAD_PARAM", `offer.inputs[${i}] must be an object`);
  const o = v as Record<string, unknown>;
  const origin = outpointOf(o.txid, o.vout);
  if (!origin) fail("BAD_PARAM", `offer.inputs[${i}] must be a 64-hex txid + vout`);
  if (!isHex(o.scriptHex)) fail("BAD_PARAM", `offer.inputs[${i}].scriptHex must be hex`);
  if (o.sequence !== undefined && Number(o.sequence) !== SEQ_FINAL) {
    fail("BAD_PARAM", `offer.inputs[${i}].sequence must be final`);
  }
  const [txid, vout] = origin.split(".");
  return {
    txid: txid!,
    vout: Number(vout),
    scriptHex: String(o.scriptHex).toLowerCase(),
    sequence: SEQ_FINAL,
  };
}

/**
 * Atomic offer shape check (chain truth is verified in verify.ts):
 * - v4 ordinal: dual inputs [1-sat plain prefix, inscribed carrier], the
 *   carrier is the listing origin, FIFO-safe output order is the buyer's job.
 * - v3 bsv21: single exact-amount token carrier with its transfer envelope.
 * Legacy v2 (sellerUnlock/payScript) is refused outright — not indexer-safe.
 */
export function validateOffer(offer: unknown, origin: string, priceSats: number): unknown {
  if (!offer || typeof offer !== "object" || Array.isArray(offer)) {
    fail("BAD_PARAM", "offer must be an object");
  }
  const o = offer as Record<string, unknown>;
  const kind = o.kind;
  const version = Number(o.version);
  if (Math.floor(Number(o.priceSats)) !== priceSats) fail("BAD_PARAM", "offer.priceSats must equal the listing price");
  if (o.lockTime !== 0) fail("BAD_PARAM", "offer.lockTime must be 0");
  if (kind === "ordlock") {
    // The covenant lives on-chain; the worker decodes the lock script and
    // re-checks price + payout in verify.ts.
    if (version !== 5) fail("BAD_PARAM", "ordlock offers must be v5");
    return { version: 5, kind: "ordlock", priceSats, lockTime: 0 };
  }
  if (!isP2PKH(String(o.payScriptHex ?? ""))) fail("BAD_PARAM", "offer.payScriptHex must be a P2PKH script");
  if (kind === "ordinal") {
    if (version !== 4) fail("BAD_PARAM", "ordinal offers must be v4 (v2 is not indexer-safe)");
    if (!Array.isArray(o.inputs) || o.inputs.length !== 2) {
      fail("BAD_PARAM", "v4 offers carry exactly two inputs (1-sat prefix + carrier)");
    }
    const rawInputs = o.inputs as Array<Record<string, unknown>>;
    const inputs = [offerInput(rawInputs[0], 0), offerInput(rawInputs[1], 1)];
    const unlocks = rawInputs.map((it, i) => {
      if (!isHex(it?.unlockHex)) fail("BAD_PARAM", `offer.inputs[${i}].unlockHex must be hex`);
      return String(it.unlockHex).toLowerCase();
    });
    if (origin !== `${inputs[1]!.txid}.${inputs[1]!.vout}`) {
      fail("BAD_PARAM", "listing origin must be the carrier (offer.inputs[1])");
    }
    return {
      version: 4, kind: "ordinal",
      inputs: inputs.map((input, i) => ({ ...input, unlockHex: unlocks[i]! })),
      payScriptHex: String(o.payScriptHex).toLowerCase(), priceSats, lockTime: 0,
    };
  }
  if (kind === "bsv21") {
    if (version !== 3) fail("BAD_PARAM", "bsv21 offers must be v3");
    const input = offerInput(o.input, 0);
    if (!isHex(o.unlockHex)) fail("BAD_PARAM", "offer.unlockHex must be hex");
    if (origin !== `${input.txid}.${input.vout}`) {
      fail("BAD_PARAM", "listing origin must be the token carrier (offer.input)");
    }
    const id = typeof o.tokenId === "string" ? o.tokenId.trim().toLowerCase() : "";
    if (!/^([0-9a-f]{64})_(\d+)$/.test(id)) fail("BAD_PARAM", "offer.tokenId must be <64-hex-txid>_<vout>");
    const amt = typeof o.tokenAmount === "string" ? o.tokenAmount.trim() : "";
    if (!/^\d+$/.test(amt) || amt === "0") fail("BAD_PARAM", "offer.tokenAmount must be a positive base-unit integer string");
    return {
      version: 3, kind: "bsv21", input, unlockHex: String(o.unlockHex).toLowerCase(),
      payScriptHex: String(o.payScriptHex).toLowerCase(), priceSats, lockTime: 0,
      tokenId: id, tokenAmount: String(BigInt(amt)),
    };
  }
  fail("BAD_PARAM", "offer.kind must be ordinal or bsv21");
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
  // Legacy v2 shape: refused outright (not indexer-safe).
  if (raw.sellerUnlock !== undefined && raw.sellerUnlock !== null) {
    fail(
      "BAD_PARAM",
      "v2 atomic offers are not indexer-safe (the inscribed sat lands on the payment output); re-list with a v4 offer",
    );
  }
  if (raw.payScript !== undefined && raw.payScript !== null) {
    fail("BAD_PARAM", "payScript belongs inside the offer object");
  }
  const origin = `${outpoint!.txid}.${outpoint!.vout}`;
  const offer = raw.offer === undefined || raw.offer === null ? null : validateOffer(raw.offer, origin, priceSats);
  // Pre-signed ordinal offers (v2/v4) stay blocked: v2 sends the
  // inscription to the payment output; v4 is funds-safe but the indexer's
  // lazy backward crawl attributes the buyer's output to the prefix, so
  // the NFT vanishes from wallets. OrdLock (v5) is the indexer-safe path;
  // v3 BSV21 swaps are envelope-tracked and stay valid.
  if (offer && (offer as { kind?: string }).kind === "ordinal") {
    fail(
      "BAD_PARAM",
      "pre-signed ordinal offers are not indexer-resolvable; list with OrdLock instead",
    );
  }
  let tokenId: string | null = null;
  let tokenAmount: string | null = null;
  if (offer && (offer as { kind: string }).kind === "bsv21") {
    tokenId = (offer as { tokenId: string }).tokenId;
    tokenAmount = (offer as { tokenAmount: string }).tokenAmount;
  }
  let metadata: Record<string, unknown> = {};
  if (raw.metadata !== undefined && raw.metadata !== null) {
    if (typeof raw.metadata !== "object" || Array.isArray(raw.metadata)) {
      fail("BAD_PARAM", "metadata must be an object");
    }
    metadata = raw.metadata as Record<string, unknown>;
  }
  return {
    origin,
    assetKind,
    title,
    image: optStr(raw.image, 500, "image"),
    description: optStr(raw.description, MAX_LISTINGS_DESC, "description"),
    metadata,
    priceSats,
    seller,
    sellerHandle: optStr(raw.sellerHandle, 64, "sellerHandle"),
    offer,
    sellerUnlock: null,
    payScript: offer && (offer as { payScriptHex?: string }).payScriptHex
      ? (offer as { payScriptHex: string }).payScriptHex
      : null, // ordlock: pinned from the lock script at list time
    inputScript: null,
    tokenId,
    tokenAmount,
    feeBps,
    feeAddress,
  };
}
