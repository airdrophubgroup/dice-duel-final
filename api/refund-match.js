import { ethers } from "ethers";

const CONTRACT_ADDRESS = "0x2f9D3bC7125d563434cbc601b15Add6Ba0F3F3Db";
const WLD_TOKEN_CONTRACT = "0x2cFc85d8E48F8EAB294be644d9E25C3030863003";
// Primary + fallback World Chain RPCs — payouts must not stall on one
// flaky provider. An env override still wins when set.
const RPC_URLS = process.env.WORLDCHAIN_RPC
  ? [process.env.WORLDCHAIN_RPC]
  : [
      "https://worldchain.drpc.org",
      "https://api.uniblock.dev/uni/v1/json-rpc?chainId=480",
      "https://worldchain-mainnet.g.alchemy.com/public",
    ];

async function buildProvider() {
  for (const url of RPC_URLS) {
    try {
      const p = new ethers.JsonRpcProvider(url);
      await p.getBlockNumber();
      return p;
    } catch (e) {
      // try the next provider
    }
  }
  return new ethers.JsonRpcProvider(RPC_URLS[0]);
}

const SB_URL = process.env.SUPABASE_URL || "https://efmkazyrxllcyvcwmewd.supabase.co";
const SB_KEY =
  process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  "sb_publishable_px6Myv6S29bTXRYmYLAkgQ_WDHDb7da";

const PRIVATE_KEY =
  process.env.OPERATOR_PRIVATE_KEY ||
  process.env.ADMIN_PRIVATE_KEY ||
  process.env.RESOLVER_PRIVATE_KEY;

const ABI = [
  "function emergencyTokenTransfer(address token, address user, uint256 amount) external",
];

const ERC20_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
];

// The deployed escrow contract (TnvDuelArena) has no operator-side
// "pay the winner" path that works for unbooked matches: settleMatch needs
// an on-chain Active match (only reachable via joinMatch/Permit2, which this
// app deliberately does not use), and cancelWaitingMatch can only be called
// by the p1 player after a 5-minute wait. Every payout/refund therefore goes
// through the owner-only emergencyTokenTransfer — the same path the refund
// resolver cron already uses successfully.
//
// SECURITY: every call is validated against the Supabase `matches` row
// (participant, paid flag, match status) and the amount is always taken
// from the DB (fee), never from the client. Winner settlement is made
// idempotent with mark_match_settled() so a duplicate call can never pay
// the pot twice.

// Winner payout in WLD per entry fee — mirrors app.js calculatePayout()
// exactly, so what the game displays is what the winner receives. The house
// cut (pot minus payout) stays in the contract as operator profit.
const EXACT_PAYOUTS = {
  0.1: 0.17, 0.2: 0.34, 0.5: 0.8, 1: 1.6, 2: 3.2,
  5: 8.8, 10: 17.8, 20: 36.0, 30: 54.0, 40: 72.0, 50: 90.0,
};

function payoutWeiForFee(feeWei) {
  const fee = Number(ethers.formatUnits(feeWei, 18));
  const payout = EXACT_PAYOUTS[fee] ?? Number((fee * 1.6).toFixed(2));
  return ethers.parseUnits(String(payout), 18);
}

async function fetchMatchRow(matchUuid) {
  const url = `${SB_URL}/rest/v1/matches?select=id,status,fee,p1_address,p2_address,p1_paid,p2_paid,settled_at,p1_payment_tx_hash,p2_payment_tx_hash&id=eq.${encodeURIComponent(matchUuid)}`;
  const res = await fetch(url, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  if (!res.ok) return null;
  const rows = await res.json().catch(() => null);
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

// Verify on-chain that `wallet` really transferred `feeWei` WLD to the
// escrow contract (the recorded payment tx hash, with a recent-transfer
// scan as fallback). Nobody is paid without real on-chain proof.
async function verifyPaymentOnChain(provider, wallet, feeWei, txHash) {
  const iface = new ethers.Interface(ERC20_ABI);
  const w = String(wallet).toLowerCase();

  const checkReceipt = async (hash) => {
    try {
      const receipt = await provider.getTransactionReceipt(hash);
      if (!receipt || receipt.status !== 1) return false;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== WLD_TOKEN_CONTRACT.toLowerCase()) continue;
        try {
          const parsed = iface.parseLog(log);
          if (
            parsed.name === "Transfer" &&
            parsed.args.from.toLowerCase() === w &&
            parsed.args.to.toLowerCase() === CONTRACT_ADDRESS.toLowerCase() &&
            parsed.args.value.toString() === feeWei.toString()
          ) {
            return true;
          }
        } catch (e) { /* not a Transfer log */ }
      }
      return false;
    } catch (e) {
      return false;
    }
  };

  if (txHash && (await checkReceipt(txHash))) return true;

  // Scan fallback (contiguous 99-block chunks x 5) for matches paid
  // before tx hashes were recorded.
  try {
    const latest = await provider.getBlockNumber();
    const transferTopic = iface.getEvent("Transfer").topicHash;
    const fromTopic = ethers.zeroPadValue(w, 32);
    const toTopic = ethers.zeroPadValue(CONTRACT_ADDRESS.toLowerCase(), 32);
    const CHUNK = 99;
    const CHUNKS = 5;
    for (let c = 0; c < CHUNKS; c++) {
      const toBlock = latest - c * CHUNK;
      const fromBlock = Math.max(0, toBlock - (CHUNK - 1));
      let logs = [];
      try {
        logs = await provider.getLogs({
          address: WLD_TOKEN_CONTRACT,
          topics: [transferTopic, fromTopic, toTopic],
          fromBlock,
          toBlock,
        });
      } catch (e) {
        continue;
      }
      for (let i = logs.length - 1; i >= 0; i--) {
        const parsed = iface.parseLog(logs[i]);
        if (parsed && parsed.args.value.toString() === feeWei.toString()) {
          return true;
        }
      }
    }
  } catch (e) { /* fall through */ }
  return false;
}

