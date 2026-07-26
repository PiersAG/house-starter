/**
 * shadcn/ui — badge
 *
 * COPIED IN, NOT A DEPENDENCY. This file is OUR SOURCE now: it is reviewed in
 * ordinary PR diffs, it executes no install-time scripts, and it changes only
 * when we change it. That ownership is the point of the copy-in model.
 *
 * Provenance: https://ui.shadcn.com/r/styles/new-york/badge.json
 * Fetched:    2026-07-26 · Licence: MIT (shadcn/ui)
 *
 * LOCAL MODIFICATIONS:
 *   none — copied verbatim.
 */

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground shadow hover:bg-primary/80",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground shadow hover:bg-destructive/80",
        outline: "text-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants }
