import { useId } from "react";
import { isRecord } from "../../api/client";
import { useI18n } from "../../i18n/i18n";
import { TextPreview } from "../picker/previews";
import { SelectField } from "../shared";
import type { PanelEditorProps, PanelPlugin, PanelProps } from "../types";
import { interpolate, markdown } from "./markdown";
import "../viz.css";

export const TEXT_MODES = ["markdown", "plain"] as const;
/** Longest text a panel stores (server: `MAX_TEXT_CHARS`). */
export const MAX_TEXT_CHARS = 20_000;

export interface TextOptions {
  mode: (typeof TEXT_MODES)[number];
  content: string;
}

function parseOptions(stored: unknown): TextOptions {
  const value = isRecord(stored) ? stored : {};
  return {
    mode: TEXT_MODES.find((m) => m === value.mode) ?? "markdown",
    content: typeof value.content === "string" ? value.content.slice(0, MAX_TEXT_CHARS) : "",
  };
}

/** Text or Markdown with dashboard variables filled in; never raw HTML. */
function TextPanel({ options, title, variables = {} }: PanelProps<TextOptions>) {
  const { t } = useI18n();
  const content = interpolate(options.content, variables);
  if (content.trim() === "") {
    return <p className="panel-empty">{t("panels.text.empty")}</p>;
  }
  return (
    <section className="text-panel" aria-label={title}>
      {options.mode === "plain" ? (
        <p className="text-panel__plain">{content}</p>
      ) : (
        markdown(content)
      )}
    </section>
  );
}

function TextEditor({ options, onChange }: PanelEditorProps<TextOptions>) {
  const { t } = useI18n();
  const id = useId();
  return (
    <>
      <SelectField
        id={`${id}-mode`}
        label={t("panels.text.mode")}
        value={options.mode}
        choices={TEXT_MODES.map((m) => [m, t(`panels.text.mode.${m}`)])}
        onChange={(mode) => onChange({ ...options, mode })}
      />
      <div className="field">
        <label className="field__label" htmlFor={`${id}-content`}>
          {t("panels.text.content")}
        </label>
        <p className="field__hint" id={`${id}-hint`}>
          {t("panels.text.contentHint")}
        </p>
        <textarea
          id={`${id}-content`}
          className="input input--mono text-panel__editor"
          value={options.content}
          maxLength={MAX_TEXT_CHARS}
          aria-describedby={`${id}-hint`}
          onChange={(event) => onChange({ ...options, content: event.currentTarget.value })}
        />
      </div>
    </>
  );
}

export const textPanel: PanelPlugin<TextOptions> = {
  type: "text",
  name: "panels.type.text",
  description: "panels.describe.text",
  shapes: [],
  standalone: true,
  options: parseOptions,
  Panel: TextPanel,
  Editor: TextEditor,
  Preview: TextPreview,
};
