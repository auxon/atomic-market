import { test } from "node:test";
import assert from "node:assert/strict";
import { feeSats, isP2PKH, parseOutpoint, validateListing } from "../src/validate.ts";
import { transferJsonHex, verifyBuy, verifyListParent, verifySettle } from "../src/verify.ts";
import { routePath } from "../src/index.ts";
import { mountRedirect } from "../src/index.ts";
import { d1Store, memoryStore } from "../src/store.ts";

const P2PKH_A = `76a914${"11".repeat(20)}88ac`;
const P2PKH_B = `76a914${"22".repeat(20)}88ac`;
const TX = "a".repeat(64);
const TX2 = "b".repeat(64);

const tx = (vin, vout) => ({
  txid: "t",
  vin: vin.map(([txid, vout]) => ({ txid, vout })),
  vout: vout.map(([value, hex, addresses], n) => ({
    value, n, scriptPubKey: { hex, addresses: addresses ?? [] },
  })),
});

const rejectsCode = (p, code) => assert.rejects(p, (e) => {
  assert.equal(e.code, code);
  return true;
});

test("fee math: basis points with 1-sat floor", () => {
  assert.equal(feeSats(5000, 200), 100);
  assert.equal(feeSats(1, 200), 1);
  assert.equal(feeSats(100, 0), 1); // floor applies; worker skips zero-bps fees
  assert.equal(feeSats(999, 10000), 999);
});

test("outpoint parsing", () => {
  assert.deepEqual(parseOutpoint(`${TX}.0`), { txid: TX, vout: 0 });
  assert.deepEqual(parseOutpoint(`${TX.toUpperCase()}.12`), { txid: TX, vout: 12 });
  assert.equal(parseOutpoint("nope"), null);
  assert.equal(parseOutpoint(`${TX}`), null);
  assert.equal(parseOutpoint(null), null);
});

test("P2PKH recognition", () => {
  assert.equal(isP2PKH(P2PKH_A), true);
  assert.equal(isP2PKH(P2PKH_A.toUpperCase()), true);
  assert.equal(isP2PKH("00"), false);
  assert.equal(isP2PKH("76a91488ac"), false);
});

test("validateListing accepts atomic ordinal listings", () => {
  const l = validateListing({
    origin: `${TX}.0`, assetKind: "ordinal", title: "Concert ticket",
    priceSats: 5000, seller: "1Seller", sellerUnlock: "ab".repeat(50), payScript: P2PKH_A,
    feeBps: 200, feeAddress: "1Fee",
    metadata: { section: "A" },
  });
  assert.equal(l.origin, `${TX}.0`);
  assert.equal(l.assetKind, "ordinal");
  assert.equal(l.tokenId, null);
  assert.deepEqual(l.metadata, { section: "A" });
});

test("validateListing accepts direct sales and bsv21", () => {
  const direct = validateListing({
    origin: `${TX}.3`, title: "Art", priceSats: 100,
    seller: "1Seller", feeAddress: "1Fee",
  });
  assert.equal(direct.assetKind, "ordinal"); // default
  assert.equal(direct.sellerUnlock, null);
  assert.equal(direct.feeBps, 200); // default
  const token = validateListing({
    origin: `${TX}.1`, assetKind: "bsv21", title: "100 STARS",
    priceSats: 1000, seller: "1Seller", feeAddress: "1Fee",
    tokenId: `${TX2}_0`, tokenAmount: "100",
  });
  assert.equal(token.tokenId, `${TX2}_0`);
  assert.equal(token.tokenAmount, "100");
});

