import { useI18n } from "../../../i18n/i18n";
import { LoadState } from "./Section";
import "../admin.css";

export interface PickerOption {
  id: string;
  label: string;
}

/**
 * A select over a list the server hands out page by page (people, teams, organizations). The
 * server has no search on these lists, so beyond the first page (200 entries) "Show more" loads
 * the next one into the same select.
 */
export function PagedSelect({
  id,
  value,
  onChange,
  options,
  error,
  onRetry,
  hasMore,
  onMore,
  loadingMore,
  anyLabel,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  /** Undefined while the first page loads. */
  options: readonly PickerOption[] | undefined;
  error: unknown;
  onRetry: () => void;
  hasMore: boolean;
  onMore: () => void;
  loadingMore: boolean;
  /** An empty first option ("Anyone"), for filters. */
  anyLabel?: string;
}) {
  const { t } = useI18n();
  if (options === undefined) {
    return <LoadState error={error} onRetry={onRetry} />;
  }
  return (
    <div className="admin-picker">
      <select
        id={id}
        className="select"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        {anyLabel === undefined ? null : <option value="">{anyLabel}</option>}
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
      {hasMore ? (
        <button
          type="button"
          className="admin-link-button"
          aria-disabled={loadingMore}
          onClick={() => {
            if (!loadingMore) {
              onMore();
            }
          }}
        >
          {t("admin.common.showMore")}
        </button>
      ) : null}
    </div>
  );
}
