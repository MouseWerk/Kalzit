import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { setSeriesProperty } from "./ColorsEditor";
import { FieldConfigEditor } from "./FieldConfigEditor";
import { EMPTY_FIELD_CONFIG, type FieldConfig } from "./fieldConfig";

const TIME_SERIES = ["colors", "graphStyle", "thresholds", "overrides"] as const;

/** The editor with its config kept in state; `seen` holds every config it sent. */
function setup(initial: FieldConfig = EMPTY_FIELD_CONFIG) {
  const seen: FieldConfig[] = [];
  function Host() {
    const [config, setConfig] = useState<FieldConfig>(initial);
    return (
      <FieldConfigEditor
        value={config}
        groups={TIME_SERIES}
        seriesNames={["Umsatz", "Vortag"]}
        onChange={(next) => {
          seen.push(next);
          setConfig(next);
        }}
      />
    );
  }
  const user = userEvent.setup();
  render(<Host />);
  return { user, seen, last: () => seen.at(-1) ?? initial };
}

async function openSection(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByText(name, { selector: "summary" }));
}

describe("colours editor", () => {
  it("sets the scheme and keeps the palette as the unset default", async () => {
    const { user, last } = setup();
    await openSection(user, "Colors");
    await user.selectOptions(screen.getByRole("combobox", { name: "Color scheme" }), "blues");
    expect(last().defaults.colorScheme).toBe("blues");
    await user.selectOptions(screen.getByRole("combobox", { name: "Color scheme" }), "palette");
    expect(last().defaults).toEqual({});
  });

  it("styles a series through its own override, removed again when cleared", async () => {
    const { user, last } = setup();
    await openSection(user, "Colors");
    await user.selectOptions(screen.getByRole("combobox", { name: "Color of Vortag" }), "chart-2");
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Line style of Vortag" }),
      "dashed",
    );
    await user.type(screen.getByRole("spinbutton", { name: "Opacity of Vortag in percent" }), "85");
    expect(last().overrides).toEqual([
      {
        matcher: { type: "name", value: "Vortag" },
        properties: { color: "chart-2", lineStyle: "dashed", opacity: 85 },
      },
    ]);
    await user.selectOptions(screen.getByRole("combobox", { name: "Color of Vortag" }), "auto");
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Line style of Vortag" }),
      "auto",
    );
    await user.clear(screen.getByRole("spinbutton", { name: "Opacity of Vortag in percent" }));
    expect(last().overrides).toEqual([]);
  });

  it("takes a free colour only once it is a full hex colour", async () => {
    const { user, last } = setup();
    await openSection(user, "Colors");
    const select = screen.getByRole("combobox", { name: "Color of Umsatz" });
    await user.selectOptions(select, "custom");
    const row = select.closest("li") as HTMLElement;
    const hex = within(row).getByRole("textbox", { name: "Hex" });
    await user.clear(hex);
    await user.type(hex, "#12ab");
    expect(screen.getByText(/Enter a color as # and six hex digits/)).toBeTruthy();
    expect(last().overrides[0]?.properties.color).toBe("#6aa3d8");
    await user.type(hex, "EF");
    expect(last().overrides[0]?.properties.color).toBe("#12abef");
  });

  it("gives threshold steps free colours and shows them in the chart on request", async () => {
    const { user, last } = setup();
    await openSection(user, "Thresholds");
    await user.click(screen.getByRole("button", { name: "Add thresholds" }));
    const base = screen.getByRole("group", { name: "Base color" });
    await user.click(within(base).getByRole("radio", { name: "Custom color" }));
    const hex = within(base).getByRole("textbox", { name: "Hex" });
    await user.clear(hex);
    await user.type(hex, "#8a8a93");
    expect(last().defaults.thresholds?.steps[0]).toEqual({
      value: null,
      tone: "ok",
      color: "#8a8a93",
    });
    // Picking a tone again drops the free colour.
    await user.click(within(base).getByRole("radio", { name: "Neutral" }));
    expect(last().defaults.thresholds?.steps[0]).toEqual({ value: null, tone: "neutral" });
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Show in the chart" }),
      "linesAndAreas",
    );
    expect(last().defaults.thresholdDisplay).toBe("linesAndAreas");
  });
});

describe("series overrides", () => {
  it("add, change and drop one series' override without touching the others", () => {
    const other = { matcher: { type: "regex" as const, value: "^cpu" }, properties: { unit: "%" } };
    let config: FieldConfig = { defaults: {}, overrides: [other] };
    config = setSeriesProperty(config, "Vortag", "opacity", 85);
    config = setSeriesProperty(config, "Vortag", "color", "#4fb3a9");
    expect(config.overrides[1]?.properties).toEqual({ opacity: 85, color: "#4fb3a9" });
    config = setSeriesProperty(config, "Vortag", "opacity", undefined);
    config = setSeriesProperty(config, "Vortag", "color", undefined);
    expect(config.overrides).toEqual([other]);
  });
});
