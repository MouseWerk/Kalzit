/**
 * HTTPS certificates over ACME (docs/api/settings-dashboards.md, "HTTPS certificates"), server
 * administrators only. The settings are saved in one step: the server checks every field, the
 * directory and the names, and answers the first problem with its field and reason.
 */
import { expectShape, isRecord, request } from "../../api/client";

export type AcmeDirectory = "letsencrypt" | "letsencrypt_staging" | "custom";
export type AcmeChallenge = "http-01" | "tls-alpn-01";

export interface AcmeSettings {
  enabled: boolean;
  directory: AcmeDirectory;
  directoryUrl: string;
  directoryCa: string;
  domains: string[];
  email: string;
  challenge: AcmeChallenge;
  acceptTerms: boolean;
}

/** The fields the server names in `error.field`. */
export type AcmeField = keyof AcmeSettings;

export interface AcmeProblem {
  reason: string;
  params: Record<string, string>;
  message: string;
}

export interface AcmeCertificate {
  domains: string[];
  issuer: string;
  notBefore: number;
  notAfter: number;
  issuedAt: number;
  directoryUrl: string;
  renewAt: number;
}

export type AcmePhase = "off" | "waiting" | "working" | "valid" | "failed";

export interface AcmeView {
  settings: AcmeSettings;
  version: number;
  status: {
    phase: AcmePhase;
    certificate: AcmeCertificate | null;
    nextAttemptAt: number | null;
    lastError: (AcmeProblem & { at: number }) | null;
    failures: number;
  };
  server: { httpAddr: string | null; httpsAddr: string | null; certificateFiles: boolean };
}

export interface AcmeChecked {
  termsOfService: string | null;
  warnings: AcmeProblem[];
}

export const acmeKey = ["admin", "acme"] as const;

function isView(value: unknown): value is AcmeView {
  return (
    isRecord(value) &&
    isRecord(value.settings) &&
    typeof value.version === "number" &&
    isRecord(value.status) &&
    typeof value.status.phase === "string" &&
    isRecord(value.server)
  );
}

function isChecked(value: unknown): value is AcmeChecked {
  return isRecord(value) && Array.isArray(value.warnings);
}

export async function getAcme(): Promise<AcmeView> {
  return expectShape(await request("GET", "/api/admin/acme"), isView, "ACME status");
}

export async function saveAcme(settings: AcmeSettings, version: number): Promise<AcmeView> {
  return expectShape(
    await request("PUT", "/api/admin/acme", { settings, version }),
    isView,
    "ACME status",
  );
}

export async function testAcme(settings: AcmeSettings): Promise<AcmeChecked> {
  return expectShape(
    await request("POST", "/api/admin/acme/test", { settings }),
    isChecked,
    "ACME test",
  );
}

export async function renewAcme(): Promise<AcmeView> {
  return expectShape(await request("POST", "/api/admin/acme/renew"), isView, "ACME status");
}
