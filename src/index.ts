/**
 * atomic-market worker: generic order book for atomic swaps. No custody,
 * no escrow — the chain settles, this worker only matches and verifies.
 *
 * PocketPets keeps pointing at the legacy worker; this one serves new
 * markets (tickets, art, game items, Twetch NFTs) with per-market fees.
 */
import { d1Store } from "./store.ts";
import type { Listing } from "./types.ts";
import { validateListing } from "./validate.ts";
import { verifyBuy, verifyListParent, verifySettle } from "./verify.ts";
import type { ChainTx } from "./types.ts";

interface Env {
  DB: Parameters<typeof d1Store>[0];
  WOC_BASE?: string;
}

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: CORS });
}

function err(code: string, message: string): Response {
  const status = code === "NOT_FOUND" ? 404
    : code === "ALREADY_SOLD" || code === "ALREADY_LISTED" ? 409
    : code === "NOT_SELLER" ? 403
    : code === "TX_UNKNOWN" || code === "PARENT_MISSING" ? 502
    : 400;
  return json({ error: { code, message } }, status);
}

function toChainTx(raw: unknown, txid: string): ChainTx | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { vin?: unknown; vout?: unknown };
  if (!Array.isArray(r.vin) || !Array.isArray(r.vout)) return null;
  return {
    txid,
    vin: r.vin.map((i) => {
      const o = i as { txid?: unknown; vout?: unknown };
      return { txid: String(o.txid ?? "").toLowerCase(), vout: Number(o.vout) };
    }),
    vout: r.vout.map((o) => {
      const v = o as { value?: unknown; n?: unknown; scriptPubKey?: unknown };
      const sp = (v.scriptPubKey ?? {}) as { hex?: unknown; addresses?: unknown };
      return {
        value: Number(v.value),
        n: Number(v.n),
        scriptPubKey: {
          hex: String(sp.hex ?? ""),
          addresses: Array.isArray(sp.addresses) ? sp.addresses.map(String) : [],
        },
      };
    }),
  };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    const store = d1Store(env.DB);
    const base = (env.WOC_BASE ?? "https://api.whatsonchain.com/v1/bsv/main").replace(/\/$/, "");
    const fetchTx = async (txid: string): Promise<ChainTx | null> => {
      try {
        const res = await fetch(`${base}/tx/${txid}`);
        if (!res.ok) return null;
        return toChainTx(await res.json(), txid.toLowerCase());
      } catch {
        return null;
      }
    };

    try {
      // GET /v1/market[?kind=ordinal|bsv21]
      if (req.method === "GET" && url.pathname === "/v1/market") {
        const kind = url.searchParams.get("kind");
        const listings = await store.listActive(kind === "ordinal" || kind === "bsv21" ? kind : undefined);
        return json({ listings });
      }
      // GET /v1/market/recent[?limit=]
      if (req.method === "GET" && url.pathname === "/v1/market/recent") {
        const listings = await store.listRecent(Number(url.searchParams.get("limit")) || 50);
        return json({ listings });
      }
      // GET /v1/market/listing/:origin
      {
        const m = /^\/v1\/market\/listing\/(.+)$/.exec(url.pathname);
        if (req.method === "GET" && m) {
          const listing = await store.get(decodeURIComponent(m[1]!));
          if (!listing) return err("NOT_FOUND", "listing not found");
          return json({ listing });
        }
      }
      if (req.method === "POST" && url.pathname === "/v1/market/list") {
        const draft = validateListing(await req.json());
        const now = Date.now();
        const existing = await store.get(draft.origin);
        if (existing && existing.status !== "cancelled") {
          return err("ALREADY_LISTED", `origin ${draft.origin} is already listed (${existing.status})`);
        }
        const listing: Listing = {
          ...draft, status: "active",
          buyTxid: null, buyerHandle: null, transferTxid: null,
          createdAt: now, updatedAt: now,
          inputScript: null,
        };
        const parent = await verifyListParent(fetchTx, listing);
        listing.inputScript = parent.scriptHex || null;
        await store.insert(listing);
        return json({ ok: true, origin: listing.origin });
      }
      if (req.method === "POST" && url.pathname === "/v1/market/buy") {
        const body = (await req.json()) as { origin?: unknown; buyTxid?: unknown; buyerHandle?: unknown };
        if (typeof body.origin !== "string" || !body.origin) return err("BAD_PARAM", "origin required");
        if (typeof body.buyTxid !== "string" || !body.buyTxid) return err("BAD_PARAM", "buyTxid required");
        const listing = await store.get(body.origin);
        if (!listing) return err("NOT_FOUND", "listing not found");
        if (listing.status !== "active") return err("ALREADY_SOLD", `listing is ${listing.status}`);
        await verifyBuy(fetchTx, listing, body.buyTxid);
        await store.setStatus(body.origin, "paid", {
          buyTxid: body.buyTxid.toLowerCase(),
          buyerHandle: typeof body.buyerHandle === "string" ? body.buyerHandle.slice(0, 64) : null,
        });
        return json({ ok: true });
      }
      if (req.method === "POST" && url.pathname === "/v1/market/settle") {
        const body = (await req.json()) as { origin?: unknown; transferTxid?: unknown };
        if (typeof body.origin !== "string" || !body.origin) return err("BAD_PARAM", "origin required");
        if (typeof body.transferTxid !== "string" || !body.transferTxid) return err("BAD_PARAM", "transferTxid required");
        const listing = await store.get(body.origin);
        if (!listing) return err("NOT_FOUND", "listing not found");
        if (listing.status !== "active" && listing.status !== "paid") {
          return err("ALREADY_SOLD", `listing is ${listing.status}`);
        }
        await verifySettle(fetchTx, listing, body.transferTxid);
        await store.setStatus(body.origin, "sold", { transferTxid: body.transferTxid.toLowerCase() });
        return json({ ok: true });
      }
      if (req.method === "POST" && url.pathname === "/v1/market/cancel") {
        const body = (await req.json()) as { origin?: unknown; seller?: unknown };
        if (typeof body.origin !== "string" || !body.origin) return err("BAD_PARAM", "origin required");
        const listing = await store.get(body.origin);
        if (!listing) return err("NOT_FOUND", "listing not found");
        if (listing.status !== "active") return err("ALREADY_SOLD", `listing is ${listing.status}`);
        if (typeof body.seller !== "string" || body.seller !== listing.seller) {
          return err("NOT_SELLER", "only the seller can cancel");
        }
        await store.setStatus(body.origin, "cancelled", {});
        return json({ ok: true });
      }
      if (req.method === "GET" && url.pathname === "/health") return json({ ok: true });
      return err("NOT_FOUND", "unknown route");
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      if (typeof code === "string") return err(code, e instanceof Error ? e.message : code);
      return json({ error: { code: "INTERNAL", message: "internal error" } }, 500);
    }
  },
};
