# kargoplex

Official Python SDK for the Kargoplex public API. No runtime dependencies. Server-side only.

```bash
pip install kargoplex
```

```python
import os
from kargoplex import Kargoplex

client = Kargoplex(os.environ["KARGOPLEX_API_KEY"])
for party in client.paginate(client.parties.list, {"role": "CUSTOMER"}):
    print(party["name"])
```

Full documentation: https://github.com/Kargoplex/kargoplex-sdks#readme
