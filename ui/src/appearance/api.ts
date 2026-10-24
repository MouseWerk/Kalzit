import { queryOptions, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { expectShape, isRecord, request } from "../api/client";
import { setDefaultTimeSettings, WEEK_STARTS, type WeekStart } from "../lib/timeSettings";
import { DEFAULT_PRODUCT_NAME, logoUrlFor, setBrand } from "./brand";
import { START_PAGES, type StartPage } from "./contrast";
import { lookFrom, setLook } from "./look";

/**
 * The brand and look from the server (docs/api/settings-dashboards.md, "Appearance and brand"):
 * `GET /api/branding` before and after sign-in, `GET /api/orgs/{orgId}/appearance` for the
 * organization the user works in, whose own values win over the server's.
 */

export interface Branding {
  productName: string;
  logo: { contentType: string; sha256: string } | null;
  signIn: { welcome: string; notice: string };
  defaultTheme: string;
  defaultLanguage: string;
  accent: unknown;
  density: unknown;
  fontSize: unknown;
}

export interface OrgAppearance {
  accent: unknown;
  density: unknown;
  fontSize: unknown;
  startPage: StartPage;
  /** An IANA zone, or null for the browser's. */
  timeZone: string | null;
  weekStart: WeekStart;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export async function fetchBranding(): Promise<Branding> {
  const value = expectShape(await request("GET", "/api/branding"), isRecord, "branding");
  const logo = value.logo;
  const signIn = isRecord(value.signIn) ? value.signIn : {};
  const name = text(value.productName).trim();
  return {
    productName: name === "" ? DEFAULT_PRODUCT_NAME : name,
    logo:
      isRecord(logo) && typeof logo.sha256 === "string"
        ? { contentType: text(logo.contentType), sha256: logo.sha256 }
        : null,
    signIn: { welcome: text(signIn.welcome), notice: text(signIn.notice) },
    defaultTheme: text(value.defaultTheme, "system"),
    defaultLanguage: text(value.defaultLanguage, "de"),
    accent: value.accent,
    density: value.density,
    fontSize: value.fontSize,
  };
}

export async function fetchOrgAppearance(orgId: string): Promise<OrgAppearance> {
  const value = expectShape(
    await request("GET", `/api/orgs/${encodeURIComponent(orgId)}/appearance`),
    isRecord,
    "appearance",
  );
  const zone = text(value.timeZone, "browser");
  return {
    accent: value.accent,
    density: value.density,
    fontSize: value.fontSize,
    startPage: START_PAGES.find((page) => page === value.startPage) ?? "home",
    timeZone: zone === "browser" ? null : zone,
    weekStart: WEEK_STARTS.find((start) => start === value.weekStart) ?? "monday",
  };
}

export const brandingQuery = queryOptions({
  queryKey: ["branding"],
  queryFn: fetchBranding,
  staleTime: 60_000,
});

export function orgAppearanceQuery(orgId: string) {
  return queryOptions({
    queryKey: ["appearance", orgId],
    queryFn: () => fetchOrgAppearance(orgId),
    staleTime: 60_000,
  });
}

function applyBranding(branding: Branding): void {
  setBrand({
    productName: branding.productName,
    logoUrl: branding.logo === null ? null : logoUrlFor(branding.logo.sha256),
  });
}

/** For the pages before sign-in: the server's brand and look. */
export function useBrandingSync(): Branding | undefined {
  const branding = useQuery(brandingQuery);
  useEffect(() => {
    if (branding.data !== undefined) {
      applyBranding(branding.data);
      setLook(lookFrom(branding.data));
    }
  }, [branding.data]);
  return branding.data;
}

/**
 * For the signed-in app: the brand, and the look and time defaults of the organization the user
 * works in (the server's where they belong to none).
 */
export function useAppearanceSync(orgId: string | undefined): void {
  const branding = useQuery(brandingQuery);
  const org = useQuery({ ...orgAppearanceQuery(orgId ?? ""), enabled: orgId !== undefined });
  useEffect(() => {
    if (branding.data !== undefined) {
      applyBranding(branding.data);
    }
    const source = org.data ?? branding.data;
    if (source !== undefined) {
      setLook(lookFrom(source));
    }
    if (org.data !== undefined) {
      setDefaultTimeSettings({ timeZone: org.data.timeZone, weekStart: org.data.weekStart });
    }
  }, [branding.data, org.data]);
}
