# Theming — colour goes through the token layer, always

Every colour in this template is meant to resolve through a design token:

```
bg-primary  →  hsl(var(--primary))  →  the value in app/globals.css
   class          tailwind.config.ts            the theme
```

Swap the values in `app/globals.css` and every surface follows. That is the
whole point of the token layer, and it is what makes a theme library possible:
one file changes, the app re-colours.

## The failure this prevents

A component that writes `bg-blue-600` instead of `bg-primary` compiles to a
literal colour. **No token can reach it.** Swap the palette and that one surface
stays exactly as it was — while everything around it moves.

The failure is completely silent. The class is valid Tailwind, the types are
fine, the linter is happy, the build passes and the tests stay green. The only
way to notice is for a human to look at the rendered page and see one component
that did not change.

That had already shipped here. The entire `SupportWidget` (`bg-blue-600`,
`bg-white`, `text-red-600`, `text-blue-600`) and the `text-white` on four
primary buttons sat outside the token layer, so a palette swap left the support
widget blue on a green app and put white label text on buttons whose theme
called for cream.

## The rule

**In `app/` and `components/`, never write a literal colour.** Use the semantic
tokens defined in `app/globals.css` and mapped in `tailwind.config.ts`:

| Instead of | Use |
|---|---|
| `bg-blue-600` | `bg-primary` |
| `text-white` on a primary surface | `text-primary-foreground` |
| `bg-white` for a raised panel | `bg-card` |
| `text-red-600` | `text-destructive` |
| `text-blue-600` for a link | `text-link` |
| `hover:bg-blue-700` | `hover:bg-primary/90` |
| `disabled:bg-blue-300` | `disabled:bg-primary/40` |

Paired `*-foreground` tokens exist precisely because the right label colour is
**measured per palette, never assumed**: white reads on a deep blue primary and
fails on a light one. `tests/unit/design-tokens.test.ts` computes those contrast
ratios from the live token values on every run.

## The gate

`scripts/check-hardcoded-colours.mjs` scans `app/` and `components/` for raw
Tailwind palette classes, absolute white/black, raw hex, and literal
`rgb()`/`hsl()` values. It runs in CI as `tests/unit/hardcoded-colours.test.ts`,
alongside the design-token contract, and standalone as `npm run check:colours`.

**Exceptions are explicit, not hidden.** A line carrying a
`theme-exempt: <reason>` comment — on the line itself or immediately above it —
is skipped, and every exemption is printed on every run. There is one today:
the modal scrim in `components/ui/dialog.tsx`, which is an absolute black
dimming wash by design and must stay black in every theme.

## Two things deliberately outside the gate

**Email templates (`lib/email/templates/*`) keep their fixed hex.** Email
clients do not reliably support CSS custom properties, so an email cannot
reference `:root` tokens the way an app component can — converting them would
break the emails rather than theme them. `lib/` is not scanned at all, which is
what keeps them out. Making email colour follow a theme means injecting the
theme's *values* into the template server-side at render time; that is its own
slice.

**Token values themselves live in `app/globals.css`** and are generated per app
by `agents/build/build-design.py`. Choosing and curating palettes is the theme
library's job, not a component's.
