// Builds the unpacked extension into dist/.
//
// The Google OAuth client id comes from BACKPACK_GOOGLE_CLIENT_ID, or from a
// .env.local file at the repo root. keys/backpack.pem (made on first build,
// never committed) pins the extension id, which the Google OAuth client is
// registered against.
import { build } from "esbuild";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const out = join(here, "dist");

function readEnvFile() {
  const file = join(root, ".env.local");
  if (!existsSync(file)) return {};
  return Object.fromEntries(
    readFileSync(file, "utf8")
      .split("\n")
      .map((line) => /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line))
      .filter(Boolean)
      .map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]),
  );
}

/** The manifest "key" and the extension id it produces. */
function extensionKey() {
  const pemPath = join(root, "keys", "backpack.pem");
  if (!existsSync(pemPath)) {
    mkdirSync(dirname(pemPath), { recursive: true });
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    writeFileSync(pemPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  }
  const der = createPublicKey(createPrivateKey(readFileSync(pemPath))).export({ type: "spki", format: "der" });
  // Chrome's id: the first 32 hex digits of the key's SHA-256, written with a-p.
  const id = [...createHash("sha256").update(der).digest("hex").slice(0, 32)]
    .map((d) => String.fromCharCode(97 + parseInt(d, 16)))
    .join("");
  return { key: der.toString("base64"), id };
}

rmSync(out, { recursive: true, force: true });
await build({
  entryPoints: {
    background: join(here, "src/background.ts"),
    popup: join(here, "src/popup/popup.ts"),
    options: join(here, "src/options/options.ts"),
  },
  bundle: true,
  format: "esm",
  target: "chrome120",
  outdir: out,
  logLevel: "warning",
});
cpSync(join(here, "src/popup/popup.html"), join(out, "popup.html"));
cpSync(join(here, "src/popup/popup.css"), join(out, "popup.css"));
cpSync(join(here, "src/options/options.html"), join(out, "options.html"));
cpSync(join(here, "src/options/options.css"), join(out, "options.css"));
cpSync(join(here, "icons"), join(out, "icons"), { recursive: true });

const clientId = process.env.BACKPACK_GOOGLE_CLIENT_ID ?? readEnvFile().BACKPACK_GOOGLE_CLIENT_ID ?? "";
const { key, id } = extensionKey();
const manifest = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8"));
manifest.key = key;
manifest.oauth2.client_id = clientId || "missing-client-id.apps.googleusercontent.com";
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));

console.log(`Built ${out}`);
console.log(`Extension id: ${id}`);
if (!clientId) console.log("No BACKPACK_GOOGLE_CLIENT_ID yet: Google Calendar won't connect until it's set (see README).");
