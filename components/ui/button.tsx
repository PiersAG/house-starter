/**
 * shadcn/ui — button
 *
 * COPIED IN, NOT A DEPENDENCY. This file is OUR SOURCE now: it is reviewed in
 * ordinary PR diffs, it executes no install-time scripts, and it changes only
 * when we change it. That ownership is the point of the copy-in model.
 *
 * Provenance: https://ui.shadcn.com/r/styles/new-york/button.json
 * Fetched:    2026-07-26 · Licence: MIT (shadcn/ui)
 *
 * LOCAL MODIFICATIONS:
 *   Hover/focus/open state backgrounds remapped from --accent to --muted
 *   (hover:bg-accent, hover:text-accent-foreground). shadcn treats --accent as a SUBDUED
 *   hover background; in this palette --accent is a VIVID brand colour, so
 *   the upstream classes would paint brand-coloured hovers and, on a light
 *   accent, unreadable text. --muted carries shadcn's intended meaning here.
 *   Our token semantics win; a copied component never repurposes --accent.
 */

import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow hover:bg-primary/90",
        destructive:
          "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90",
        outline:
          "border border-input bg-background shadow-sm hover:bg-muted hover:text-muted-foreground",
        secondary:
          "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80",
        ghost: "hover:bg-muted hover:text-muted-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
