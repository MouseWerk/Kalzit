import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useId, useRef, useState } from "react";
import { isApiError } from "../../api/client";
import { brandingQuery } from "../../appearance/api";
import { logoUrlFor } from "../../appearance/brand";
import { isAccentName } from "../../appearance/contrast";
import { LimitedMarkdown } from "../../appearance/LimitedMarkdown";
import { applyLook, lookFrom } from "../../appearance/look";
import { useI18n } from "../../i18n/i18n";
import { preferencesQuery } from "../../preferences/preferences";
import type { Setting } from "../admin/api";
import { Dialog } from "../admin/components/Dialog";
import { useNotice } from "../admin/components/Notice";
import { ConflictDialog } from "../admin/components/Settings";
import { errorText } from "../admin/errors";
import {
  applyBatch,
  fileToBase64,
  LOGO_TYPES,
  MAX_LOGO_BYTES,
  removeLogo,
  restoreLogo,
  undoChange,
  uploadLogo,
} from "./api";
import { type Changes, contrastText, lockHint, RowFrame, SettingRow } from "./rows";
import { useFoundRow } from "./SectionPage";
import { APPEARANCE_ROWS, LOGO_ROW, SIGN_IN_ROW } from "./sections";
import "../../appearance/appearance.css";
import "./settings.css";

const appRoute = getRouteApi("/_app");

/**
 * "Appearance and brand": theme, accent, logo and name, density, font size, language and the
 * sign-in page, with a live preview of the look in light and dark beside the card.
 */
export function AppearanceSection({
  settings,
  changes,
}: {
  settings: readonly Setting[];
  changes: Changes;
}) {
  const found = useFoundRow();
  const byKey = new Map(settings.map((setting) => [setting.key, setting]));
  const value = (key: string) => byKey.get(key)?.value;
  return (
    <div className="settings-appearance">
      <div className="settings-card">
        {APPEARANCE_ROWS.map((row) => {
          if (row === LOGO_ROW) {
            return <LogoRow key={row} found={found === row} />;
          }
          if (row === SIGN_IN_ROW) {
            const welcome = byKey.get("signin.welcome");
            const notice = byKey.get("signin.notice");
            return welcome === undefined || notice === undefined ? null : (
              <SignInRow key={row} welcome={welcome} notice={notice} found={found === row} />
            );
          }
          const setting = byKey.get(row);
          return setting === undefined ? null : (
            <SettingRow
              key={row}
              setting={setting}
              note={row === "appearance.default_theme" ? <OwnThemeNote /> : undefined}
              rowId={row}
              changes={changes}
              canWrite
              inheritable={false}
              found={found === row}
            />
          );
        })}
        <ConflictDialog
          conflict={changes.conflict}
          onKeepStored={changes.keepStored}
          onOverwrite={changes.overwrite}
        />
      </div>
      <LookPreview
        accent={value("appearance.accent")}
        density={value("appearance.density")}
        fontSize={value("appearance.font_size")}
      />
    </div>
  );
}

/**
 * A theme chosen in the profile wins over the default, so changing the default does nothing for
 * its owner; this says so instead of letting the control seem broken.
 */
function OwnThemeNote() {
  const { t } = useI18n();
  const { me } = appRoute.useRouteContext();
  const preferences = useQuery(preferencesQuery(me.id));
  if (preferences.data?.theme == null) {
    return null;
  }
  return (
    <>
      {t("settings.theme.own")} (
      <Link to="/settings/$section" params={{ section: "profile" }}>
        {t("settings.theme.ownLink")}
      </Link>
      ). {t("settings.theme.ownHint")}
    </>
  );
}

