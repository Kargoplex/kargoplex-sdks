# @kargoplex/sdk

Official TypeScript/JavaScript SDK for the Kargoplex public API. Server-side only.

```bash
npm i @kargoplex/sdk
```

```ts
import { Kargoplex } from "@kargoplex/sdk";

const client = new Kargoplex({ apiKey: process.env.KARGOPLEX_API_KEY! });
for await (const party of client.paginate(client.parties.list, { role: "CUSTOMER" })) {
  console.log(party.name);
}
```

Full documentation: https://github.com/Kargoplex/kargoplex-sdks#readme
