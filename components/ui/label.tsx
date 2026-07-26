/**
 * shadcn/ui — label
 *
 * COPIED IN, NOT A DEPENDENCY. This file is OUR SOURCE now: it is reviewed in
 * ordinary PR diffs, it executes no install-time scripts, and it changes only
 * when we change it. That ownership is the point of the copy-in model.
 *
 * Provenance: https://ui.shadcn.com/r/styles/new-york/label.json
 * Fetched:    2026-07-26 · Licence: MIT (shadcn/ui)
 *
 * LOCAL MODIFICATIONS:
 *   none — copied verbatim.
 */

"use client"

import * as React from "react"
import * as LabelPrimitive from "@radix-ui/react-label"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const labelVariants = cva(
  "text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
)

const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root> &
    VariantProps<typeof labelVariants>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    className={cn(labelVariants(), className)}
    {...props}
  />
))
Label.displayName = LabelPrimitive.Root.displayName

export { Label }
