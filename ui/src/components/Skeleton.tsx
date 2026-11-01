import { useI18n } from "../i18n/i18n";

/**
 * Placeholders in the shape of content that is still loading: neutral bars with a quiet shimmer
 * (components.css, `.skeleton`), still for reduced motion. The region is announced once as
 * loading; the bars themselves are hidden from assistive technology.
 */
export function Skeleton({
  lines = 3,
  variant = "lines",
  className,
}: {
  /** How many bars a `lines` skeleton draws. */
  lines?: number;
  /** `lines`: text-like bars of varying length; `panel`: a chart area under a short bar. */
  variant?: "lines" | "panel";
  className?: string;
}) {
  const { t } = useI18n();
  const classes = ["skeleton-group", `skeleton-group--${variant}`, className]
    .filter((c) => c !== undefined)
    .join(" ");
  return (
    <div className={classes} role="status" aria-busy="true">
      <span className="visually-hidden">{t("common.loading")}</span>
      {variant === "panel" ? (
        <>
          <span className="skeleton skeleton-group__bar" aria-hidden="true" />
          <span className="skeleton skeleton-group__area" aria-hidden="true" />
        </>
      ) : (
        Array.from({ length: lines }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the bars never move
          <span key={i} className="skeleton skeleton-group__line" aria-hidden="true" />
        ))
      )}
    </div>
  );
}
