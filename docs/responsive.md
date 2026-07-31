# Responsive by construction

Read this before writing UI code. It is short on purpose.

The rule this template is built on:

> **Components ask their container. Pages ask the viewport.**

Everything below follows from that one sentence.

---

## 1. Why not just use `md:`

A breakpoint class is a claim about **the window**. A component that writes
`md:flex-row` is really saying *"when the window is 768px wide, I have room for a
row"* — which is only true while that component happens to occupy the whole
window. Put the same component in a sidebar, a two-column grid, a modal or a
preview pane and the claim is false: the window is wide, the component is not,
and it reflows into a layout that does not fit.

That failure is invisible in review. Nothing errors; the component just looks
wrong in its second home, and the usual fix is a prop like `variant="narrow"`
threaded down from whoever knows the real width. That prop is the smell. The
browser already knows the width — a container query just asks it.

```tsx
// ✗ a guess about the window
<div className="flex flex-col md:flex-row">

// ✓ a fact about this component's own space
<div className="flex flex-col @roomy:flex-row">
```

## 2. The two tools

**Container variants — `@sm:`, `@md:`, `@roomy:`, `@[30rem]:`** — for anything
*inside* a component. This is the default. If you are reaching for a breakpoint
while writing a component, you almost certainly want one of these.

**Viewport variants — `sm:`, `md:`, `lg:`** — reserved for the **top-level page
skeleton**: the page's outer padding, its max-width column, whether the shell
has a sidebar at all. At that level the viewport genuinely is the question.

Both still work everywhere; this is a convention, not a lock. But a `md:` inside
a component should come with a comment explaining why the window is the right
question there.

### Declaring a container

A container variant needs an ancestor marked as a container context:

```tsx
<nav className="@container/appnav …">   {/* named: query with @compact/appnav: */}
<div className="@container …">          {/* unnamed: query with @compact:     */}
```

Name it when a component might sit inside another container — the name says
which one you meant. The two segment layouts (`app/dashboard/layout.tsx`,
`app/account/layout.tsx`) already declare `@container/page`, so anything under
those routes can query the page's width without adding anything.

Marking an element as a container sets no width and changes no layout. It is
free to add.

### The named sizes

Beyond the plugin's `@sm`…`@7xl`, this template names the two boundaries it
actually reasons about (in `tailwind.config.ts`):

| Name      | Width  | Means                                                   |
| --------- | ------ | ------------------------------------------------------- |
| `compact` | 24rem  | below this, a horizontal row of controls stops fitting   |
| `roomy`   | 40rem  | at/above this there is room for a side-by-side layout    |

Prefer these over a bare number: `@roomy:grid-cols-2` says *why*,
`@[40rem]:grid-cols-2` only says *when*. Use an arbitrary value when the reason
is genuinely specific to that one component.

## 3. Fluid type and spacing

Sizes interpolate smoothly between a 320px and a 1280px viewport instead of
snapping at breakpoints. Use `text-fluid-*` and the `fluid-*` spacing steps:

```tsx
<h1 className="text-fluid-3xl">…</h1>
<section className="p-fluid-md space-y-fluid-sm">…</section>
```

Tailwind's own scales (`text-lg`, `p-4`) are untouched and still work — the
fluid steps are additive. Reach for fluid in new UI.

### The accessibility rule, and why the ceiling looks wrong

Each fluid step is a `clamp()` whose **third argument is `2 × the minimum`** —
not the intended large-screen size. That looks like a mistake and is not.

The `vw` term in a fluid size does not grow when a user raises their browser's
font size. So with `clamp(1rem, …, 1.125rem)` — a "sensible" cap — text stops
growing almost immediately under text zoom, and can never reach the 200% that
WCAG 1.4.4 requires. The failure is silent: nothing warns, and it is invisible
unless you test at zoom.

So the ceiling is pure headroom. What renders at a 1280px viewport is the middle
term — that is the design size. The ceiling only binds once the user has zoomed,
which is exactly when it should stop binding.

`fluid()` enforces this: ask for a maximum more than twice the minimum and the
build fails with an explanation rather than shipping a size that clips.

## 4. When a component genuinely needs to rearrange

Sometimes there is no fluid answer — a horizontal nav really does have to become
something else on a phone. The pattern is:

> **One container-query boundary, inside a single component, holding both
> arrangements.**

Not two components. Not a `<MobileNav />` and a `<DesktopNav />`. Not a
whole-screen fork that swaps layouts above some width.

Why one component: two components drift. They are edited on different days, and
the mobile one quietly loses the feature the desktop one gained. Keeping both
arrangements in one file means the data, the links, the ARIA and the state are
written once and only the arrangement branches.

Why CSS and not JavaScript: a `useMediaQuery` hook cannot know the width during
server rendering, so the first paint is a guess and the correction is a visible
flash. A container query is resolved by the browser at layout time — correct on
the first paint, no flash, no hydration mismatch, no JS shipped.

### The worked example

`components/AppNav.tsx` is the reference. The entire switch is two lines:

```tsx
<nav className="@container/appnav …">
  <div className="flex flex-col gap-fluid-3xs
                  @compact/appnav:flex-row @compact/appnav:flex-wrap @compact/appnav:gap-1">
    {links.map(…)}   {/* written once, arrangement-agnostic */}
  </div>
</nav>
```

Below `compact` the links stack full width; at `compact` and above they are a
wrapping row. One boundary, one component, both arrangements, no JavaScript.

Note what did **not** change: the links are mapped once, `aria-current` is set
once, and `min-h-11` — the 44px touch target — is on the link in both
arrangements. **A rearrange must never cost accessibility.** If your narrow form
drops a label, shrinks a target below 44px, or hides a link entirely, it is not
a rearrange, it is a different (worse) product.

The narrow arrangement there is deliberately plain. Card 2.3.49 replaces it with
a real bottom tab bar — at the same boundary, in the same component. That is the
pattern working as intended: the rearrange has somewhere to grow.

## 5. Checklist for new UI

- Reflowing inside a component? Use a container variant, not `md:`.
- Sizing type or spacing? Use `text-fluid-*` / `fluid-*` steps.
- Need a real rearrange? One boundary, one component, both arrangements.
- Does the narrow form keep every link, label and 44px target? If not, fix it.
- Does anything reach for `useMediaQuery`? It should not — that is a flash and a
  hydration mismatch waiting to happen.

## 6. Where this lives

`tailwind.config.ts` — the `fluid()` helper, the fluid scales, the named
container sizes, and the plugin registration. **Not `app/globals.css`**: the
build pipeline overwrites that file with generated output for every new app, so
a scale defined there would silently vanish from every product. This file and
the Tailwind config are inherited intact.
