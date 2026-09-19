/**
 * Chain verification for listings, buys, and settlements. Takes a
 * `fetchTx` injector (WhatsOnChain in production, fixtures in tests) —
 * no network, no D1 here.
 *
 * Race semantics are PocketPets-compatible: buy requires status active
 * plus a valid payment; the first valid buy wins and later ones see
 * ALREADY_SOLD. Double-spends that never confirm are the buyer's risk;
 * settlement confirms the asset actually moved.
 */
import { feeSats, parseOutpoint, fail } from "./validate.ts";
import type { ChainTx, FetchTx, Listing } from "./types.ts";

function outpoints(tx: ChainTx): Array<{ txid: string; vout: number }> {
  return (tx.vin ?? []).map((i) => ({ txid: String(i.txid).toLowerCase(), vout: Number(i.vout) }));
}

function utf8Hex(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * Hex of the transfer JSON a token output must embed. Key order matches
 * the daemon's bsv21TransferScript exactly ({p, op, id, amt}) so this
 * substring search is byte-exact, no script parser needed.
 */
export function transferJsonHex(tokenId: string, tokenAmount: string): string {
  return utf8Hex(JSON.stringify({ p: "bsv-20", op: "transfer", id: tokenId, amt: tokenAmount }));
}

function carriesTokens(scriptHex: string, tokenId: string, tokenAmount: string): boolean {
  return scriptHex.toLowerCase().includes(transferJsonHex(tokenId, tokenAmount));
}

/** The listed asset outpoint must exist on chain. Atomic ordinal carriers must be 1 sat. */
export async function verifyListParent(fetchTx: FetchTx, listing: Pick<Listing, "origin" | "assetKind" | "sellerUnlock" | "tokenId" | "tokenAmount">): Promise<{ scriptHex: string; value: number }> {
  const parts = parseOutpoint(listing.origin);
  if (!parts) fail("BAD_PARAM", "origin must be <64-hex-txid>.<vout>");
  const tx = await fetchTx(parts!.txid);
  if (!tx) fail("PARENT_MISSING", `asset parent ${parts!.txid} not found on chain`);
  const out = (tx!.vout ?? []).find((o) => Number(o.n) === parts!.vout);
  if (!out) fail("PARENT_MISSING", `asset outpoint ${listing.origin} not found on chain`);
  if (listing.sellerUnlock === null) {
    return { scriptHex: String(out!.scriptPubKey?.hex ?? ""), value: Number(out!.value) };
  }
  if (listing.assetKind === "ordinal") {
    if (Number(out!.value) !== 1) fail("BAD_PARAM", "ordinal carriers must be exactly 1 sat");
    return { scriptHex: String(out!.scriptPubKey?.hex ?? ""), value: Number(out!.value) };
  }
  if (!listing.tokenId || !listing.tokenAmount) fail("BAD_PARAM", "bsv21 listings need tokenId + tokenAmount");
  if (!carriesTokens(String(out!.scriptPubKey?.hex ?? ""), listing.tokenId, listing.tokenAmount)) {
    fail("BAD_PARAM", "parent outpoint is not the listed token output");
  }
  return { scriptHex: String(out!.scriptPubKey?.hex ?? ""), value: Number(out!.value) };
}

/**
 * The buy tx must pay the listed price to the seller's exact script and
 * the market fee to the fee address. Atomic offers match payScript
 * byte-exact; direct sales match the seller address.
 */
export async function verifyBuy(fetchTx: FetchTx, listing: Listing, buyTxid: string): Promise<void> {
  if (!/^[0-9a-fA-F]{64}$/.test(buyTxid)) fail("BAD_PARAM", "buyTxid must be a 64-hex txid");
  const tx = await fetchTx(buyTxid.toLowerCase());
  if (!tx) fail("TX_UNKNOWN", `buy tx ${buyTxid} not found on chain`);
  const outs = tx!.vout ?? [];
  const paid = listing.payScript
    ? outs.some((o) => Number(o.value) === listing.priceSats && String(o.scriptPubKey?.hex).toLowerCase() === listing.payScript!.toLowerCase())
    : outs.some((o) => Number(o.value) === listing.priceSats && (o.scriptPubKey?.addresses ?? []).includes(listing.seller));
  if (!paid) fail("BAD_PAYMENT", `buy tx does not pay ${listing.priceSats} sats to the seller`);
  const expectedFee = listing.feeBps === 0 ? 0 : feeSats(listing.priceSats, listing.feeBps);
  if (expectedFee > 0) {
    const feeOk = outs.some((o) => Number(o.value) === expectedFee && (o.scriptPubKey?.addresses ?? []).includes(listing.feeAddress));
    if (!feeOk) fail("BAD_FEE", `buy tx is missing the ${expectedFee}-sat market fee to ${listing.feeAddress}`);
  }
  // BSV21: the buy must also move the listed tokens (exact output is the
  // daemon's job at completion; here we prove the transfer exists).
  if (listing.assetKind === "bsv21") {
    if (!listing.tokenId || !listing.tokenAmount) fail("BAD_PARAM", "bsv21 listings need tokenId + tokenAmount");
    const moved = outs.some((o) => carriesTokens(String(o.scriptPubKey?.hex ?? ""), listing.tokenId!, listing.tokenAmount!));
    if (!moved) fail("BAD_TRANSFER", "buy tx does not move the listed tokens");
  }
}

/** The settlement tx must spend the listed asset outpoint. */
export async function verifySettle(fetchTx: FetchTx, listing: Listing, transferTxid: string): Promise<void> {
  if (!/^[0-9a-fA-F]{64}$/.test(transferTxid)) fail("BAD_PARAM", "transferTxid must be a 64-hex txid");
  const parts = parseOutpoint(listing.origin);
  if (!parts) fail("BAD_PARAM", "origin must be <64-hex-txid>.<vout>");
  const tx = await fetchTx(transferTxid.toLowerCase());
  if (!tx) fail("TX_UNKNOWN", `transfer tx ${transferTxid} not found on chain`);
  const moved = outpoints(tx!).some((i) => i.txid === parts!.txid && i.vout === parts!.vout);
  if (!moved) fail("BAD_TRANSFER", `transfer tx does not spend ${listing.origin}`);
}
