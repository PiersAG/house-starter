/**
 * shadcn/ui — skeleton
 *
 * COPIED IN, NOT A DEPENDENCY. This file is OUR SOURCE now: it is reviewed in
 * ordinary PR diffs, it executes no install-time scripts, and it changes only
 * when we change it. That ownership is the point of the copy-in model.
 *
 * Provenance: https://ui.shadcn.com/r/styles/new-york/skeleton.json
 * Fetched:    2026-07-26 · Licence: MIT (shadcn/ui)
 *
 * LOCAL MODIFICATIONS:
 *   none — copied verbatim.
 */

import { cn } from "@/lib/utils"

function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-primary/10", className)}
      {...props}
    />
  )
}

export { Skeleton }
