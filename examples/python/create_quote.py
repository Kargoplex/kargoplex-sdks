import os

from kargoplex import Kargoplex

api_key = os.environ.get("KARGOPLEX_API_KEY")
if not api_key:
    raise SystemExit("Set KARGOPLEX_API_KEY (a kp_live_... key from Settings -> Developer).")

client = Kargoplex(api_key)

# Needs a key with the parties:write, quotes:write and quotes:read scopes.
customer = client.parties.create({"name": "Example Importer Ltd", "roles": ["CUSTOMER"]})

# Creates a DRAFT quote. Lines are priced by your pricing rules.
quote = client.quotes.create(
    {
        "customerPartyId": customer["_id"],
        "currency": "USD",
        "lane": {"transportMode": "SEA", "incoterm": "FOB"},
        "lines": [
            {
                "description": "Ocean freight",
                "category": "FREIGHT",
                "unit": "PER_CONTAINER",
                "quantity": 1,
                "buy": {"currency": "USD", "rate": 1800},
            }
        ],
    }
)
print("Draft quote", quote["_id"])

# Send it to the customer.
sent = client.quotes.send(quote["_id"])
print("Sent", sent["_id"])
