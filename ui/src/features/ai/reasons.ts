import { catalogs, type MessageKey, type Translate } from "../../i18n/i18n";
import { errorReason, type Reason, reasonText } from "../datasources/reasons";

const PREFIX = "ai.reason.";

/** The catalog key of an AI reason this UI knows (docs/api/ai.md, "Reasons"). */
export function aiReasonKey(reason: string): MessageKey | undefined {
  const key = `${PREFIX}${reason}`;
  return Object.hasOwn(catalogs.en, key) ? (key as MessageKey) : undefined;
}

/**
 * The text of a reason from the AI routes: `ai.*` reasons from the AI catalog, the target and
 * request reasons they share with data sources from there, else the server's English text.
 */
export function aiReasonText(t: Translate, reason: Reason): string | undefined {
  const key = aiReasonKey(reason.reason);
  if (key !== undefined) {
    return t(key, reason.params ?? {});
  }
  return reasonText(t, reason);
}

/** The text of a failed AI request, when it carries a reason. */
export function aiErrorText(t: Translate, error: unknown): string | undefined {
  const reason = errorReason(error);
  return reason === undefined ? undefined : aiReasonText(t, reason);
}
