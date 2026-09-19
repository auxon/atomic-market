/**
 * Storage seam: D1 in production, memory in tests. Handlers only ever
 * touch this interface — never SQL, never fetch.
 */
import type { AssetKind, Listing, ListingStatus } from "./types.ts";

export interface ListingStore {
  get(origin: string): Promise<Listing | null>;
  listActive(kind?: AssetKind): Promise<Listing[]>;
  listRecent(limit: number): Promise<Listing[]>;
  insert(listing: Listing): Promise<void>;
  setStatus(origin: string, status: ListingStatus, patch: Partial<Pick<Listing, "buyTxid" | "buyerHandle" | "transferTxid">>): Promise<boolean>;
  /** Drop a row entirely — used to re-list a cancelled origin (PK reuse). */
  remove(origin: string): Promise<boolean>;
}

const COLS = [
  "origin", "asset_kind", "title", "image", "description", "metadata",
  "price_sats", "seller", "seller_handle", "seller_unlock", "pay_script",
  "input_script", "token_id", "token_amount", "fee_bps", "fee_address", "status",
  "buy_txid", "buyer_handle", "transfer_txid", "created_at", "updated_at",
].join(", ");

function toListing(r: Record<string, unknown>): Listing {
  return {
    origin: String(r.origin),
    assetKind: r.asset_kind as Listing["assetKind"],
    title: String(r.title),
    image: (r.image as string | null) ?? null,
    description: (r.description as string | null) ?? null,
    metadata: JSON.parse(String(r.metadata ?? "{}")) as Record<string, unknown>,
    priceSats: Number(r.price_sats),
    seller: String(r.seller),
    sellerHandle: (r.seller_handle as string | null) ?? null,
    sellerUnlock: (r.seller_unlock as string | null) ?? null,
    payScript: (r.pay_script as string | null) ?? null,
    inputScript: (r.input_script as string | null) ?? null,
    tokenId: (r.token_id as string | null) ?? null,
    tokenAmount: (r.token_amount as string | null) ?? null,
    feeBps: Number(r.fee_bps),
    feeAddress: String(r.fee_address),
    status: r.status as ListingStatus,
    buyTxid: (r.buy_txid as string | null) ?? null,
    buyerHandle: (r.buyer_handle as string | null) ?? null,
    transferTxid: (r.transfer_txid as string | null) ?? null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

/** Allowed moves: active → paid|sold|cancelled, paid → sold. Sold/cancelled are terminal. */
/** Allowed moves: active → paid|sold|cancelled, paid → sold. Sold/cancelled are terminal. */
function canMove(from: ListingStatus, to: ListingStatus): boolean {
  if (from === "active") return to === "paid" || to === "sold" || to === "cancelled";
  if (from === "paid") return to === "sold";
  return false;
}

/** Production store over a Cloudflare D1 database binding. */
export function d1Store(db: {
  prepare(q: string): {
    bind(...args: unknown[]): {
      all<T>(): Promise<{ results: T[] }>;
      first<T>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
  };
}): ListingStore {
  const one = async (origin: string): Promise<Listing | null> => {
    const row = await db.prepare(`SELECT ${COLS} FROM listings WHERE origin = ?`).bind(origin).first<Record<string, unknown>>();
    return row ? toListing(row) : null;
  };
  return {
    get: one,
    listActive: async (kind) => {
      const rows = kind
        ? await db.prepare(`SELECT ${COLS} FROM listings WHERE status = 'active' AND asset_kind = ? ORDER BY created_at DESC LIMIT 200`).bind(kind).all<Record<string, unknown>>()
        : await db.prepare(`SELECT ${COLS} FROM listings WHERE status = 'active' ORDER BY created_at DESC LIMIT 200`).bind().all<Record<string, unknown>>();
      return rows.results.map(toListing);
    },
    listRecent: async (limit) => {
      const rows = await db.prepare(`SELECT ${COLS} FROM listings WHERE status IN ('paid','sold') ORDER BY updated_at DESC LIMIT ?`).bind(Math.min(100, Math.max(1, limit))).all<Record<string, unknown>>();
      return rows.results.map(toListing);
    },
    insert: async (l) => {
      await db.prepare(
        `INSERT INTO listings (${COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        l.origin, l.assetKind, l.title, l.image, l.description, JSON.stringify(l.metadata),
        l.priceSats, l.seller, l.sellerHandle, l.sellerUnlock, l.payScript,
        l.inputScript, l.tokenId, l.tokenAmount, l.feeBps, l.feeAddress, l.status,
        l.buyTxid, l.buyerHandle, l.transferTxid, l.createdAt, l.updatedAt,
      ).run();
    },
    setStatus: async (origin, status, patch) => {
      const cur = await one(origin);
      if (!cur || !canMove(cur.status, status)) return false;
      await db.prepare(
        `UPDATE listings SET status = ?, buy_txid = ?, buyer_handle = ?, transfer_txid = ?, updated_at = ? WHERE origin = ?`,
      ).bind(
        status,
        patch.buyTxid ?? cur.buyTxid, patch.buyerHandle ?? cur.buyerHandle,
        patch.transferTxid ?? cur.transferTxid, Date.now(), origin,
      ).run();
      return true;
    },
    remove: async (origin) => {
      const res = (await db.prepare(`DELETE FROM listings WHERE origin = ?`).bind(origin).run()) as
        | { meta?: { changes?: number } }
        | undefined;
      return Number(res?.meta?.changes ?? 0) > 0;
    },
  };
}

/** In-memory store for tests. Same transition rule: only active listings move. */
export function memoryStore(): ListingStore & { rows: Map<string, Listing> } {
  const rows = new Map<string, Listing>();
  return {
    rows,
    get: async (origin) => rows.get(origin) ?? null,
    listActive: async (kind) => [...rows.values()]
      .filter((l) => l.status === "active" && (!kind || l.assetKind === kind))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 200),
    listRecent: async (limit) => [...rows.values()]
      .filter((l) => l.status === "paid" || l.status === "sold")
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, Math.min(100, Math.max(1, limit))),
    insert: async (l) => { rows.set(l.origin, { ...l }); },
    setStatus: async (origin, status, patch) => {
      const cur = rows.get(origin);
      if (!cur || !canMove(cur.status, status)) return false;
      rows.set(origin, { ...cur, status, ...patch, updatedAt: Date.now() });
      return true;
    },
    remove: async (origin) => rows.delete(origin),
  };
}
