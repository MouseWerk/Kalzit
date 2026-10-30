/**
 * The mail server (docs/api/mail.md, "Mail server"), server administrators only. The settings
 * are saved in one step after the server connected and signed in; a test mail sends one message
 * with the values in the form.
 */
import { expectShape, isRecord, request } from "../../api/client";
import { type Delivered, isDelivered } from "../admin/invitationsApi";

export type MailSecurity = "starttls" | "tls" | "none";

export interface MailSettings {
  host: string;
  /** 0: the usual port of the encryption. */
  port: number;
  security: MailSecurity;
  username: string;
  fromName: string;
  fromAddress: string;
  replyTo: string;
}

/** The fields the server names in `error.field`; `to` is the test mail's recipient. */
export type MailField = keyof MailSettings | "password" | "to";

export type MailSource = "default" | "database" | "file" | "environment";

export interface MailView {
  settings: MailSettings | null;
  hasPassword: boolean;
  source: MailSource;
  editable: boolean;
  version: number;
  publicUrl: string | null;
}

export const mailKey = ["admin", "mail"] as const;

function isSettings(value: unknown): value is MailSettings {
  return (
    isRecord(value) &&
    typeof value.host === "string" &&
    typeof value.port === "number" &&
    ["starttls", "tls", "none"].includes(String(value.security)) &&
    typeof value.username === "string" &&
    typeof value.fromName === "string" &&
    typeof value.fromAddress === "string" &&
    typeof value.replyTo === "string"
  );
}

function isView(value: unknown): value is MailView {
  return (
    isRecord(value) &&
    (value.settings === null || isSettings(value.settings)) &&
    typeof value.hasPassword === "boolean" &&
    ["default", "database", "file", "environment"].includes(String(value.source)) &&
    typeof value.editable === "boolean" &&
    typeof value.version === "number" &&
    (value.publicUrl === null || typeof value.publicUrl === "string")
  );
}

export async function getMail(): Promise<MailView> {
  return expectShape(await request("GET", "/api/admin/mail"), isView, "mail settings");
}

/**
 * Saves after the server's check; `settings: null` removes the mail server. `password`
 * undefined keeps the stored one (same server and user), "" clears it.
 */
export async function saveMail(
  settings: MailSettings | null,
  password: string | undefined,
  version: number,
): Promise<MailView> {
  const body = password === undefined ? { settings, version } : { settings, password, version };
  return expectShape(await request("PUT", "/api/admin/mail", body), isView, "mail settings");
}

export async function sendTestMail(
  settings: MailSettings | null,
  password: string | undefined,
  to: string,
): Promise<Delivered> {
  const body: Record<string, unknown> = { to };
  if (settings !== null) {
    body.settings = settings;
  }
  if (password !== undefined) {
    body.password = password;
  }
  return expectShape(await request("POST", "/api/admin/mail/test", body), isDelivered, "test mail");
}
