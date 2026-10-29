import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useDeferredValue, useId, useState } from "react";
import { type MessageKey, useI18n } from "../../i18n/i18n";
import { getAbout, getLicenses, type LicenseEntry } from "./api";
import { CalciteCrystal } from "./CalciteCrystal";
import { normalize } from "./search";
import "./settings.css";

export const REPOSITORY_URL = "https://github.com/MouseWerk/Kalzit";
export const WEBSITE_URL = "https://kalzit.dev";
export const SECURITY_URL = `${REPOSITORY_URL}/blob/main/SECURITY.md`;
export const LICENSE_TEXT_URL = "https://www.gnu.org/licenses/agpl-3.0.html";
/** The license texts of the shipped packages, written into the bundle by the build. */
export const NOTICES_URL = "/THIRD-PARTY-NOTICES.txt";
/** What the license list says for a package that has a license file instead of an expression. */
const SEE_FILE = "SEE LICENSE FILE";

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  const { t } = useI18n();
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="about-link">
      {children}
      <span className="visually-hidden"> ({t("settings.about.newTab")})</span>
    </a>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="settings-card settings-card--padded about-card" aria-labelledby={id}>
      <h3 id={id} className="about-card__title">
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * Settings, About: what Kalzit is, which build this is, who makes it, under which license it
 * runs, and the licenses of the software it ships with. Every signed-in user may read it.
 */
export function AboutSection() {
  const { t } = useI18n();
  return (
    <div className="about">
      <div className="settings-card about-hero">
        <div className="about-hero__art">
          <CalciteCrystal />
        </div>
        <div className="about-hero__text">
          <p className="about-hero__name">{t("app.name")}</p>
          <p className="about-hero__tagline">{t("settings.about.tagline")}</p>
          <p className="about-hero__meaning">{t("settings.about.meaning")}</p>
        </div>
      </div>
      <ProductCard />
      <Card title={t("settings.about.company")}>
        <p className="about-text">{t("settings.about.companyText")}</p>
        <ul className="about-links">
          <li>
            <ExternalLink href={REPOSITORY_URL}>{t("settings.about.repository")}</ExternalLink>
          </li>
          <li>
            <ExternalLink href={WEBSITE_URL}>{t("settings.about.website")}</ExternalLink>
          </li>
          <li>
            <ExternalLink href={SECURITY_URL}>{t("settings.about.security")}</ExternalLink>
          </li>
        </ul>
      </Card>
      <Card title={t("settings.about.license")}>
        <p className="about-license__name">{t("settings.about.licenseName")}</p>
        <p className="about-text">{t("settings.about.licenseNote")}</p>
        <ul className="about-links">
          <li>
            <ExternalLink href={LICENSE_TEXT_URL}>{t("settings.about.licenseText")}</ExternalLink>
          </li>
          <li>
            <ExternalLink href={REPOSITORY_URL}>{t("settings.about.sourceCode")}</ExternalLink>
          </li>
        </ul>
        <h4 className="about-card__subtitle">{t("settings.about.cleanRoom")}</h4>
        <p className="about-text">{t("settings.about.cleanRoomText")}</p>
      </Card>
      <ThirdParty />
    </div>
  );
}

const DATABASE_LABEL: Record<"sqlite" | "postgres", MessageKey> = {
  sqlite: "settings.about.database.sqlite",
  postgres: "settings.about.database.postgres",
};

const PLATFORM_LABEL: Record<string, string> = {
  windows: "Windows",
  linux: "Linux",
  macos: "macOS",
};

/** The texts of the configuration warnings the server reports (docs/api/shell.md, "About"). */
const CONFIG_WARNING: Record<string, MessageKey> = {
  "config.database_password_in_file": "settings.about.warning.databasePasswordInFile",
};

