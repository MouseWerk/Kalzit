import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { Provisioned, ResourceKind } from "../../api/generated/shapes";
import { Icon } from "../../components/Icon";
import { type MessageKey, useI18n } from "../../i18n/i18n";
import { useEscapeLayer } from "../../lib/layers";
import { zoneOption } from "../../lib/timeSettings";
import { showToast } from "../../lib/toasts";
import { useCurrentOrg, useOrgPermissions } from "../../org/useOrg";
import { Dialog } from "../dashboards/ui/Dialog";
import { errorMessage } from "../dashboards/ui/errors";
import { PROVISIONING_KEY, unlockResource } from "./api";
import "./provisioning.css";

const KIND_TEXT: Record<ResourceKind, MessageKey> = {
  dashboard: "provisioning.managed.dashboard",
  datasource: "provisioning.managed.datasource",
  role: "provisioning.managed.role",
  alertRule: "provisioning.managed.alertRule",
};

/** What stays in the UI although the files own the resource. */
const OUTSIDE_TEXT: Record<ResourceKind, MessageKey> = {
  dashboard: "provisioning.outside.dashboard",
  datasource: "provisioning.outside.datasource",
  role: "provisioning.outside.role",
  alertRule: "provisioning.outside.alertRule",
};

function dateTime(ms: number, language: string, zone: string | null): string {
  return new Intl.DateTimeFormat(language, {
    dateStyle: "medium",
    timeStyle: "short",
    ...zoneOption(zone),
  }).format(ms);
}

/** The gap between the field and the window's edge, and between it and its badge, in pixels. */
const EDGE_PX = 8;
const GAP_PX = 4;

/**
 * Places the field under its badge, their left edges in line, inside the window: above the
 * badge when there is no room below, moved left when it would pass the right edge.
 */
function placeUnder(button: HTMLElement, field: HTMLElement): void {
  const box = button.getBoundingClientRect();
  const { width, height } = field.getBoundingClientRect();
  const viewWidth = document.documentElement.clientWidth || window.innerWidth;
  const viewHeight = document.documentElement.clientHeight || window.innerHeight;
  const below = box.bottom + GAP_PX;
  const top = below + height + EDGE_PX <= viewHeight ? below : box.top - GAP_PX - height;
  const left = Math.min(box.left, viewWidth - width - EDGE_PX);
  field.style.setProperty("--menu-top", `${Math.max(top, EDGE_PX)}px`);
  field.style.setProperty("--menu-left", `${Math.max(left, EDGE_PX)}px`);
}

/** The words of the badge: managed, unlocked until the next apply, or without its file. */
export function managedLabel(record: Provisioned): MessageKey {
  if (record.unlockedAt !== null) return "provisioning.badge.unlocked";
  return "provisioning.badge.managed";
}

/**
 * "Aus Dateien verwaltet" (board Provisioning.dc.html, frames 5 and 6): a quiet badge that opens
 * a field with the set, the file and the last apply, and for organization admins the way to
 * unlock the resource in an emergency. `compact` is the short word for a list row.
 */
