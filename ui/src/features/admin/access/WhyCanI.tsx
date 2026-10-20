import { useQuery } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import type { Permission } from "../../../api/generated/shapes";
import { type MessageKey, useI18n } from "../../../i18n/i18n";
import { useEscapeLayer } from "../../../lib/layers";
import { useCurrentOrg } from "../../../org/useOrg";
// Dialogs and the popover are used outside the administration too (stream areas).
import "../admin.css";
import { adminKeys, type ExplainKind, explainPermission, type ResourceType } from "../api";
import { PERMISSION_TEXT } from "../catalog";
import { LoadState } from "../components/Section";

const KIND_TEXT: Record<ExplainKind, MessageKey> = {
  orgRole: "admin.why.orgRole",
  teamRole: "admin.why.teamRole",
  customRole: "admin.why.customRole",
  grant: "admin.why.grant",
};

export interface WhyCanIProps {
  permission: Permission;
  /** The folder, dashboard or data source the question is about; the whole organization if absent. */
  resource?: { type: ResourceType; id: string } | undefined;
  /** The organization; the current one if absent. */
  orgId?: string | undefined;
}

/**
 * A small "Why?" button that opens a popover listing where a permission comes from: the
 * organization role, a team's role, a custom role or a grant on the resource (the explain route).
 * It asks the server only when opened.
 */
export function WhyCanI({ permission, resource, orgId }: WhyCanIProps) {
  const { t } = useI18n();
  const current = useCurrentOrg();
  const org = orgId ?? current?.id;
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const popoverId = useId();
  const titleId = useId();
  const explain = useQuery({
    queryKey: adminKeys.explain(org ?? "", permission, resource?.type, resource?.id),
    queryFn: () => explainPermission(org ?? "", permission, resource),
    enabled: open && org !== undefined,
  });

  function close(returnFocus: boolean) {
    setOpen(false);
    if (returnFocus) {
      buttonRef.current?.focus();
    }
  }

  useEscapeLayer(open, () => close(true));

  useEffect(() => {
    if (open) {
      titleRef.current?.focus();
    }
  }, [open]);

  const onOutsidePointer = useEffectEvent((event: PointerEvent) => {
    if (event.target instanceof Node && anchorRef.current?.contains(event.target) !== true) {
      close(false);
    }
  });

  useEffect(() => {
    if (!open) {
      return;
    }
    const listener = (event: PointerEvent) => onOutsidePointer(event);
    document.addEventListener("pointerdown", listener);
    return () => document.removeEventListener("pointerdown", listener);
  }, [open]);

  if (org === undefined) {
    return null;
  }
  const entries = explain.data ?? [];
  return (
    <span className="admin-why" ref={anchorRef}>
      <button
        ref={buttonRef}
        type="button"
        className="admin-link-button"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        aria-label={t("admin.why.buttonLabel", { permission })}
        onClick={() => (open ? close(false) : setOpen(true))}
      >
        {t("admin.why.button")}
      </button>
      {open ? (
        <div
          id={popoverId}
          role="dialog"
          aria-labelledby={titleId}
          className="admin-popover"
          onBlur={(event) => {
            // Leaving the popover with Tab closes it, as a menu does.
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              close(false);
            }
          }}
        >
          <h3 className="admin-popover__title" id={titleId} ref={titleRef} tabIndex={-1}>
            {t("admin.why.title")}
          </h3>
          <p className="admin-popover__text">
            <code>{permission}</code> {t(PERMISSION_TEXT[permission])}
          </p>
          {explain.data === undefined ? (
            <LoadState error={explain.error} onRetry={() => void explain.refetch()} />
          ) : entries.length === 0 ? (
            <p className="admin-popover__text">{t("admin.why.none")}</p>
          ) : (
            <ul className="admin-popover__list">
              {entries.map((entry) => (
                <li key={`${entry.kind}:${entry.name}`}>
                  {t(KIND_TEXT[entry.kind], { name: entry.name })}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </span>
  );
}