test("validateListing rejects bad shapes", () => {
  const good = {
    origin: `${TX}.0`, title: "T", priceSats: 100, seller: "1S",
    sellerUnlock: "ab", payScript: P2PKH_A, feeAddress: "1F",
  };
  assert.throws(() => validateListing(null), /object/);
  assert.throws(() => validateListing({ ...good, origin: "nope" }), /origin/);
  assert.throws(() => validateListing({ ...good, priceSats: 0 }), /priceSats/);
  assert.throws(() => validateListing({ ...good, payScript: undefined }), /both sellerUnlock and payScript/);
  assert.throws(() => validateListing({ ...good, sellerUnlock: undefined }), /both sellerUnlock and payScript/);
  assert.throws(() => validateListing({ ...good, payScript: "00" }), /P2PKH/);
  assert.throws(() => validateListing({ ...good, feeBps: 10001 }), /feeBps/);
  assert.throws(() => validateListing({ ...good, assetKind: "doge" }), /assetKind/);
  assert.throws(() => validateListing({ ...good, assetKind: "bsv21" }), /tokenId/);
  assert.throws(() => validateListing({
    ...good, assetKind: "bsv21", tokenId: `${TX2}_0`, tokenAmount: "0",
  }), /tokenAmount/);
  assert.throws(() => validateListing({ ...good, metadata: [] }), /metadata/);
});

function listing(over = {}) {
  return {
    origin: `${TX}.0`, assetKind: "ordinal", title: "T", image: null,
    description: null, metadata: {}, priceSats: 5000, seller: "1Seller",
    sellerHandle: null, sellerUnlock: "ab".repeat(50), payScript: P2PKH_A,
    inputScript: null, tokenId: null, tokenAmount: null, feeBps: 200, feeAddress: "1Fee",
    status: "active", buyTxid: null, buyerHandle: null, transferTxid: null,
    createdAt: 1, updatedAt: 1,
    ...over,
  };
}

test("verifyListParent requires the outpoint on chain", async () => {
  const byId = {
    [TX]: tx([], [[1, P2PKH_A]]),
  };
  const fetchTx = async (id) => byId[id] ?? null;
  await verifyListParent(fetchTx, listing());
  await rejectsCode(verifyListParent(fetchTx, listing({ origin: `${TX2}.0` })), "PARENT_MISSING");
  await rejectsCode(verifyListParent(fetchTx, listing({ origin: `${TX}.1` })), "PARENT_MISSING");
  const twoSat = { [TX]: tx([], [[2, P2PKH_A]]) };
  await rejectsCode(
    verifyListParent(async () => twoSat[TX], listing()), "BAD_PARAM",
  );
});

test("verifyBuy checks exact payment + fee", async () => {
  const buy = tx([], [[5000, P2PKH_A], [100, "00", ["1Fee"]]]);
  const fetchTx = async () => buy;
  await verifyBuy(fetchTx, listing(), TX2);
  await rejectsCode(verifyBuy(fetchTx, listing({ priceSats: 5001 }), TX2), "BAD_PAYMENT");
  await rejectsCode(verifyBuy(fetchTx, listing({ feeAddress: "1Other" }), TX2), "BAD_FEE");
  const noFee = tx([], [[5000, P2PKH_A]]);
  await rejectsCode(verifyBuy(async () => noFee, listing(), TX2), "BAD_FEE");
  await rejectsCode(verifyBuy(async () => null, listing(), TX2), "TX_UNKNOWN");
  await rejectsCode(verifyBuy(fetchTx, listing(), "zzz"), "BAD_PARAM");
  // direct sale: seller address match instead of payScript
  const direct = listing({ sellerUnlock: null, payScript: null, seller: "1Seller" });
  const directBuy = tx([], [[5000, "00", ["1Seller"]], [100, "00", ["1Fee"]]]);
  await verifyBuy(async () => directBuy, direct, TX2);
  await rejectsCode(verifyBuy(async () => buy, direct, TX2), "BAD_PAYMENT");
});

test("verifySettle requires spending the listed outpoint", async () => {
  const move = tx([[TX, 0]], [[1, P2PKH_B]]);
  await verifySettle(async () => move, listing(), TX2);
  const other = tx([[TX2, 0]], [[1, P2PKH_B]]);
  await rejectsCode(verifySettle(async () => other, listing(), TX2), "BAD_TRANSFER");
  await rejectsCode(verifySettle(async () => null, listing(), TX2), "TX_UNKNOWN");
});

const TOKEN_ID = `${TX2}_0`;

function tokenListing(over = {}) {
  return listing({
    assetKind: "bsv21", title: "100 STARS", priceSats: 1000,
    tokenId: TOKEN_ID, tokenAmount: "100",
    ...over,
  });
}

function enveloped(jsonHex) {
  return `76a914${"33".repeat(20)}88ac006300${jsonHex}68`;
}

