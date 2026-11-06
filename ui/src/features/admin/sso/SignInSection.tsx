import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { type KeyboardEvent, type ReactNode, useId, useState } from "react";
import { Icon } from "../../../components/Icon";
import { type MessageKey, useI18n } from "../../../i18n/i18n";
import { fetchOverview, type Requirement, securityKeys } from "../../security/api";
import { SectionActions } from "../../settings/SectionActions";
import { LoadState } from "../components/Section";
import { fetchLocalSignIn, fetchMappings, fetchSignInOverview, ssoKeys } from "./api";
import { LocalTab } from "./LocalTab";
import { MappingsTab } from "./MappingsTab";
import { ProvidersTab } from "./ProvidersTab";
import "./sso.css";

export const SIGN_IN_TABS = ["providers", "mappings", "local"] as const;
export type SignInTab = (typeof SIGN_IN_TABS)[number];

const TAB_LABEL: Record<SignInTab, MessageKey> = {
  providers: "sso.tab.providers",
  mappings: "sso.tab.mappings",
  local: "sso.tab.local",
};

/** The server's rule for the second factor, under its share in the strip. */
const REQUIRED_LABEL: Record<Requirement, MessageKey> = {
  off: "sso.strip.requiredOff",
  admins: "sso.strip.requiredAdmins",
  everyone: "sso.strip.requiredEveryone",
};

/** Setting rows of the tabs, so a search result (`#signin.password_form`) opens the right one. */
const ROW_TAB: Record<string, SignInTab> = {
  "signin.unmapped": "mappings",
  "signin.default_org": "mappings",
  "signin.default_role": "mappings",
  "signin.local_password": "local",
  "signin.password_form": "local",
  "signin.break_glass_user": "local",
  "security.two_factor_required": "local",
  "security.two_factor_methods": "local",
};