async function callRpc(name, body) {
  const url = `${SB_URL}/rest/v1/rpc/${name}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { action = "SETTLE_WINNER", matchUuid, winnerAddress, playerAddress } = req.body;

  if (!matchUuid) {
    return res.status(400).json({ error: "matchUuid is required" });
  }
  if (action === "SETTLE_WINNER" && !winnerAddress) {
    return res.status(400).json({ error: "winnerAddress is required for SETTLE_WINNER" });
  }
  if (action === "REFUND" && !playerAddress) {
    return res.status(400).json({ error: "playerAddress is required for REFUND" });
  }
  if (!PRIVATE_KEY) {
    return res.status(500).json({ error: "Operator private key is not configured" });
  }

  try {
    const row = await fetchMatchRow(matchUuid);
    if (!row) {
      return res.status(400).json({ success: false, error: "Match not found" });
    }

    const winner = String(winnerAddress || playerAddress).toLowerCase();
    const p1 = String(row.p1_address || "").toLowerCase();
    const p2 = String(row.p2_address || "").toLowerCase();
    const feeWei = ethers.parseUnits(String(row.fee), 18);

    const provider = await buildProvider();
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);

    if (action === "REFUND") {
      // Only an un-started match can be refunded, and only by a
      // participant who actually paid (verified on-chain).
      if (!["waiting", "searching"].includes(row.status)) {
        return res.status(400).json({ success: false, error: `Match not refundable in status ${row.status}` });
      }
      const isP1 = winner === p1 && row.p1_paid === true;
      const isP2 = winner === p2 && row.p2_paid === true;
      if (!isP1 && !isP2) {
        return res.status(400).json({ success: false, error: "Wallet is not a paid participant of this match" });
      }

      const payerTx = isP1 ? row.p1_payment_tx_hash : row.p2_payment_tx_hash;
      const verified = await verifyPaymentOnChain(provider, winner, feeWei, payerTx || null);
      if (!verified) {
        return res.status(400).json({ success: false, error: "Payment not verified on-chain — refund rejected" });
      }

      const tx = await contract.emergencyTokenTransfer(WLD_TOKEN_CONTRACT, winner, feeWei);
      const receipt = await tx.wait();
      return res.status(200).json({ success: true, txHash: receipt.hash, refunded: true, feeWld: row.fee });
    }

    // ---- SETTLE_WINNER ----
    if (!["playing", "completed", "matched"].includes(row.status)) {
      return res.status(400).json({ success: false, error: `Match not playable in status ${row.status}` });
    }
    if (winner !== p1 && winner !== p2) {
      return res.status(400).json({ success: false, error: "Winner is not a participant of this match" });
    }
    if (row.p1_paid !== true || row.p2_paid !== true) {
      return res.status(400).json({ success: false, error: "Both players must have paid before settling" });
    }

    // Both players' payments must be proven on-chain before the winner
    // is paid — forged paid flags can never drain the escrow.
    const p1Verified = await verifyPaymentOnChain(provider, p1, feeWei, row.p1_payment_tx_hash || null);
    const p2Verified = await verifyPaymentOnChain(provider, p2, feeWei, row.p2_payment_tx_hash || null);
    if (!p1Verified || !p2Verified) {
      return res.status(400).json({ success: false, error: "Player payments not verified on-chain — settlement rejected" });
    }

    // Idempotency: mark_match_settled returns true only for the FIRST
    // caller; a duplicate settle can never pay out twice.
    const claimed = await callRpc("mark_match_settled", { p_match_id: matchUuid });
    if (claimed !== true) {
      return res.status(200).json({ success: true, alreadySettled: true });
    }

    const payoutWei = payoutWeiForFee(feeWei);
    const tx = await contract.emergencyTokenTransfer(WLD_TOKEN_CONTRACT, winner, payoutWei);
    const receipt = await tx.wait();
    return res.status(200).json({
      success: true,
      txHash: receipt.hash,
      action: "SETTLE_WINNER",
      winner: winner,
      payoutWld: ethers.formatUnits(payoutWei, 18),
    });
  } catch (error) {
    console.error("refund-match error:", error);
    return res.status(500).json({ success: false, error: error.message || "Internal server error" });
  }
}