function ProductCard() {
  const { t } = useI18n();
  const about = useQuery({ queryKey: ["about"], queryFn: getAbout, staleTime: Infinity });
  const data = about.data;
  const unknown = t("settings.about.unknown");
  return (
    <Card title={t("settings.about.product")}>
      {about.isError ? (
        <p className="about-text" role="alert">
          {t("settings.about.loadError")}
        </p>
      ) : (
        <dl className="about-facts">
          <Fact term={t("settings.about.name")} value={t("app.name")} />
          <Fact term={t("settings.about.version")} value={data?.version ?? ""} />
          {data === undefined || data.commit !== undefined ? (
            <Fact
              term={t("settings.about.commit")}
              value={data?.commit === "unknown" ? unknown : (data?.commit ?? "")}
              mono
            />
          ) : null}
          <Fact term={t("settings.about.built")} value={data?.buildDate ?? ""} />
          {data?.platform === undefined ? null : (
            <Fact
              term={t("settings.about.platform")}
              value={`${PLATFORM_LABEL[data.platform] ?? data.platform} ${data.arch ?? ""}`.trim()}
            />
          )}
          {data?.database === undefined ? null : (
            <Fact term={t("settings.about.database")} value={t(DATABASE_LABEL[data.database])} />
          )}
        </dl>
      )}
      {(data?.configWarnings ?? [])
        .filter((code) => code in CONFIG_WARNING)
        .map((code) => (
          <p key={code} className="about-text" role="note">
            {t(CONFIG_WARNING[code] as MessageKey)}
          </p>
        ))}
    </Card>
  );
}

function Fact({ term, value, mono }: { term: string; value: string; mono?: boolean }) {
  return (
    <div className="about-facts__row">
      <dt>{term}</dt>
      <dd className={mono === true ? "about-facts__mono" : undefined}>{value}</dd>
    </div>
  );
}

/** Entries whose name or license contains every word of the query. */
export function filterLicenses(
  entries: readonly LicenseEntry[],
  query: string,
): readonly LicenseEntry[] {
  const words = normalize(query)
    .split(/\s+/)
    .filter((word) => word !== "");
  if (words.length === 0) {
    return entries;
  }
  return entries.filter((entry) => {
    const text = normalize(`${entry.name} ${entry.license} ${entry.version}`);
    return words.every((word) => text.includes(word));
  });
}

function ThirdParty() {
  const { t } = useI18n();
  const id = useId();
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query);
  const licenses = useQuery({
    queryKey: ["third-party-licenses"],
    queryFn: getLicenses,
    staleTime: Infinity,
    retry: false,
  });
  const all = licenses.data;
  const shown = all === undefined ? [] : filterLicenses(all, deferred);
  return (
    <Card title={t("settings.about.thirdParty")}>
      <p className="about-text">{t("settings.about.thirdPartyLead")}</p>
      <p className="about-text">
        <ExternalLink href={NOTICES_URL}>{t("settings.about.notices")}</ExternalLink>
      </p>
      {licenses.isError ? (
        <p className="about-text" role="status">
          {t("settings.about.licensesMissing")}
        </p>
      ) : all === undefined ? null : (
        <>
          <div className="about-licenses__bar">
            <label className="about-licenses__search" htmlFor={`${id}-search`}>
              <span className="visually-hidden">{t("settings.about.licenseSearch")}</span>
              <input
                id={`${id}-search`}
                type="search"
                className="input"
                placeholder={t("settings.about.licenseSearchPlaceholder")}
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
            </label>
            <p className="about-licenses__count" role="status">
              {t("settings.about.licenseCount", { shown: shown.length, total: all.length })}
            </p>
          </div>
          {shown.length === 0 ? (
            <p className="about-text">
              {t("settings.about.licenseNone", { query: deferred.trim() })}
            </p>
          ) : (
            <section
              className="about-licenses__scroll"
              aria-label={t("settings.about.licenseList")}
              // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling list must be reachable by keyboard
              tabIndex={0}
            >
              <table className="about-licenses__table">
                <thead>
                  <tr>
                    <th scope="col" className="about-licenses__head">
                      {t("settings.about.colName")}
                    </th>
                    <th scope="col" className="about-licenses__head">
                      {t("settings.about.colVersion")}
                    </th>
                    <th scope="col" className="about-licenses__head">
                      {t("settings.about.colLicense")}
                    </th>
                    <th scope="col" className="about-licenses__head">
                      {t("settings.about.colSource")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((entry) => (
                    <tr key={`${entry.source}:${entry.name}@${entry.version}`}>
                      <th scope="row" className="about-licenses__cell about-licenses__name">
                        {entry.name}
                      </th>
                      <td className="about-licenses__cell">{entry.version}</td>
                      <td className="about-licenses__cell">
                        {entry.license === SEE_FILE
                          ? t("settings.about.licenseFile")
                          : entry.license}
                      </td>
                      <td className="about-licenses__cell">
                        {entry.source === "rust"
                          ? t("settings.about.sourceRust")
                          : t("settings.about.sourceNpm")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}
    </Card>
  );
}