function LookPreview({
  accent,
  density,
  fontSize,
}: {
  accent: unknown;
  density: unknown;
  fontSize: unknown;
}) {
  const { t, language } = useI18n();
  const look = lookFrom({ accent, density, fontSize });
  const apply = (element: HTMLElement | null) => {
    if (element !== null) {
      applyLook(element, look);
    }
  };
  return (
    <aside className="settings-preview" aria-label={t("settings.preview.label")}>
      <h3 className="settings-preview__title">{t("settings.preview.title")}</h3>
      <div
        key={`${look.accent}-${look.density}`}
        className="look-preview"
        ref={apply}
        aria-hidden="true"
      >
        <div className="look-preview__rail">
          <span className="look-preview__bar look-preview__bar--strong" />
          <span className="look-preview__bar" />
          <span className="look-preview__bar" />
        </div>
        <div className="look-preview__main">
          <span className="look-preview__heading" />
          <div className="look-preview__card">
            <span className="look-preview__link">{t("settings.preview.link")}</span>
          </div>
          <span className="look-preview__button">{t("settings.preview.button")}</span>
        </div>
      </div>
      <p className="settings-hint">
        {isAccentName(look.accent)
          ? t("settings.preview.vetted")
          : contrastText(t, language, look.accent, "settings.preview.contrast")}
      </p>
    </aside>
  );
}

function LogoRow({ found }: { found: boolean }) {
  const { t } = useI18n();
  const titleId = useId();
  const queryClient = useQueryClient();
  const branding = useQuery(brandingQuery);
  const notice = useNotice();
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const logo = branding.data?.logo ?? null;

  /** The server keeps the logo before the last change; undo swaps it back. */
  function undoLogo() {
    void restoreLogo().then(
      async () => {
        await queryClient.invalidateQueries({ queryKey: brandingQuery.queryKey });
        notice.show({ message: t("settings.logo.restored") });
      },
      (failure: unknown) => notice.showError(errorText(t, failure)),
    );
  }

  async function choose(file: File) {
    setError(undefined);
    if (!(LOGO_TYPES as readonly string[]).includes(file.type)) {
      setError(t("settings.logo.wrongType"));
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setError(t("settings.logo.tooLarge"));
      return;
    }
    setBusy(true);
    try {
      await uploadLogo(file.type, await fileToBase64(file));
      await queryClient.invalidateQueries({ queryKey: brandingQuery.queryKey });
      notice.show({ message: t("settings.logo.saved"), undo: undoLogo });
    } catch (failure) {
      setError(errorText(t, failure));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await removeLogo();
      await queryClient.invalidateQueries({ queryKey: brandingQuery.queryKey });
      notice.show({ message: t("settings.logo.removed"), undo: undoLogo });
    } catch (failure) {
      if (!isApiError(failure, "not_found")) {
        setError(errorText(t, failure));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <RowFrame
      id={LOGO_ROW}
      title={t("settings.logo.label")}
      titleId={titleId}
      description={t("settings.logo.description")}
      error={error}
      found={found}
    >
      <div className="settings-logo">
        {logo === null ? null : (
          <span className="settings-logo__tile">
            <img
              className="brand-mark__img"
              src={logoUrlFor(logo.sha256)}
              alt={t("settings.logo.current")}
            />
          </span>
        )}
        <input
          ref={input}
          type="file"
          accept={LOGO_TYPES.join(",")}
          hidden
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file !== undefined) {
              void choose(file);
            }
          }}
        />
        <button
          type="button"
          className="button button--secondary"
          aria-disabled={busy}
          onClick={() => {
            if (!busy) {
              input.current?.click();
            }
          }}
        >
          {t(logo === null ? "settings.logo.upload" : "settings.logo.replace")}
        </button>
        {logo === null ? null : (
          <button
            type="button"
            className="button button--ghost"
            aria-disabled={busy}
            onClick={() => {
              if (!busy) {
                void remove();
              }
            }}
          >
            {t("settings.logo.remove")}
          </button>
        )}
      </div>
    </RowFrame>
  );
}

