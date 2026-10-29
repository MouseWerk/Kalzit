/**
 * The browser's passkey dialogs. The server sends the options of `navigator.credentials.create`
 * and `.get` as JSON with base64url strings for the binary parts, and takes the answer back the
 * same way (the WebAuthn JSON forms); this converts both directions.
 */
import { isRecord } from "../../api/client";

function fromBase64Url(text: string): ArrayBuffer {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function toBase64Url(buffer: ArrayBuffer | null | undefined): string | null {
  if (buffer === null || buffer === undefined) {
    return null;
  }
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Whether this browser can show passkey dialogs at all (a secure context with WebAuthn). */
export function passkeysAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    typeof window.PublicKeyCredential === "function" &&
    typeof navigator.credentials?.create === "function"
  );
}

function publicKeyOf(options: unknown): Record<string, unknown> {
  if (!isRecord(options) || !isRecord(options.publicKey)) {
    throw new TypeError("the server sent no passkey options");
  }
  return options.publicKey;
}

function descriptors(list: unknown): PublicKeyCredentialDescriptor[] | undefined {
  if (!Array.isArray(list)) {
    return undefined;
  }
  return list.filter(isRecord).map((item) => ({
    type: "public-key",
    id: fromBase64Url(String(item.id)),
    ...(Array.isArray(item.transports)
      ? { transports: item.transports as AuthenticatorTransport[] }
      : {}),
  }));
}

/** Opens the browser's dialog that creates a passkey; answers the credential as JSON. */
export async function createPasskey(options: unknown): Promise<unknown> {
  const raw = publicKeyOf(options);
  const user = isRecord(raw.user) ? raw.user : {};
  const publicKey = {
    ...raw,
    challenge: fromBase64Url(String(raw.challenge)),
    user: { ...user, id: fromBase64Url(String(user.id)) },
    excludeCredentials: descriptors(raw.excludeCredentials),
  } as unknown as PublicKeyCredentialCreationOptions;
  const credential = (await navigator.credentials.create({
    publicKey,
  })) as PublicKeyCredential | null;
  if (credential === null) {
    throw new DOMException("no passkey was created", "NotAllowedError");
  }
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    response: {
      attestationObject: toBase64Url(response.attestationObject),
      clientDataJSON: toBase64Url(response.clientDataJSON),
      ...(typeof response.getTransports === "function"
        ? { transports: response.getTransports() }
        : {}),
    },
    extensions: credential.getClientExtensionResults?.() ?? {},
  };
}

/** Opens the browser's dialog that confirms with one of the account's passkeys. */
export async function getPasskey(options: unknown): Promise<unknown> {
  const raw = publicKeyOf(options);
  const publicKey = {
    ...raw,
    challenge: fromBase64Url(String(raw.challenge)),
    allowCredentials: descriptors(raw.allowCredentials),
  } as unknown as PublicKeyCredentialRequestOptions;
  const credential = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
  if (credential === null) {
    throw new DOMException("no passkey was chosen", "NotAllowedError");
  }
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    response: {
      authenticatorData: toBase64Url(response.authenticatorData),
      clientDataJSON: toBase64Url(response.clientDataJSON),
      signature: toBase64Url(response.signature),
      userHandle: toBase64Url(response.userHandle),
    },
    extensions: credential.getClientExtensionResults?.() ?? {},
  };
}

/** The person closed the dialog, or the device has no matching passkey. */
export function isPasskeyCancelled(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "NotAllowedError" || error.name === "AbortError")
  );
}

export const base64UrlForTests = { fromBase64Url, toBase64Url };