export function ManagedBadge({
  record,
  name,
  compact,
}: {
  record: Provisioned;
  name: string;
  compact: boolean;
}) {
  const { t, language, timeZone } = useI18n();
  const permissions = useOrgPermissions();
  const popoverId = useId();
  const titleId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [unlocking, setUnlocking] = useState(false);

  function close() {
    setOpen(false);
    buttonRef.current?.focus();
  }
  useEscapeLayer(open, close);
  useLayoutEffect(() => {
    if (open && buttonRef.current !== null && popoverRef.current !== null) {
      placeUnder(buttonRef.current, popoverRef.current);
      popoverRef.current.focus();
    }
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        popoverRef.current?.contains(target) !== true &&
        buttonRef.current?.contains(target) !== true
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const unlocked = record.unlockedAt !== null;
  const label = compact
    ? t(unlocked ? "provisioning.badge.fileUnlocked" : "provisioning.badge.file")
    : t(managedLabel(record));
  return (
    <span className="managed">
      <button
        ref={buttonRef}
        type="button"
        className={compact ? "managed__badge managed__badge--compact" : "managed__badge"}
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <Icon name={unlocked ? "edit" : "file"} />
        <span>{label}</span>
      </button>
      {open ? (
        <div
          ref={popoverRef}
          id={popoverId}
          role="dialog"
          aria-labelledby={titleId}
          className="managed__popover"
          tabIndex={-1}
          onBlur={(event) => {
            const next = event.relatedTarget;
            if (next instanceof Node && !event.currentTarget.contains(next)) {
              setOpen(false);
            }
          }}
        >
          <h3 className="managed__title" id={titleId}>
            {t("provisioning.badge.managed")}
          </h3>
          <p className="managed__text">{t(KIND_TEXT[record.kind], { set: record.set })}</p>
          <code className="managed__path">{record.path}</code>
          <dl className="managed__facts">
            <div>
              <dt>{t("provisioning.fact.set")}</dt>
              <dd>{record.set}</dd>
            </div>
            <div>
              <dt>{t("provisioning.fact.applied")}</dt>
              <dd>{dateTime(record.appliedAt, language, timeZone)}</dd>
            </div>
            <div>
              <dt>{t("provisioning.fact.uid")}</dt>
              <dd>{record.uid}</dd>
            </div>
          </dl>
          {unlocked ? (
            <p className="managed__state">
              {t("provisioning.popover.unlocked", {
                date: dateTime(record.unlockedAt ?? 0, language, timeZone),
              })}
            </p>
          ) : record.drifted ? (
            <p className="managed__state">{t("provisioning.popover.drifted")}</p>
          ) : null}
          <div className="managed__actions">
            {!unlocked && permissions.has("provisioning:write") ? (
              <button
                type="button"
                className="button button--secondary button--small"
                onClick={() => {
                  setOpen(false);
                  setUnlocking(true);
                }}
              >
                {t("provisioning.unlock.button")}
              </button>
            ) : null}
            {permissions.has("provisioning:read") ? (
              <Link to="/admin/provisioning" className="button button--ghost button--small">
                {t("provisioning.popover.page")}
              </Link>
            ) : null}
          </div>
          <p className="managed__note">{t(OUTSIDE_TEXT[record.kind])}</p>
        </div>
      ) : null}
      {unlocking ? (
        <UnlockDialog record={record} name={name} onClose={() => setUnlocking(false)} />
      ) : null}
    </span>
  );
}

/**
 * Asks before an organization admin unlocks a managed resource (board frame 8): the change is
 * drift, and the next apply overwrites it. An `alertdialog`; focus starts on Cancel.
 */
export function UnlockDialog({
  record,
  name,
  onClose,
}: {
  record: Provisioned;
  name: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const org = useCurrentOrg();
  const queryClient = useQueryClient();
  const textId = useId();
  const unlock = useMutation({
    mutationFn: () => unlockResource(org?.id ?? "", record.kind, record.uid),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: [PROVISIONING_KEY] });
      showToast({ message: t("provisioning.unlock.done", { name }) });
      onClose();
    },
  });
  return (
    <Dialog
      alert
      title={t("provisioning.unlock.title", { name })}
      describedBy={textId}
      onClose={onClose}
      actions={
        <>
          <button
            type="button"
            className="button button--secondary"
            onClick={onClose}
            data-autofocus
          >
            {t("dashboards.dialog.cancel")}
          </button>
          <button
            type="button"
            className="button button--danger"
            disabled={unlock.isPending}
            onClick={() => unlock.mutate()}
          >
            {t("provisioning.unlock.confirm")}
          </button>
        </>
      }
    >
      <div id={textId} className="managed-unlock">
        <p>
          {t("provisioning.unlock.from")} <code className="managed__path">{record.path}</code>
        </p>
        <ul className="managed-unlock__list">
          <li>{t("provisioning.unlock.drift")}</li>
          <li>{t("provisioning.unlock.overwrite")}</li>
          <li>{t("provisioning.unlock.keep")}</li>
        </ul>
      </div>
      {unlock.isError ? (
        <p className="notice notice--danger" role="alert">
          {errorMessage(t, unlock.error)}
        </p>
      ) : null}
    </Dialog>
  );
}