/** The welcome text and notice, edited together in a dialog and saved as one change with undo. */
function SignInRow({
  welcome,
  notice,
  found,
}: {
  welcome: Setting;
  notice: Setting;
  found: boolean;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const lock = lockHint(t, welcome) ?? lockHint(t, notice);
  const locked = lock !== undefined;
  const summary = [welcome.value, notice.value].some((value) => String(value ?? "").trim() !== "")
    ? null
    : t("settings.signInPage.empty");
  return (
    <RowFrame
      id={SIGN_IN_ROW}
      title={t("settings.signInPage.label")}
      titleId={titleId}
      description={summary ?? t("settings.signInPage.description")}
      badge={locked ? t("settings.locked.short") : undefined}
      lock={lock}
      found={found}
    >
      {/* Texts set in kalzit.toml or the environment keep the button, turned off. */}
      <button
        type="button"
        className="button button--secondary"
        aria-describedby={locked ? `${titleId} ${titleId}-lock` : titleId}
        disabled={locked}
        onClick={() => setOpen(true)}
      >
        {t("settings.signInPage.edit")}
      </button>
      {open ? (
        <SignInDialog welcome={welcome} notice={notice} onClose={() => setOpen(false)} />
      ) : null}
    </RowFrame>
  );
}

function SignInDialog({
  welcome,
  notice,
  onClose,
}: {
  welcome: Setting;
  notice: Setting;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const queryClient = useQueryClient();
  const toast = useNotice();
  const [welcomeText, setWelcomeText] = useState(String(welcome.value ?? ""));
  const [noticeText, setNoticeText] = useState(String(notice.value ?? ""));
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["admin", "server", "settings"] });
    await queryClient.invalidateQueries({ queryKey: brandingQuery.queryKey });
  }

  async function save() {
    const changes = [
      { setting: welcome, value: welcomeText },
      { setting: notice, value: noticeText },
    ].filter(({ setting, value }) => value !== setting.value);
    if (changes.length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    try {
      const saved = await applyBatch(
        { kind: "server" },
        changes.map(({ setting, value }) => ({
          key: setting.key,
          value,
          version: setting.version,
        })),
      );
      await refresh();
      onClose();
      toast.show({
        message: t("settings.signInPage.saved"),
        undo: () => {
          void applyBatch(
            { kind: "server" },
            saved.map((setting) => {
              const before = changes.find((change) => change.setting.key === setting.key)?.setting;
              return undoChange(
                setting.key,
                { value: before?.value, source: before?.source },
                setting.version,
              );
            }),
          ).then(refresh, (failure: unknown) => toast.showError(errorText(t, failure)));
        },
      });
    } catch (failure) {
      setError(errorText(t, failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      wide
      title={t("settings.signInPage.title")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button button--secondary" onClick={onClose}>
            {t("settings.transfer.cancel")}
          </button>
          <button
            type="button"
            className="button button--primary"
            aria-disabled={busy}
            onClick={() => {
              if (!busy) {
                void save();
              }
            }}
          >
            {t("settings.signInPage.save")}
          </button>
        </>
      }
    >
      <div className="settings-signin">
        <p className="settings-hint">{t("settings.signInPage.markdown")}</p>
        <label className="field" htmlFor={`${id}-welcome`}>
          <span className="field__label">{t("settings.signInPage.welcome")}</span>
          <textarea
            id={`${id}-welcome`}
            className="input settings-textarea"
            rows={3}
            maxLength={280}
            value={welcomeText}
            aria-describedby={`${id}-welcome-hint`}
            onChange={(event) => setWelcomeText(event.currentTarget.value)}
          />
          <span className="settings-hint" id={`${id}-welcome-hint`}>
            {t("settings.signInPage.welcomeHint")}
          </span>
        </label>
        <label className="field" htmlFor={`${id}-notice`}>
          <span className="field__label">{t("settings.signInPage.notice")}</span>
          <textarea
            id={`${id}-notice`}
            className="input settings-textarea"
            rows={5}
            maxLength={2000}
            value={noticeText}
            aria-describedby={`${id}-notice-hint`}
            onChange={(event) => setNoticeText(event.currentTarget.value)}
          />
          <span className="settings-hint" id={`${id}-notice-hint`}>
            {t("settings.signInPage.noticeHint")}
          </span>
        </label>
        {error === undefined ? null : (
          <p className="field__error" role="alert">
            {error}
          </p>
        )}
        {welcomeText.trim() === "" && noticeText.trim() === "" ? null : (
          <div className="settings-signin__preview">
            <h3 className="settings-preview__title">{t("settings.signInPage.preview")}</h3>
            {welcomeText.trim() === "" ? null : (
              <LimitedMarkdown text={welcomeText} className="limited-markdown settings-hint" />
            )}
            {noticeText.trim() === "" ? null : (
              <div className="notice">
                <LimitedMarkdown text={noticeText} className="limited-markdown" />
              </div>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
