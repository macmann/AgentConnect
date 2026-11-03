import type { Branding } from "./customer-experience";
/** One palette for customer chat, the floating widget, and the production preview. */
export function customerAppearance(
  brand: Partial<Branding> = {},
  theme: "light" | "dark" = "light",
) {
  const hex = (value: string | undefined, fallback: string) =>
    value && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
  const primary = hex(brand.primaryColor, "#6d43cc");
  const customPalette =
    (brand.backgroundColor &&
      brand.backgroundColor.toLowerCase() !== "#ffffff") ||
    (brand.textColor && brand.textColor.toLowerCase() !== "#182033");
  const useDarkDefaults = theme === "dark" && !customPalette;
  const background = hex(
    useDarkDefaults ? undefined : brand.backgroundColor,
    useDarkDefaults ? "#121620" : "#ffffff",
  );
  const text = hex(
    useDarkDefaults ? undefined : brand.textColor,
    useDarkDefaults ? "#eef0fa" : "#182033",
  );
  const rgb = (color: string) =>
    [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  const mix = (a: string, b: string, weight: number) =>
    "#" +
    rgb(a)
      .map((value, i) =>
        Math.round(value * weight + rgb(b)[i]! * (1 - weight))
          .toString(16)
          .padStart(2, "0"),
      )
      .join("");
  const luminance = (color: string) =>
    rgb(color)
      .map((v) => {
        const c = v / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      })
      .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
  return {
    primary,
    background,
    text,
    onPrimary: luminance(primary) > 1.05 / 4.5 - 0.05 ? "#000000" : "#ffffff",
    muted: mix(text, background, 0.65),
    line: mix(text, background, 0.18),
    soft: mix(text, background, 0.055),
    scheme:
      luminance(background) < 0.18 ? ("dark" as const) : ("light" as const),
  };
}
export type CustomerAppearance = ReturnType<typeof customerAppearance>;
