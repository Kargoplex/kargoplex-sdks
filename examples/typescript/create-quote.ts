import { Kargoplex } from "@kargoplex/sdk";

const apiKey = process.env.KARGOPLEX_API_KEY;
if (!apiKey) throw new Error("Set KARGOPLEX_API_KEY (a kp_live_... key from Settings -> Developer).");

const client = new Kargoplex({ apiKey });

// Needs a key with the parties:write, quotes:write and quotes:read scopes.
const customer = await client.parties.create({ name: "Example Importer Ltd", roles: ["CUSTOMER"] });

// Creates a DRAFT quote. Lines are priced by your pricing rules.
const quote = await client.quotes.create({
  customerPartyId: customer._id,
  currency: "USD",
  lane: { transportMode: "SEA", incoterm: "FOB" },
  lines: [
    {
      description: "Ocean freight",
      category: "FREIGHT",
      unit: "PER_CONTAINER",
      quantity: 1,
      buy: { currency: "USD", rate: 1800 },
    },
  ],
});
console.log("Draft quote", quote._id);

// Send it to the customer.
const sent = await client.quotes.send(quote._id);
console.log("Sent", sent._id);
