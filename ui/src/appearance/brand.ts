import { useSyncExternalStore } from "react";
import { readPreference, writePreference } from "../lib/storage";

/**
 * The product name and logo an admin set (`appearance.product_name`, the logo upload). The name
 * fills `{product}` in every message (the window title among them) and stands in the sidebar and
 * on the sign-in page; the logo replaces the Kalzit mark there and becomes the tab's icon.
 */
export interface Brand {
  productName: string;
  /** The logo's same-origin URL, or null for the Kalzit mark. */
  logoUrl: string | null;
}

export const DEFAULT_PRODUCT_NAME = "Kalzit";
const BRAND_STORAGE_KEY = "kalzit.brand";
const DEFAULT_FAVICON = "/favicon.svg";

function stored(): Brand {
  try {
    const value = JSON.parse(readPreference(BRAND_STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    return {
      productName:
        typeof value.productName === "string" && value.productName.trim() !== ""
          ? value.productName
          : DEFAULT_PRODUCT_NAME,
      logoUrl:
        typeof value.logoUrl === "string" && value.logoUrl.startsWith("/api/branding/logo")
          ? value.logoUrl
          : null,
    };
  } catch {
    return { productName: DEFAULT_PRODUCT_NAME, logoUrl: null };
  }
}

let current: Brand = stored();
const listeners = new Set<() => void>();

function applyFavicon(brand: Brand): void {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (link === null) {
    return;
  }
  const href = brand.logoUrl ?? DEFAULT_FAVICON;
  if (link.getAttribute("href") !== href) {
    link.setAttribute("href", href);
    // The logo is PNG, JPEG or WebP; the browser reads its type from the answer.
    if (brand.logoUrl === null) {
      link.setAttribute("type", "image/svg+xml");
    } else {
      link.removeAttribute("type");
    }
  }
}

applyFavicon(current);

export function getBrand(): Brand {
  return current;
}

export function setBrand(next: Brand): void {
  if (next.productName === current.productName && next.logoUrl === current.logoUrl) {
    return;
  }
  current = next;
  writePreference(BRAND_STORAGE_KEY, JSON.stringify(next));
  applyFavicon(next);
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeBrand(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useBrand(): Brand {
  return useSyncExternalStore(subscribeBrand, getBrand, getBrand);
}

/** The logo's URL for a hash: it changes with every new image, so caches never show an old one. */
export function logoUrlFor(sha256: string): string {
  return `/api/branding/logo?v=${encodeURIComponent(sha256.slice(0, 16))}`;
}
