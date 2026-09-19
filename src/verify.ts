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

export const ORDLOCK_PREFIX =
  "2097dfd76851bf465e8f715593b217714858bbe9570ff3bd5e33840a34e20ff0262102ba79df5f8ae7604a9830f03c7933028186aede0675a16f025dc4f8be8eec0382201008ce7480da41702918d1ec8e6849ba32b4d65b1e40dc669c31a1e6306b266c0000";
export const ORDLOCK_SUFFIX =
  "615179547a75537a537a537a0079537a75527a527a7575615579008763567901c161517957795779210ac407f0e4bd44bfc207355a778b046225a7068fc59ee7eda43ad905aadbffc800206c266b30e6a1319c66dc401e5bd6b432ba49688eecd118297041da8074ce081059795679615679aa0079610079517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e01007e81517a75615779567956795679567961537956795479577995939521414136d08c5ed2bf3ba048afe6dcaebafeffffffffffffffffffffffffffffff00517951796151795179970079009f63007952799367007968517a75517a75517a7561527a75517a517951795296a0630079527994527a75517a6853798277527982775379012080517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f517f7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e7c7e01205279947f7754537993527993013051797e527e54797e58797e527e53797e52797e57797e0079517a75517a75517a75517a75517a75517a75517a75517a75517a75517a75517a75517a75517a756100795779ac517a75517a75517a75517a75517a75517a75517a75517a75517a7561517a75517a756169587951797e58797eaa577961007982775179517958947f7551790128947f77517a75517a75618777777777777777777767557951876351795779a9876957795779ac777777777777777767006868";

function hexToBytes(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

function indexOfBytes(hay: number[], needle: number[], from = 0): number {
  for (let i = from; i <= hay.length - needle.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) return i;
  }
  return -1;
}

export function isOrdLockScript(scriptHex: string): boolean {
  const bin = hexToBytes(scriptHex.toLowerCase());
  const p = indexOfBytes(bin, hexToBytes(ORDLOCK_PREFIX));
  return p !== -1 && indexOfBytes(bin, hexToBytes(ORDLOCK_SUFFIX), p + hexToBytes(ORDLOCK_PREFIX).length) !== -1;
}

function readPush(bin: number[], offset: number): { data: number[]; next: number } | null {
  const op = bin[offset];
  if (op === undefined) return null;
  if (op > 0 && op < 0x4c) return { data: bin.slice(offset + 1, offset + 1 + op), next: offset + 1 + op };
  if (op === 0x4c) {
    const len = bin[offset + 1];
    if (len === undefined) return null;
    return { data: bin.slice(offset + 2, offset + 2 + len), next: offset + 2 + len };
  }
  if (op === 0x4d) {
    const len = (bin[offset + 1] ?? 0) | ((bin[offset + 2] ?? 0) << 8);
    return { data: bin.slice(offset + 3, offset + 3 + len), next: offset + 3 + len };
  }
  return null;
}

/**
 * Independently decode an OrdLock script's price and payout script: the
 * listing must match what the covenant will actually enforce.
 */
export function decodeOrdLockTerms(scriptHex: string): { price: number; payoutScriptHex: string } | null {
  try {
    const bin = hexToBytes(scriptHex.toLowerCase());
    const prefix = hexToBytes(ORDLOCK_PREFIX);
    const suffix = hexToBytes(ORDLOCK_SUFFIX);
    const p = indexOfBytes(bin, prefix);
    if (p === -1) return null;
    const s = indexOfBytes(bin, suffix, p + prefix.length);
    if (s === -1) return null;
    let off = p + prefix.length;
    const cancel = readPush(bin, off);
    if (!cancel || cancel.data.length !== 20) return null;
    off = cancel.next;
    const payout = readPush(bin, off);
    if (!payout || payout.data.length < 9) return null;
    const d = payout.data;
    let price = 0n;
    for (let i = 0; i < 8; i++) price |= BigInt(d[i]!) << BigInt(i * 8);
    let o = 8;
    let scriptLen = d[o++]!;
    if (scriptLen >= 0xfd) {
      const bytes = scriptLen === 0xfd ? 2 : scriptLen === 0xfe ? 4 : 8;
      scriptLen = 0;
      for (let i = 0; i < bytes; i++) scriptLen += d[o + i]! * 2 ** (8 * i);
      o += bytes;
    }
    if (scriptLen <= 0 || o + scriptLen > d.length) return null;
    const payoutScriptHex = d.slice(o, o + scriptLen).map((b) => b.toString(16).padStart(2, "0")).join("");
    return { price: Number(price), payoutScriptHex };
  } catch {
    return null;
  }
}

