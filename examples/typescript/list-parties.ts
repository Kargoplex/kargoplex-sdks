import { Kargoplex, KargoplexError } from "@kargoplex/sdk";

const apiKey = process.env.KARGOPLEX_API_KEY;
if (!apiKey) throw new Error("Set KARGOPLEX_API_KEY (a kp_live_... key from Settings -> Developer).");

const client = new Kargoplex({ apiKey });

try {
  // One page.
  const page = await client.parties.list({ role: "CUSTOMER", limit: 20 });
  console.log(`${page.total} customers; first page has ${page.items?.length ?? 0}`);

  // Every party, page by page.
  for await (const party of client.paginate(client.parties.list, { status: "ACTIVE" })) {
    console.log(party._id, party.name);
  }
} catch (err) {
  if (err instanceof KargoplexError) {
    console.error(`API error ${err.status} ${err.code ?? ""}: ${err.message} (request ${err.requestId ?? "n/a"})`);
    process.exit(1);
  }
  throw err;
}
