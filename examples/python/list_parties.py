import os

from kargoplex import Kargoplex, KargoplexError

api_key = os.environ.get("KARGOPLEX_API_KEY")
if not api_key:
    raise SystemExit("Set KARGOPLEX_API_KEY (a kp_live_... key from Settings -> Developer).")

client = Kargoplex(api_key)

try:
    # One page.
    page = client.parties.list({"role": "CUSTOMER", "limit": 20})
    print(f"{page['total']} customers; first page has {len(page.get('items') or [])}")

    # Every party, page by page.
    for party in client.paginate(client.parties.list, {"status": "ACTIVE"}):
        print(party["_id"], party["name"])
except KargoplexError as err:
    raise SystemExit(f"API error {err.status} {err.code or ''}: {err.message} (request {err.request_id or 'n/a'})")
