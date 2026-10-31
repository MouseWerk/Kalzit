import { isApiError, isRecord } from "../../../api/client";
import type { Translate } from "../../../i18n/i18n";
import { reasonText } from "../../datasources/reasons";
import { roleLabel } from "../catalog";
import { type ErrorTexts, errorText } from "../errors";
import type { Outcome, OutcomeOrg } from "./api";

/** The reason of a failed request with its params, numbers included (`people`). */
export function ssoReason(
  error: unknown,
): { reason: string; params: Record<string, string>; message: string } | undefined {
  if (!isApiError(error) || !isRecord(error.body) || !isRecord(error.body.error)) {
    return undefined;
  }
  const body = error.body.error;
  if (typeof body.reason !== "string" || body.reason === "") {
    return undefined;
  }
  const params: Record<string, string> = {};
  if (isRecord(body.params)) {
    for (const [name, value] of Object.entries(body.params)) {
      if (typeof value === "string" || typeof value === "number") {
        params[name] = String(value);
      }
    }
  }
  return {
    reason: body.reason,
    params,
    message: typeof body.message === "string" ? body.message : "",
  };
}

/**
 * The text of a failed sign-in administration request: its reason in the user's language
 * (docs/api/sso.md, "Reasons"), else the text of its code.
 */
export function ssoErrorText(t: Translate, error: unknown, texts: ErrorTexts = {}): string {
  const reason = ssoReason(error);
  if (reason !== undefined) {
    const text = reasonText(t, {
      reason: reason.reason,
      params: reason.params,
      fallback: reason.message,
    });
    if (text !== undefined) {
      return text;
    }
  }
  return errorText(t, error, texts);
}

/**
 * The reason of a failed test sign-in (`sso.outcome_<outcome>`, or what a SAML check refused)
 * as a sentence.
 */
export function testFailureText(
  t: Translate,
  error: { reason: string; message: string; params?: Record<string, unknown> },
): string {
  const params: Record<string, string> = {};
  for (const [name, value] of Object.entries(error.params ?? {})) {
    if (typeof value === "string" || typeof value === "number") {
      params[name] = String(value);
    }
  }
  return reasonText(t, { reason: error.reason, params, fallback: error.message }) ?? error.reason;
}

/** "Admin in Analytical Engines", with the team and who decides, for one organization. */
function orgLine(t: Translate, org: OutcomeOrg): string {
  return t("sso.outcome.roleIn", { role: roleLabel(t, org.role, undefined), org: org.orgName });
}

/** What a mapping would make of a person: "would be Admin in X", or refused. */
export function outcomeText(t: Translate, outcome: Outcome): string {
  if (outcome.refused) {
    return t("sso.outcome.refused");
  }
  if (outcome.orgs.length === 0) {
    return t("sso.outcome.none");
  }
  return t("sso.outcome.would", {
    orgs: outcome.orgs.map((org) => orgLine(t, org)).join(", "),
  });
}

/** One organization of a preview: role, the group it came from, teams and who decides. */
export function outcomeDetail(t: Translate, org: OutcomeOrg): string {
  const parts = [
    org.default || org.group === null
      ? t("sso.outcome.fromDefault", { role: roleLabel(t, org.role, undefined) })
      : t("sso.outcome.fromGroup", { role: roleLabel(t, org.role, undefined), group: org.group }),
  ];
  if (org.teams.length > 0) {
    parts.push(
      t("sso.outcome.teams", { teams: org.teams.map((team) => team.teamName).join(", ") }),
    );
  }
  parts.push(t(org.idpDecides ? "sso.outcome.idpDecides" : "sso.outcome.manual"));
  return parts.join(" · ");
}