function tabOf(hash: string): SignInTab {
  const name = decodeURIComponent(hash.replace(/^#/, ""));
  const row = ROW_TAB[name];
  if (row !== undefined) {
    return row;
  }
  return (SIGN_IN_TABS as readonly string[]).includes(name) ? (name as SignInTab) : "providers";
}

/**
 * Verwaltung > Anmeldung (board docs/design/blueprint/Identity.dc.html, frames 5A to 5G): how
 * people sign in. The identity providers with their place on the sign-in page, the mapping of
 * their groups to organizations, teams and roles, and the local password sign-in, as tabs with
 * their own address (`#mappings`, `#local`). The provider form has one explicit Save after a
 * connection check; everything else applies at once with undo.
 */
export function SignInSection({ twoFactor }: { twoFactor?: ReactNode }) {
  const { t } = useI18n();
  const { hash } = useLocation();
  const navigate = useNavigate();
  const tabsId = useId();
  const tab = tabOf(hash);
  const overview = useQuery({ queryKey: ssoKeys.overview, queryFn: fetchSignInOverview });
  const mappings = useQuery({ queryKey: ssoKeys.mappings, queryFn: fetchMappings });
  const local = useQuery({ queryKey: ssoKeys.local, queryFn: fetchLocalSignIn });
  const twoFactorOverview = useQuery({ queryKey: securityKeys.overview, queryFn: fetchOverview });
  const [adding, setAdding] = useState<"provider" | "mapping" | null>(null);

  function choose(next: SignInTab) {
    void navigate({
      to: "/settings/$section",
      params: { section: "signin" },
      hash: next === "providers" ? "" : next,
      replace: true,
    });
  }

  function onTabKey(event: KeyboardEvent<HTMLDivElement>) {
    const index = SIGN_IN_TABS.indexOf(tab);
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) {
      return;
    }
    event.preventDefault();
    const next = SIGN_IN_TABS[(index + step + SIGN_IN_TABS.length) % SIGN_IN_TABS.length] ?? tab;
    choose(next);
    document.getElementById(`${tabsId}-${next}-tab`)?.focus();
  }

  if (overview.data === undefined) {
    return <LoadState error={overview.error} onRetry={() => void overview.refetch()} />;
  }
  const data = overview.data;
  const active = data.providers.filter((provider) => provider.enabled).length;
  const counts: Record<SignInTab, number | null> = {
    providers: data.providers.length,
    mappings: mappings.data?.mappings.length ?? null,
    local: null,
  };

  const factor = twoFactorOverview.data;
  const share =
    factor?.accounts === undefined || factor.withFactor === undefined || factor.accounts === 0
      ? null
      : Math.round((factor.withFactor / factor.accounts) * 100);

  return (
    <div className="sso">
      <SectionActions>
        {tab === "mappings" ? (
          <button
            type="button"
            className="button button--primary"
            aria-disabled={data.providers.length === 0}
            onClick={() => {
              if (data.providers.length > 0) {
                setAdding("mapping");
              }
            }}
          >
            <Icon name="plus" />
            {t("sso.mappings.add")}
          </button>
        ) : (
          <button
            type="button"
            className="button button--primary"
            onClick={() => {
              if (tab !== "providers") {
                choose("providers");
              }
              setAdding("provider");
            }}
          >
            <Icon name="plus" />
            {t("sso.providers.add")}
          </button>
        )}
      </SectionActions>
      <div className="tabs" role="tablist" aria-label={t("sso.tabs")} onKeyDown={onTabKey}>
        {SIGN_IN_TABS.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            id={`${tabsId}-${name}-tab`}
            className="tabs__tab"
            aria-selected={tab === name}
            aria-controls={`${tabsId}-${name}`}
            tabIndex={tab === name ? 0 : -1}
            onClick={() => choose(name)}
          >
            {t(TAB_LABEL[name])}
            {counts[name] === null ? null : <span className="sso__count">{counts[name]}</span>}
          </button>
        ))}
      </div>
      {tab === "providers" ? (
        <dl className="sso-strip">
          <div className="sso-strip__cell">
            <dt className="sso-strip__label">{t("sso.strip.providers")}</dt>
            <dd className="sso-strip__value">{data.providers.length}</dd>
            <dd className="sso-strip__sub">{t("sso.strip.providersActive", { count: active })}</dd>
          </div>
          <div className="sso-strip__cell">
            <dt className="sso-strip__label">{t("sso.strip.people")}</dt>
            <dd className="sso-strip__value">{data.viaProviders}</dd>
            <dd className="sso-strip__sub">
              {t("sso.strip.peopleOf", { accounts: data.accounts })}
            </dd>
          </div>
          <div className="sso-strip__cell">
            <dt className="sso-strip__label">{t("sso.strip.factor")}</dt>
            <dd className="sso-strip__value">
              {share === null ? "–" : t("sso.strip.factorShare", { percent: share })}
            </dd>
            <dd className="sso-strip__sub">
              {factor === undefined ? "–" : t(REQUIRED_LABEL[factor.server])}
            </dd>
          </div>
          <div className="sso-strip__cell">
            <dt className="sso-strip__label">{t("sso.strip.local")}</dt>
            <dd className="sso-strip__value">
              {local.data === undefined
                ? "–"
                : t(local.data.localPassword === "on" ? "sso.strip.localOn" : "sso.strip.localOff")}
            </dd>
            <dd className="sso-strip__sub">
              {local.data?.breakGlass === null || local.data === undefined
                ? t("sso.strip.noBreakGlass")
                : t("sso.strip.breakGlass", { name: local.data.breakGlass.name })}
            </dd>
          </div>
        </dl>
      ) : null}
      {/* A stack, so a tab's cards and the note under them keep the gap between them. */}
      <div
        role="tabpanel"
        className="sso-stack"
        id={`${tabsId}-${tab}`}
        aria-labelledby={`${tabsId}-${tab}-tab`}
      >
        {tab === "providers" ? (
          <ProvidersTab
            overview={data}
            adding={adding === "provider"}
            onAdded={() => setAdding(null)}
          />
        ) : tab === "mappings" ? (
          <MappingsTab
            providers={data.providers}
            mappings={mappings}
            adding={adding === "mapping"}
            onAdded={() => setAdding(null)}
          />
        ) : (
          <>
            <LocalTab local={local} />
            {twoFactor}
          </>
        )}
      </div>
    </div>
  );
}
