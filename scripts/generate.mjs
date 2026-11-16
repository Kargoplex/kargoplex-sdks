#!/usr/bin/env node
// Dependency-free generator: openapi.json -> ts/src/generated.ts + python/kargoplex/_generated.py
// Usage: node scripts/generate.mjs [--check]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const spec = JSON.parse(readFileSync(resolve(root, "openapi.json"), "utf8"));
const check = process.argv.includes("--check");

const HTTP = ["get", "post", "put", "patch", "delete"];
const PY_KEYWORDS = new Set(["False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield"]);

// ---------- naming helpers ----------
const words = (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter(Boolean);
const pascal = (s) => words(s).map((w) => w[0].toUpperCase() + w.slice(1)).join("");
const camel = (s) => {
  const p = pascal(s);
  return p[0].toLowerCase() + p.slice(1);
};
const snake = (s) => words(s).map((w) => w.toLowerCase()).join("_");

// ---------- spec -> operations ----------
function resolveRef(node) {
  if (node && node.$ref) {
    const parts = node.$ref.replace(/^#\//, "").split("/");
    let cur = spec;
    for (const p of parts) cur = cur[p];
    return resolveRef(cur);
  }
  return node;
}

const operations = [];
for (const [path, item] of Object.entries(spec.paths)) {
  for (const method of HTTP) {
    const op = item[method];
    if (!op) continue;
    const tag = (op.tags && op.tags[0]) || "Default";
    const prefix = snake(tag);
    let name = op.operationId;
    if (!name) throw new Error(`${method} ${path} has no operationId`);
    if (name.startsWith(prefix + "_")) name = name.slice(prefix.length + 1);
    const params = [...(item.parameters || []), ...(op.parameters || [])].map(resolveRef);
    const pathParams = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
    const query = params.filter((p) => p.in === "query");
    const body = op.requestBody ? resolveRef(op.requestBody) : null;
    const bodySchema = body?.content?.["application/json"]?.schema ?? null;
    const isList = query.some((p) => p.name === "page") && query.some((p) => p.name === "limit");
    operations.push({
      resource: camel(tag), resourceType: pascal(tag),
      name, method: method.toUpperCase(), path, pathParams, query,
      body: bodySchema ? resolveRef(bodySchema) : null,
      bodyRequired: !!body?.required, isList,
      summary: op.summary || "", description: op.description || "", scope: op["x-kargoplex-scope"] || "",
    });
  }
}
const resources = [];
for (const op of operations) {
  let r = resources.find((x) => x.key === op.resource);
  if (!r) resources.push((r = { key: op.resource, type: op.resourceType, ops: [] }));
  r.ops.push(op);
}

const typeName = (op, suffix) => `${op.resourceType}${pascal(op.name)}${suffix}`;
const querySchema = (op) => ({
  type: "object",
  properties: Object.fromEntries(op.query.map((p) => [p.name, resolveRef(p.schema || {})])),
  required: op.query.filter((p) => p.required).map((p) => p.name),
  additionalProperties: false,
});

const lit = (v) => JSON.stringify(v);
const isIdent = (k) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k);

// ---------- TypeScript ----------
function tsType(schema, indent = "") {
  schema = resolveRef(schema);
  if (!schema || typeof schema !== "object" || Object.keys(schema).length === 0) return "unknown";
  let out;
  if ("const" in schema) out = lit(schema.const);
  else if (schema.enum) out = [...new Set(schema.enum.map(lit))].join(" | ");
  else if (schema.anyOf || schema.oneOf) {
    out = [...new Set((schema.anyOf || schema.oneOf).map((s) => tsType(s, indent)))].join(" | ");
  } else if (schema.allOf) out = schema.allOf.map((s) => tsType(s, indent)).join(" & ");
  else if (Array.isArray(schema.type)) {
    out = [...new Set(schema.type.map((t) => tsType({ ...schema, type: t }, indent)))].join(" | ");
  } else {
    switch (schema.type) {
      case "string": out = "string"; break;
      case "number": case "integer": out = "number"; break;
      case "boolean": out = "boolean"; break;
      case "null": out = "null"; break;
      case "array": out = `Array<${schema.items ? tsType(schema.items, indent) : "unknown"}>`; break;
      case "object": out = tsObject(schema, indent); break;
      default: out = schema.properties ? tsObject(schema, indent) : "unknown";
    }
  }
  if (schema.nullable) out += " | null";
  return out;
}

function tsObject(schema, indent) {
  const props = Object.entries(schema.properties || {});
  const ap = schema.additionalProperties;
  if (props.length === 0) {
    if (ap === false) return "Record<string, never>";
    if (ap && typeof ap === "object" && Object.keys(ap).length) return `Record<string, ${tsType(ap, indent)}>`;
    return "Record<string, unknown>";
  }
  const req = new Set(schema.required || []);
  const inner = indent + "  ";
  const lines = props.map(([k, v]) => `${inner}${isIdent(k) ? k : lit(k)}${req.has(k) ? "" : "?"}: ${tsType(v, inner)};`);
  if (ap === true || (ap && typeof ap === "object")) lines.push(`${inner}[key: string]: unknown;`);
  return `{\n${lines.join("\n")}\n${indent}}`;
}

function jsdoc(lines, indent) {
  const clean = lines.flatMap((l) => String(l).split("\n")).map((l) => l.replace(/\*\//g, "*\\/").trimEnd());
  while (clean.length && clean[clean.length - 1] === "") clean.pop();
  return `${indent}/**\n${clean.map((l) => `${indent} *${l ? " " + l : ""}`).join("\n")}\n${indent} */`;
}

function genTs() {
  const o = [];
  o.push(`// Generated by scripts/generate.mjs from openapi.json (API ${spec.info.version}). Do not edit by hand.`);
  o.push("");
  o.push("/** A resource returned by the API. Field-level types are in the API guide. */");
  o.push("export type ApiObject = Record<string, any>;");
  o.push("");
  o.push("/** A page of results. Most lists return `items`; document requests return `rows`. Use `pageItems()` to read either. */");
  o.push("export type Page = {");
  o.push("  items?: ApiObject[];");
  o.push("  rows?: ApiObject[];");
  o.push("  total: number;");
  o.push("  page: number;");
  o.push("  limit: number;");
  o.push("  [key: string]: unknown;");
  o.push("};");
  o.push("");
  o.push("/** The shared transport the generated resources call. Implemented by the Kargoplex client. */");
  o.push("export type RequestFn = (");
  o.push("  method: string,");
  o.push("  path: string,");
  o.push("  options?: { query?: object; body?: unknown },");
  o.push(") => Promise<any>;");
  o.push("");
  o.push("const enc = (v: string): string => encodeURIComponent(v);");
  o.push("");
  for (const r of resources) {
    for (const op of r.ops) {
      if (op.query.length) o.push(`export type ${typeName(op, "Params")} = ${tsType(querySchema(op))};`, "");
      if (op.body) o.push(`export type ${typeName(op, "Body")} = ${tsType(op.body)};`, "");
    }
  }
  for (const r of resources) {
    o.push(`export class ${r.type.replace(/ /g, "")}Resource {`);
    o.push("  private readonly request: RequestFn;");
    o.push("");
    o.push("  constructor(request: RequestFn) {");
    o.push("    this.request = request;");
    o.push("  }");
    for (const op of r.ops) {
      const args = op.pathParams.map((p) => `${camel(p)}: string`);
      const opts = [];
      if (op.body) {
        args.push(`body${op.bodyRequired ? "" : "?"}: ${typeName(op, "Body")}`);
        opts.push("body");
      }
      if (op.query.length) {
        const allOptional = op.query.every((p) => !p.required);
        args.push(`params${allOptional ? "?" : ""}: ${typeName(op, "Params")}`);
        opts.push("query: params");
      }
      const ret = op.isList ? "Page" : "ApiObject";
      const pathExpr = "`" + op.path.replace(/\{([^}]+)\}/g, (_, p) => "${enc(" + camel(p) + ")}") + "`";
      const optStr = opts.length ? `, { ${opts.join(", ")} }` : "";
      o.push("");
      o.push(jsdoc([op.summary, "", op.description, "", `${op.method} ${op.path}`], "  "));
      o.push(`  readonly ${camel(op.name)} = (${args.join(", ")}): Promise<${ret}> =>`);
      o.push(`    this.request(${lit(op.method)}, ${pathExpr}${optStr});`);
    }
    o.push("}");
    o.push("");
  }
  return o.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n";
}

// ---------- Python ----------
const pyLit = (v) => (v === true ? "True" : v === false ? "False" : v === null ? "None" : JSON.stringify(v));

function genPy() {
  const hoisted = []; // TypedDict blocks, children before parents
  const usedNames = new Set();
  const uniqueName = (base) => {
    let n = base, i = 2;
    while (usedNames.has(n)) n = `${base}${i++}`;
    usedNames.add(n);
    return n;
  };

  function pyType(schema, hint) {
    schema = resolveRef(schema);
    if (!schema || typeof schema !== "object" || Object.keys(schema).length === 0) return "Any";
    let out;
    if ("const" in schema) out = `Literal[${pyLit(schema.const)}]`;
    else if (schema.enum) out = `Literal[${[...new Set(schema.enum.map(pyLit))].join(", ")}]`;
    else if (schema.anyOf || schema.oneOf) {
      const parts = [...new Set((schema.anyOf || schema.oneOf).map((s) => pyType(s, hint)))];
      out = parts.length === 1 ? parts[0] : `Union[${parts.join(", ")}]`;
    } else if (schema.allOf) out = "Dict[str, Any]";
    else if (Array.isArray(schema.type)) {
      const parts = [...new Set(schema.type.map((t) => pyType({ ...schema, type: t }, hint)))];
      out = parts.length === 1 ? parts[0] : `Union[${parts.join(", ")}]`;
    } else {
      switch (schema.type) {
        case "string": out = "str"; break;
        case "integer": out = "int"; break;
        case "number": out = "float"; break;
        case "boolean": out = "bool"; break;
        case "null": out = "None"; break;
        case "array": out = `List[${schema.items ? pyType(schema.items, hint + "Item") : "Any"}]`; break;
        case "object": out = pyObject(schema, hint); break;
        default: out = schema.properties ? pyObject(schema, hint) : "Any";
      }
    }
    if (schema.nullable) out = `Optional[${out}]`;
    return out;
  }

  function pyObject(schema, hint) {
    const props = Object.entries(schema.properties || {});
    if (props.length === 0) return "Dict[str, Any]";
    const req = new Set(schema.required || []);
    const name = uniqueName(hint);
    const fields = props.map(([k, v]) => [k, pyType(v, name + pascal(k)), req.has(k)]);
    const functional = fields.some(([k]) => !isIdent(k) || PY_KEYWORDS.has(k) || k.includes("$"));
    const required = fields.filter((f) => f[2]);
    const optional = fields.filter((f) => !f[2]);
    let block;
    if (functional) {
      // Functional syntax cannot inherit, so all keys are optional here; required keys are noted.
      block = `${name} = TypedDict(${lit(name)}, {${fields.map(([k, t]) => `${lit(k)}: ${t}`).join(", ")}}, total=False)`;
      if (required.length) block += `  # required: ${required.map((f) => f[0]).join(", ")}`;
    } else if (required.length && optional.length) {
      const base = uniqueName(name + "Required");
      block = `class ${base}(TypedDict):\n${required.map(([k, t]) => `    ${k}: ${t}`).join("\n")}\n\n\nclass ${name}(${base}, total=False):\n${optional.map(([k, t]) => `    ${k}: ${t}`).join("\n")}`;
    } else if (required.length) {
      block = `class ${name}(TypedDict):\n${required.map(([k, t]) => `    ${k}: ${t}`).join("\n")}`;
    } else {
      block = `class ${name}(TypedDict, total=False):\n${optional.map(([k, t]) => `    ${k}: ${t}`).join("\n")}`;
    }
    hoisted.push(block);
    return name;
  }

  for (const r of resources) {
    for (const op of r.ops) {
      if (op.query.length) pyObject(querySchema(op), typeName(op, "Params"));
      if (op.body) {
        const hint = typeName(op, "Body");
        const t = pyType(op.body, hint);
        if (t !== hint) hoisted.push(`${hint} = ${t}`);
      }
    }
  }

  const o = [];
  o.push(`# Generated by scripts/generate.mjs from openapi.json (API ${spec.info.version}). Do not edit by hand.`);
  o.push("from typing import Any, Callable, Dict, List, Literal, Optional, TypedDict, Union");
  o.push("from urllib.parse import quote as _quote");
  o.push("");
  o.push("ApiObject = Dict[str, Any]");
  o.push("# A resource returned by the API. Field-level types are in the API guide.");
  o.push("Page = Dict[str, Any]");
  o.push("# A page of results: `items` (`rows` for document requests), `total`, `page`, `limit`.");
  o.push("RequestFn = Callable[..., Any]");
  o.push("");
  o.push("");
  o.push("def _enc(value: str) -> str:");
  o.push('    return _quote(str(value), safe="")');
  o.push("");
  for (const b of hoisted) o.push("", b, "");
  for (const r of resources) {
    o.push("", `class ${r.type.replace(/ /g, "")}Resource:`);
    o.push("    def __init__(self, request: RequestFn) -> None:");
    o.push("        self._request = request");
    for (const op of r.ops) {
      const args = ["self", ...op.pathParams.map((p) => `${snake(p)}: str`)];
      const callOpts = [];
      if (op.body) {
        args.push(op.bodyRequired ? `body: ${typeName(op, "Body")}` : `body: Optional[${typeName(op, "Body")}] = None`);
        callOpts.push("body=body");
      }
      if (op.query.length) {
        const allOptional = op.query.every((p) => !p.required);
        args.push(allOptional ? `params: Optional[${typeName(op, "Params")}] = None` : `params: ${typeName(op, "Params")}`);
        callOpts.push("query=params");
      }
      const sorted = [args[0], ...args.slice(1).filter((a) => !a.includes(" = ")), ...args.slice(1).filter((a) => a.includes(" = "))];
      const pathExpr = op.path.replace(/\{([^}]+)\}/g, (_, p) => `{_enc(${snake(p)})}`);
      const doc = [op.summary, op.scope ? `Requires the \`${op.scope}\` scope.` : "", `${op.method} ${op.path}`]
        .filter(Boolean)
        .map((l) => l.replace(/\\/g, "\\\\").replace(/"""/g, '\\"\\"\\"'));
      o.push("");
      o.push(`    def ${snake(op.name)}(${sorted.join(", ")}) -> ${op.isList ? "Page" : "ApiObject"}:`);
      o.push(`        """${doc[0]}`);
      if (doc.length > 1) o.push("", ...doc.slice(1).map((l) => `        ${l}`));
      o.push('        """');
      o.push(`        return self._request(${lit(op.method)}, ${op.pathParams.length ? "f" : ""}${lit(pathExpr)}${callOpts.length ? ", " + callOpts.join(", ") : ""})`);
    }
    o.push("");
  }
  return o.join("\n").replace(/\n{4,}/g, "\n\n\n").replace(/\s+$/, "") + "\n";
}

// ---------- write / check ----------
const outputs = [
  [resolve(root, "ts/src/generated.ts"), genTs()],
  [resolve(root, "python/kargoplex/_generated.py"), genPy()],
];

let drift = false;
for (const [file, content] of outputs) {
  if (check) {
    const current = existsSync(file) ? readFileSync(file, "utf8") : null;
    if (current !== content) {
      console.error(`DRIFT: ${file} differs from what the generator produces. Run: node scripts/generate.mjs`);
      drift = true;
    }
  } else {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    console.log(`wrote ${file}`);
  }
}
if (check) {
  if (drift) process.exit(1);
  console.log("Generated files are up to date.");
}
