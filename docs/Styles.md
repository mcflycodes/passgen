# Styles

A style is PassGen's look: colours, borders and backgrounds, in light and dark
themes. Five ship with it: Calm (the default), Payload, Slate, Green and Purple.
The [README](../README.md#screenshots) shows each one.

## Choosing the offered styles

Styles are offered through `style.offered` in the
[configuration](Configuration.md). One offered style leaves the Style control
out of the page.

## How a style is built

A style is one stylesheet of design tokens under `src/styles/<id>/style.css`.
[`src/styles/README.md`](../src/styles/README.md) is the style guide: the token
list, the rules every style must keep and how to test one. The rules:

- Tokens only: custom properties in the style's own `:root[data-style]` rule,
  with no ordinary property, other selector or at-rule.
- No external resource of any kind.
- Every required token for both themes, declared once, along with everything a
  colour token refers to.
- WCAG 2.2 AA contrast for the token pairs.

The checks judge the parsed, decoded CSS and its minified form. The build runs
them and fails on any problem, and `pnpm verify:dist` refuses any resource in
the emitted CSS. `pnpm styles:check` runs them on their own.

## Theme and style at page load

The theme and style are applied before the first paint by a small classic
script, built from `src/boot/theme.ts` into `assets/boot-<hash>.js` and placed
in `<head>` before the stylesheet, so there is no inline script and the CSP is
unchanged. System follows `prefers-color-scheme` live through `color-scheme`
and `light-dark()` colours. `src/ui/theme.ts` applies later theme and style
changes.

## Contributing a style

New styles are welcome. Follow the style guide, then run the full checks; see
[Contributing](../CONTRIBUTING.md).
