import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { crc32 } from "node:zlib";

/**
 * The test plugin of the server's contract tests (plugin-api/test-plugin), built by CI next to
 * the server: `KALZIT_E2E_PLUGIN_BINARY` names it. Without it (a local run that did not build
 * it) the specs and pictures that need it are skipped.
 */
export const BINARY = process.env.KALZIT_E2E_PLUGIN_BINARY ?? "";
export const ID = "dev.e2etest.numbers";
export const NAME = "E2E numbers";

function platform(): string {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `${process.platform === "win32" ? "windows" : "linux"}-${arch}`;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A zip archive with stored (uncompressed) entries, which is all a package needs. */
export function zip(entries: { name: string; data: Uint8Array }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const path = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12); // 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(path.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(path.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, path, Buffer.from(data));
    centrals.push(central, path);
    offset += local.length + path.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** A publisher's signing key as a test makes one: trusted through the API, then used to sign. */
export interface PublisherKey {
  /** The key id packages name: the first 16 hex digits of the public key's SHA-256. */
  keyId: string;
  /** The raw Ed25519 public key in base64, as `POST /api/admin/plugin-keys` takes it. */
  publicKey: string;
  privateKey: KeyObject;
}

export function publisherKey(): PublisherKey {
  const keys = generateKeyPairSync("ed25519");
  const raw = Buffer.from(keys.publicKey.export({ format: "jwk" }).x ?? "", "base64url");
  return {
    keyId: sha256(raw).slice(0, 16),
    publicKey: raw.toString("base64"),
    privateKey: keys.privateKey,
  };
}

/**
 * A package of `manifest` and `files`, signed with `key` when given: the signature covers the
 * manifest (with the files' checksums in it) under Kalzit's domain prefix (docs/api/plugins.md).
 */
export function packageOf(
  manifest: string,
  files: { name: string; data: Uint8Array }[],
  key?: PublisherKey,
): Buffer {
  const text = new TextEncoder().encode(manifest);
  const signature =
    key === undefined
      ? []
      : [
          {
            name: "kalzit-plugin.sig",
            data: new TextEncoder().encode(
              JSON.stringify({
                keyId: key.keyId,
                signature: sign(
                  null,
                  Buffer.concat([Buffer.from("kalzit-plugin-manifest-v1\n"), text]),
                  key.privateKey,
                ).toString("base64"),
              }),
            ),
          },
        ];
  return zip([{ name: "kalzit-plugin.toml", data: text }, ...signature, ...files]);
}

/** The `[files]` table of a manifest: each file with its SHA-256. */
export function filesTable(files: { name: string; data: Uint8Array }[]): string {
  return ["[files]", ...files.map(({ name, data }) => `"${name}" = "${sha256(data)}"`), ""].join(
    "\n",
  );
}

/** An unsigned package of the test plugin in its normal mode, written to `path`. */
export function writePackage(
  path: string,
  options: { id?: string; name?: string; publisher?: string; version?: string } = {},
): void {
  writeFileSync(path, testPluginPackage(options));
}

/**
 * A package of the test plugin in its normal mode: a data source kind with one setting, `host`,
 * that is a network target. Signed with `key` when given.
 */
export function testPluginPackage(
  {
    id = ID,
    name = NAME,
    publisher = "Kalzit E2E",
    version = "1.0.0",
    description,
    network = [],
  }: {
    id?: string;
    name?: string;
    publisher?: string;
    version?: string;
    description?: string;
    /** `[[permissions.network]]` tables, each as its lines of TOML. */
    network?: string[][];
  } = {},
  key?: PublisherKey,
): Buffer {
  const binary = new Uint8Array(readFileSync(BINARY));
  const exe = process.platform === "win32" ? ".exe" : "";
  const bin = `bin/${platform()}/kalzit-test-plugin${exe}`;
  const kind = new TextEncoder().encode(id);
  const mode = new TextEncoder().encode("normal");
  const files = [
    { name: bin, data: binary },
    { name: "kind.txt", data: kind },
    { name: "mode.txt", data: mode },
  ];
  const manifest = [
    "manifest = 1",
    `id = "${id}"`,
    `name = "${name}"`,
    `version = "${version}"`,
    'kind = "datasource"',
    `publisher = "${publisher}"`,
    ...(description === undefined ? [] : [`description = "${description}"`]),
    'min_kalzit = "0.1.0"',
    'shapes = ["frame", "documents", "graph"]',
    "protocol = 1",
    "",
    "[[settings]]",
    'name = "host"',
    'label = { en = "Host", de = "Host" }',
    'type = "string"',
    "required = true",
    "target = true",
    "",
    ...network.flatMap((lines) => ["[[permissions.network]]", ...lines, ""]),
    "[binaries]",
    `${platform()} = "${bin}"`,
    "",
    filesTable(files),
  ].join("\n");
  return packageOf(manifest, files, key);
}
