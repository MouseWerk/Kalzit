/**
 * Self-registration (docs/api/mail.md, "Self-registration"): the public routes of the sign-in
 * pages and the requests a server admin approves or declines.
 */
import { expectShape, isRecord, request } from "../api/client";

export interface RegistrationAvailability {
  /** The sign-in page may offer "Create account". */
  available: boolean;
  /** An admin approves each account after its address is confirmed. */
  requiresApproval: boolean;
  /** The domains that may register; filled only while available. */
  allowedDomains: string[];
}

export const registrationKey = ["auth", "registration"] as const;

function isAvailability(value: unknown): value is RegistrationAvailability {
  return (
    isRecord(value) &&
    typeof value.available === "boolean" &&
    typeof value.requiresApproval === "boolean" &&
    Array.isArray(value.allowedDomains) &&
    value.allowedDomains.every((domain) => typeof domain === "string")
  );
}

export async function getRegistration(): Promise<RegistrationAvailability> {
  return expectShape(
    await request("GET", "/api/auth/registration"),
    isAvailability,
    "registration availability",
  );
}

/**
 * Starts a registration for an address. The answer is the same whether or not the address may
 * get a link, so the page never learns (or tells) whether an account has it.
 */
export async function startRegistration(email: string, language: string): Promise<void> {
  await request("POST", "/api/auth/registration", { email, language });
}

export type RegistrationOutcome = "approved" | "pending";

/** Confirms the link from the mail with the account's name and password. */
export async function confirmRegistration(
  token: string,
  name: string,
  password: string,
): Promise<RegistrationOutcome> {
  const value = await request("POST", "/api/auth/registration/confirm", { token, name, password });
  return isRecord(value) && value.status === "approved" ? "approved" : "pending";
}

export interface Registration {
  id: string;
  email: string;
  name: string;
  status: "unconfirmed" | "pending" | "approved" | "rejected";
  orgId: string | null;
  role: string | null;
  createdAt: number;
  expiresAt: number;
  confirmedAt: number | null;
}

function isRegistration(value: unknown): value is Registration {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.email === "string" &&
    typeof value.name === "string" &&
    typeof value.status === "string" &&
    typeof value.createdAt === "number" &&
    typeof value.expiresAt === "number"
  );
}

export const registrationsKey = ["admin", "registrations"] as const;

/** The registrations that wait for a decision, newest first (the first page, up to 100). */
export async function listPendingRegistrations(): Promise<Registration[]> {
  const value = await request("GET", "/api/admin/registrations?status=pending&limit=100");
  const items = isRecord(value) && Array.isArray(value.items) ? value.items : [];
  return items.map((item) => expectShape(item, isRegistration, "registration"));
}

export async function approveRegistration(id: string, role: string): Promise<void> {
  await request("POST", `/api/admin/registrations/${encodeURIComponent(id)}/approve`, { role });
}

export async function rejectRegistration(id: string): Promise<void> {
  await request("POST", `/api/admin/registrations/${encodeURIComponent(id)}/reject`);
}
