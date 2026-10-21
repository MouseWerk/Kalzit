import { useQuery } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState } from "react";
import type { Permission } from "../../../api/generated/shapes";
import { type Translate, useI18n } from "../../../i18n/i18n";
import { useEscapeLayer } from "../../../lib/layers";
import { useCurrentOrg } from "../../../org/useOrg";
// Dialogs and the popover are used outside the administration too (the data areas).
import "../admin.css";
import { adminKeys, explainPermission, type GrantSource, type ResourceType } from "../api";
import { isBuiltInRole, LEVEL_TEXT, PERMISSION_TEXT, RESOURCE_TEXT, roleLabel } from "../catalog";
import { LoadState } from "../components/Section";

export interface WhyCanIProps {
  permission: Permission;
  /** The folder, dashboard or data source the question is about; the whole organization if absent. */
  resource?: { type: ResourceType; id: string } | undefined;
  /** The organization; the current one if absent. */
  orgId?: string | undefined;
}

/** One reason the permission is held, in words. */
function sourceText(t: Translate, source: GrantSource, resource: WhyCanIProps["resource"]): string {
  switch (source.kind) {
    case "orgRole":
      return t("admin.why.orgRole", { role: roleLabel(t, source.role, undefined) });
    case "customRole":
      return t("admin.why.customRole", { role: source.roleName });
    case "teamRole":
      return t("admin.why.teamRole", {
        team: source.teamName,
        role: isBuiltInRole(source.role) ? roleLabel(t, source.role, undefined) : source.roleName,
      });
    case "grant": {
      // A grant on the resource itself, or (for folders) on a folder above it.
      const onThis = resource !== undefined && source.resourceId === resource.id;
      return t(onThis ? "admin.why.grantHere" : "admin.why.grantAbove", {
        level: t(LEVEL_TEXT[source.level]),
        subject: t(`admin.why.subject.${source.subjectType}`),
        resource: t(RESOURCE_TEXT[source.resourceType]),
      });
    }
  }
}

// Space kept between the popover and the window edge.
const EDGE = 8;

/**
 * A small "Why?" button that opens a popover listing where a permission comes from: the
 * organization role, a custom role, a team's role or a grant (the explain route). It asks the
 * server only when opened. The popover is placed fixed to the window, so a dialog that scrolls
 * does not clip it.
 */
export function WhyCanI({ permission, resource, orgId }: WhyCanIProps) {
  const { t } = useI18n();
  const current = useCurrentOrg();
  const org = orgId ?? current?.id;
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
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

  // Below the button, kept inside the window; written to the element, as styles stay out of JSX.
  const place = useEffectEvent(() => {
    const button = buttonRef.current;
    const popover = popoverRef.current;
    if (button === null || popover === null) {
      return;
    }
    const anchor = button.getBoundingClientRect();
    const width = popover.offsetWidth;
    const height = popover.offsetHeight;
    const left = Math.max(EDGE, Math.min(anchor.right - width, window.innerWidth - width - EDGE));
    const below = anchor.bottom + EDGE / 2;
    const top =
      below + height > window.innerHeight - EDGE
        ? Math.max(EDGE, anchor.top - height - EDGE / 2)
        : below;
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
  });

  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  });

  const onOutsidePointer = useEffectEvent((event: PointerEvent) => {
    const target = event.target;
    if (
      target instanceof Node &&
      popoverRef.current?.contains(target) !== true &&
      buttonRef.current?.contains(target) !== true
    ) {
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
  const sources = explain.data?.sources ?? [];
  return (
    <span className="admin-why">
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
          ref={popoverRef}
          id={popoverId}
          role="dialog"
          aria-labelledby={titleId}
          className="admin-popover"
          // Focusable, so a click on its text keeps focus inside instead of closing it.
          tabIndex={-1}
          onBlur={(event) => {
            // Leaving the popover with Tab closes it, as a menu does.
            const next = event.relatedTarget;
            if (next instanceof Node && !event.currentTarget.contains(next)) {
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
          ) : sources.length === 0 ? (
            <p className="admin-popover__text">{t("admin.why.none")}</p>
          ) : (
            <ul className="admin-popover__list">
              {sources.map((source, index) => (
                // Sources have no id of their own; their order is the server's and stable.
                // biome-ignore lint/suspicious/noArrayIndexKey: see above.
                <li key={index}>{sourceText(t, source, resource)}</li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </span>
  );
}
