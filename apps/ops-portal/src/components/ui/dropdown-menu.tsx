import * as React from "react"
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

// A row-actions menu. Same thin-wrapper shape as dialog.tsx and popover.tsx
// beside it: the primitive keeps its own API, this file only carries the theme.
//
// DropdownMenu rather than Popover, which is already here and would have looked
// like less work: this gives the menu role, arrow-key roving focus, type-ahead,
// and closes on select. A Popover holding buttons has none of that and reads to
// a screen reader as a floating box, not as a list of actions.
//
// DO NOT `asChild` this trigger around ./button.tsx's Button. That Button is a
// plain function component with no forwardRef, so on React 18 the ref Radix
// needs never arrives: the menu then fails to anchor and, in a real browser,
// does not open at all. jsdom does not reproduce it, because Slot still merges
// the onClick, so the test suite passes while the page is broken. Style this
// trigger directly with `buttonVariants` instead, the way Picker.tsx already
// styles PopoverTrigger.

function DropdownMenu({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />
}

function DropdownMenuTrigger({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  return <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />
}

function DropdownMenuContent({
  className,
  align = "end",
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-36 overflow-hidden rounded-xl border p-1 shadow-md outline-hidden",
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  )
}

function DropdownMenuItem({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  variant?: "default" | "destructive" | "success"
}) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-variant={variant}
      className={cn(
        "relative flex w-full cursor-default select-none items-center gap-2 rounded-lg px-2.5 py-2 text-sm outline-hidden transition-colors",
        "focus:bg-muted focus:text-foreground data-highlighted:bg-muted",
        // The disabled treatment has to be legible, not invisible: a resolved
        // row's actions are shown greyed rather than absent, so the menu does
        // not silently change shape between rows.
        "data-disabled:pointer-events-none data-disabled:opacity-50",
        variant === "destructive" && "text-destructive focus:bg-destructive/10 focus:text-destructive data-highlighted:bg-destructive/10",
        // The mirror of destructive, for the outcome that cures rather than
        // archives. #2e7d32 is the same green the filled success toast uses, so
        // "this worked" reads the same whether it is a menu item or a
        // notification. The wash is lighter than destructive's 10 percent: green
        // at the same opacity sits heavier against white, and this item is the
        // ordinary choice rather than the one to hesitate over.
        variant === "success" &&
          "text-[#2e7d32] focus:bg-[#2e7d32]/[0.07] focus:text-[#2e7d32] data-highlighted:bg-[#2e7d32]/[0.07] dark:text-emerald-400 dark:focus:bg-emerald-400/10 dark:data-highlighted:bg-emerald-400/10",
        className,
      )}
      {...props}
    />
  )
}

function DropdownMenuLabel({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Label>) {
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-label"
      className={cn("px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground", className)}
      {...props}
    />
  )
}

function DropdownMenuSeparator({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  )
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
}
