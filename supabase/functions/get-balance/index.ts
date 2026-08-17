// get-balance edge function
// Returns the WLD token balance for a wallet address.
// Runs the eth_call server-side so the World App WebView never hits
// CORS / 403 issues when fetching from public RPCs directly.
//
// POST { address: "0x..." }  ->  { success: true, balance: 1.234, raw: "1234..." }
//      { success: false, error: "..." }

const WLD_TOKEN_CONTRACT = "0x2cFc85d8E48F8EAB294be644d9E25C3030863003";

const WORLDCHAIN_RPCS = [
  "https://worldchain.drpc.org",
  "https://api.uniblock.dev/uni/v1/json-rpc?chainId=480",
  "https://worldchain-mainnet.g.alchemy.com/public",
];

function jsonRpc(url: string, method: string, params: unknown[], timeoutMs = 8000): Promise<any> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
      signal: controller.signal,
    })
      .then((r) => r.json())
      .then((data) => {
        clearTimeout(timer);
        resolve(data);
      })
      .catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  // Allow only POST
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ success: false, error: "POST only" }), {
      status: 405,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ success: false, error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  const address = String(body.address || "").toLowerCase().trim();
  if (!address || !/^0x[0-9a-f]{40}$/.test(address)) {
    return new Response(JSON.stringify({ success: false, error: "Invalid address" }), {
      status: 400,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  const padded = address.replace("0x", "").padStart(64, "0");
  const data = "0x70a08231" + padded; // balanceOf(address)

  let lastError = "";
  for (const rpc of WORLDCHAIN_RPCS) {
    try {
      const res = await jsonRpc(rpc, "eth_call", [{ to: WLD_TOKEN_CONTRACT, data }, "latest"]);
      if (res && res.result && res.result !== "0x") {
        const raw = res.result;
        const balance = Number(BigInt(raw)) / 1e18;
        return new Response(JSON.stringify({ success: true, balance, raw }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }
      if (res && res.error) lastError = res.error.message || "RPC error";
      if (res && res.result === "0x") {
        // Balance is literally zero — valid response
        return new Response(JSON.stringify({ success: true, balance: 0, raw: "0x0" }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }
    } catch (e: any) {
      lastError = e?.message || String(e);
    }
  }

  return new Response(JSON.stringify({ success: false, error: lastError || "All RPCs failed" }), {
    status: 502,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
});