test("bsv21 list verification checks the token envelope", async () => {
  const good = enveloped(transferJsonHex(TOKEN_ID, "100"));
  const byId = { [TX]: tx([], [[1, good]]) };
  await verifyListParent(async (id) => byId[id] ?? null, tokenListing());
  const wrongAmt = enveloped(transferJsonHex(TOKEN_ID, "50"));
  await rejectsCode(
    verifyListParent(async () => tx([], [[1, wrongAmt]]), tokenListing()), "BAD_PARAM",
  );
  const plain = tx([], [[1, P2PKH_A]]);
  await rejectsCode(
    verifyListParent(async () => plain, tokenListing()), "BAD_PARAM",
  );
});

test("bsv21 buy verification checks payment, fee, and token movement", async () => {
  const l = tokenListing();
  const good = tx([], [
    [1000, P2PKH_A],
    [1, enveloped(transferJsonHex(TOKEN_ID, "100"))],
    [20, "00", ["1Fee"]], // feeSats(1000, 200) = 20
  ]);
  await verifyBuy(async () => good, l, TX2);
  const noTokens = tx([], [[1000, P2PKH_A], [20, "00", ["1Fee"]]]);
  await rejectsCode(verifyBuy(async () => noTokens, l, TX2), "BAD_TRANSFER");
  const wrongAmt = tx([], [
    [1000, P2PKH_A],
    [1, enveloped(transferJsonHex(TOKEN_ID, "50"))],
    [20, "00", ["1Fee"]],
  ]);
  await rejectsCode(verifyBuy(async () => wrongAmt, l, TX2), "BAD_TRANSFER");
});

test("store: round-trip, filters, transitions", async () => {
  const s = memoryStore();
  const now = Date.now();
  await s.insert({ ...listing(), createdAt: now, updatedAt: now });
  await s.insert({ ...listing({ origin: `${TX}.1`, assetKind: "bsv21", tokenId: `${TX2}_0`, tokenAmount: "5" }), createdAt: now + 1, updatedAt: now + 1 });
  assert.equal((await s.get(`${TX}.0`)).title, "T");
  assert.equal((await s.listActive()).length, 2);
  assert.equal((await s.listActive("bsv21")).length, 1);
  assert.deepEqual(await s.listRecent(10), []);
  // buy: active -> paid
  assert.equal(await s.setStatus(`${TX}.0`, "paid", { buyTxid: TX2 }), true);
  assert.equal((await s.get(`${TX}.0`)).status, "paid");
  assert.equal((await s.listActive()).length, 1);
  assert.equal((await s.listRecent(10)).length, 1);
  // double buy refused
  assert.equal(await s.setStatus(`${TX}.0`, "paid", {}), false);
  // settle: paid -> sold
  assert.equal(await s.setStatus(`${TX}.0`, "sold", { transferTxid: TX2 }), true);
  // terminal: no further moves
  assert.equal(await s.setStatus(`${TX}.0`, "cancelled", {}), false);
  // cancel from active
  assert.equal(await s.setStatus(`${TX}.1`, "cancelled", {}), true);
  assert.equal(await s.setStatus(`${TX}.1`, "sold", {}), false);
  // unknown origin
  assert.equal(await s.setStatus(`${TX2}.9`, "paid", {}), false);
});

test("d1Store insert binds one arg per column", async () => {
  const calls = [];
  const db = {
    prepare: (q) => {
      calls.push(q);
      return {
        bind: (...args) => {
          calls.push(args);
          return { all: async () => ({ results: [] }), first: async () => null, run: async () => ({}) };
        },
      };
    },
  };
  const s = d1Store(db);
  await s.insert({ ...listing(), inputScript: P2PKH_A });
  const sql = calls[0];
  const args = calls[1];
  const placeholders = (sql.match(/\?/g) || []).length;
  assert.equal(args.length, placeholders);
  const cols = sql.slice(sql.indexOf("(") + 1, sql.indexOf(")")).split(",").length;
  assert.equal(cols, placeholders);
});

