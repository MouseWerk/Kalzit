import { Fragment } from "react";
import { Icon, type IconName } from "../components/Icon";
import { useI18n } from "../i18n/i18n";
import { type Binding, isArrow, isModifier, keyName, orderKeys, type Platform } from "./keyNames";
import { bindingsOf, currentPlatform, shortcutSpoken } from "./registry";
import "../shell/shellUx.css";

const ARROW_ICON: Record<string, IconName> = {
  ArrowLeft: "arrowLeft",
  ArrowRight: "arrowRight",
  ArrowUp: "arrowUp",
  ArrowDown: "arrowDown",
};

interface KeysProps {
  /** The shortcut of the registry to draw. */
  id: string;
  /**
   * Whether the keys are read out (the help's rows): each key by its written-out name, never
   * the sign. Elsewhere they are decorative, and the control says its keys through
   * `aria-keyshortcuts` or its name.
   */
  announce?: boolean | undefined;
  className?: string | undefined;
}

/**
 * A shortcut's keys as key caps, the same everywhere: in the help, tooltips, menus, the palette
 * and hints. Keys pressed together are joined by a quiet "+" (on a Mac the signs ⌃ ⌥ ⇧ ⌘ stand
 * right before the key, as in its menus), keys one after the other by "then", alternatives by
 * "or". The names follow the language and platform (keys.ts).
 */
export function Keys({ id, announce = false, className }: KeysProps) {
  const { t, language } = useI18n();
  const platform = currentPlatform();
  const bindings = bindingsOf(id, platform);
  const shown = (
    <span className="keys__caps" aria-hidden="true">
      {bindings.map((binding, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the bindings are a fixed list
        <Fragment key={index}>
          {index === 0 ? null : <span className="keys__word">{t("shortcuts.or")}</span>}
          <BindingCaps binding={binding} platform={platform} then={t("shortcuts.then")} />
        </Fragment>
      ))}
    </span>
  );
  return (
    <span className={className === undefined ? "keys" : `keys ${className}`}>
      {shown}
      {announce ? <span className="visually-hidden">{shortcutSpoken(id, language)}</span> : null}
    </span>
  );
}

function BindingCaps({
  binding,
  platform,
  then,
}: {
  binding: Binding;
  platform: Platform;
  then: string;
}) {
  if (binding.kind === "sequence") {
    return (
      <span className="keys__group">
        {binding.steps.map((key, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: steps may repeat, positions do not
          <Fragment key={index}>
            {index === 0 ? null : <span className="keys__word">{then}</span>}
            <Cap name={key} platform={platform} />
          </Fragment>
        ))}
      </span>
    );
  }
  const mods = orderKeys(binding.kind === "set" ? binding.mods : binding.keys, platform).filter(
    isModifier,
  );
  const mains =
    binding.kind === "set" ? binding.keys : binding.keys.filter((key) => !isModifier(key));
  const plus = platform === "mac" ? null : <span className="keys__plus">+</span>;
  return (
    <span className={platform === "mac" ? "keys__group keys__group--tight" : "keys__group"}>
      {mods.map((key) => (
        <Fragment key={key}>
          <Cap name={key} platform={platform} />
          {plus}
        </Fragment>
      ))}
      {mains.map((key) => (
        <Cap key={key} name={key} platform={platform} />
      ))}
    </span>
  );
}

/** One key cap: its name, or a drawn arrow. */
function Cap({ name, platform }: { name: string; platform: Platform }) {
  const { language } = useI18n();
  if (isArrow(name)) {
    return (
      <kbd className="kbd">
        <Icon name={ARROW_ICON[name] ?? "arrowRight"} className="kbd__arrow" />
      </kbd>
    );
  }
  return <kbd className="kbd">{keyName(name, language, platform).text}</kbd>;
}

/** What a catalog text holds where the keys go: `t("explore.hint", { keys: KEYS_SLOT })`. */
export const KEYS_SLOT = "\u0000keys\u0000";

/**
 * A sentence with a shortcut in it ("{keys} runs the query"): the text from the catalog with
 * `KEYS_SLOT` in place of the keys, which are drawn as caps and read by their names. The keys
 * never stand in the catalog text itself.
 */
export function KeysInText({ text, id }: { text: string; id: string }) {
  const parts = text.split(KEYS_SLOT);
  return (
    <>
      {parts.map((part, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one sentence, in order
        <Fragment key={index}>
          {index === 0 ? null : <Keys id={id} announce />}
          {part}
        </Fragment>
      ))}
    </>
  );
}
