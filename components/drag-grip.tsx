import { GripVertical } from "lucide-react";

import type { DragHandleProps } from "@/lib/types";
import { cn } from "@/lib/cn";

/**
 * The visual grip stays small but a coarse pointer needs a real 44px target.
 * Negative margins keep that enlargement from changing the header's height.
 */
export function DragGrip({
  handle,
  label,
  className,
}: {
  handle: DragHandleProps;
  label: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={`Reorder ${label}`}
      className={cn(
        "grid size-5 shrink-0 touch-manipulation cursor-grab place-items-center rounded text-ink-faint hover:text-ink active:cursor-grabbing pointer-coarse:-m-3 pointer-coarse:size-11",
        className,
      )}
      {...handle.attributes}
      {...handle.listeners}
    >
      <GripVertical className="size-3.5 pointer-coarse:size-5" />
    </button>
  );
}