/** The listed asset outpoint must exist on chain. Atomic offers pin every input. */
export async function verifyListParent(
  fetchTx: FetchTx,
  listing: Pick<Listing, "origin" | "assetKind" | "offer" | "tokenId" | "tokenAmount" | "priceSats">,
): Promise<{ scriptHex: string; value: number; payScriptHex?: string }> {
  const parts = parseOutpoint(listing.origin);
  if (!parts) fail("BAD_PARAM", "origin must be <64-hex-txid>.<vout>");
  const tx = await fetchTx(parts!.txid);
  if (!tx) fail("PARENT_MISSING", `asset parent ${parts!.txid} not found on chain`);
  const out = (tx!.vout ?? []).find((o) => Number(o.n) === parts!.vout);
  if (!out) fail("PARENT_MISSING", `asset outpoint ${listing.origin} not found on chain`);
  const carrier = { scriptHex: String(out!.scriptPubKey?.hex ?? ""), value: Number(out!.value) };
  const offer = (listing.offer ?? null) as
    | { version?: number; kind?: string; inputs?: Array<{ txid: string; vout: number }>; input?: { txid: string; vout: number } }
    | null;
  if (!offer) return carrier; // direct sale: existence is enough
  if (offer.kind === "ordinal") {
    if (Number(out!.value) !== 1) fail("BAD_PARAM", "ordinal carriers must be exactly 1 sat");
    // v4: the 1-sat prefix must exist too (it shifts the carrier to input 1)
    const prefix = offer.inputs?.[0];
    if (prefix) {
      const ptx = await fetchTx(String(prefix.txid).toLowerCase());
      if (!ptx) fail("PARENT_MISSING", `offer prefix ${prefix.txid} not found on chain`);
      const pout = (ptx!.vout ?? []).find((o) => Number(o.n) === Number(prefix.vout));
      if (!pout) fail("PARENT_MISSING", `offer prefix ${prefix.txid}.${prefix.vout} not found on chain`);
      if (Number(pout!.value) !== 1) fail("BAD_PARAM", "offer prefix must be exactly 1 sat");
    }
    return carrier;
  }
  if (offer.kind === "ordlock") {
    if (Number(out!.value) !== 1) fail("BAD_PARAM", "ordlock carriers must be exactly 1 sat");
    const terms = decodeOrdLockTerms(carrier.scriptHex);
    if (!terms) fail("BAD_PARAM", "origin is not a readable OrdLock output");
    if (terms!.price !== listing.priceSats) {
      fail("BAD_PARAM", `lock enforces ${terms!.price} sats, listing says ${listing.priceSats}`);
    }
    return { ...carrier, payScriptHex: terms!.payoutScriptHex };
  }
  if (offer.kind === "bsv21") {
    if (!listing.tokenId || !listing.tokenAmount) fail("BAD_PARAM", "bsv21 listings need tokenId + tokenAmount");
    if (Number(out!.value) !== 1) fail("BAD_PARAM", "token carriers must be exactly 1 sat");
    if (!carriesTokens(String(out!.scriptPubKey?.hex ?? ""), listing.tokenId, listing.tokenAmount)) {
      fail("BAD_PARAM", "parent outpoint is not the listed token output");
    }
    return carrier;
  }
  fail("BAD_PARAM", "offer kind must be ordinal or bsv21");
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
