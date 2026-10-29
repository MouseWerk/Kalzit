import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { type LinkKind, readToken } from "./linksApi";

/**
 * The token of a mailed link, read once from the fragment (or kept in this tab), after which the
 * address is replaced without the fragment, so the token stays out of the history.
 */
export function useLinkToken(kind: LinkKind, path: "/invite" | "/reset-password"): string {
  const hash = useLocation({ select: (location) => location.hash });
  const navigate = useNavigate();
  const [token] = useState(() => readToken(kind, hash));
  useEffect(() => {
    if (hash !== "") {
      void navigate({ to: path, replace: true });
    }
  }, [hash, navigate, path]);
  return token;
}