test("verifyListParent returns the carrier script for atomic offers", async () => {
  const script = `76a914${"44".repeat(20)}88ac`;
  const byId = { [TX]: tx([], [[1, script]]) };
  const parent = await verifyListParent(async (id) => byId[id] ?? null, listing());
  assert.equal(parent.scriptHex, script);
  assert.equal(parent.value, 1);
});

test("routePath strips the /atomic-market base path", () => {
  assert.equal(routePath("/v1/market"), "/v1/market");
  assert.equal(routePath("/health"), "/health");
  assert.equal(routePath("/atomic-market"), "/");
  assert.equal(routePath("/atomic-market/"), "/");
  assert.equal(routePath("/atomic-market/v1/market"), "/v1/market");
  assert.equal(routePath("/atomic-market/v1/market/listing/abc.0"), "/v1/market/listing/abc.0");
  assert.equal(routePath("/atomic-marketx/v1"), "/atomic-marketx/v1");
});

test("mountRedirect canonicalizes the bare mount path", () => {
  assert.equal(mountRedirect("/atomic-market"), "/atomic-market/");
  assert.equal(mountRedirect("/atomic-market/"), null);
  assert.equal(mountRedirect("/atomic-market/v1/market"), null);
  assert.equal(mountRedirect("/atomic-marketx"), null);
  assert.equal(mountRedirect("/"), null);
});

test("market host serves the BRC-100 app UI", async () => {
  const { isMarketHost, uiAsset } = await import("../src/index.ts");
  assert.equal(isMarketHost("market.entangleit.com"), true);
  assert.equal(isMarketHost("MARKET.ENTANGLEIT.COM"), true);
  assert.equal(isMarketHost("entangleit.com"), false);
  assert.equal(isMarketHost("atomic-market.richard-hein.workers.dev"), false);
  const index = uiAsset("/");
  assert.ok(index && index.type.startsWith("text/html"));
  assert.ok(index.body.includes("Atomic Market"));
  const manifest = uiAsset("/manifest.json");
  assert.ok(manifest && manifest.type === "application/json");
  const parsed = JSON.parse(manifest.body);
  assert.equal(parsed.name, "Atomic Market");
  assert.equal(parsed.start_url, "/");
  assert.ok(parsed.metanet.groupPermissions.spendingAuthorization.amount > 0);
  assert.deepEqual(parsed.metanet.intents.map((i) => i.action), ["app-swap", "app-spend", "app-swap-offer"]);
  assert.ok(uiAsset("/app.js").body.includes("window.bsv"));
  assert.ok(uiAsset("/styles.css").type.startsWith("text/css"));
  assert.equal(uiAsset("/nope"), null);
});

test("generated UI matches public/ sources byte-for-byte", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { UI_ASSETS } = await import("../src/ui.generated.ts");
  const dir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../public");
  const files = fs.readdirSync(dir).filter((f) => !f.startsWith(".")).sort();
  assert.deepEqual(Object.keys(UI_ASSETS).sort(), files.map((f) => `/${f}`).sort());
  for (const f of files) {
    assert.equal(UI_ASSETS[`/${f}`].body, fs.readFileSync(path.join(dir, f), "utf8"), `${f} stale — run npm run build:ui`);
  }
});

test("toChainTx converts WhatsOnChain BSV values to sats", async () => {
  const { toChainTx } = await import("../src/index.ts");
  const raw = {
    vin: [{ txid: "AB".repeat(32), vout: 1 }],
    vout: [
      { n: 0, value: 1e-8, scriptPubKey: { hex: P2PKH_A, addresses: ["1Seller"] } },
      { n: 1, value: 4.1e-7, scriptPubKey: { hex: "00", addresses: [] } },
      { n: 2, value: 0.05, scriptPubKey: { hex: P2PKH_B, addresses: ["1Fee"] } },
    ],
  };
  const tx = toChainTx(raw, "t");
  assert.deepEqual(tx.vout.map((o) => o.value), [1, 41, 5000000]);
  assert.equal(tx.vin[0].txid, "ab".repeat(32));
  // real listing flow: a 1-sat carrier must pass the ordinal check
  await verifyListParent(async () => tx, listing({ origin: `${TX}.0` }));
  assert.equal(toChainTx(null, "t"), null);
  assert.equal(toChainTx({ vin: [], vout: "nope" }, "t"), null);
});
