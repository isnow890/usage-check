"use client";

import type { ReactNode } from "react";
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import type { DragHandleProps } from "@/lib/types";

function SortableItem<T extends { id: string }>({
  item,
  render,
}: {
  item: T;
  render: (item: T, handle: DragHandleProps) => ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? "relative z-10 opacity-80" : undefined}
    >
      {render(item, { attributes, listeners })}
    </div>
  );
}

/**
 * Shared ordering surface. Provider cards and the summary strip both need the
 * same sensors, keyboard support, and reorder semantics, so they use one
 * implementation instead of two that drift.
 */
export function SortableGrid<T extends { id: string }>({
  items,
  order,
  onOrderChange,
  render,
  className,
  layout = "grid",
}: {
  items: T[];
  order: string[];
  onOrderChange: (next: string[]) => void;
  render: (item: T, handle: DragHandleProps) => ReactNode;
  className?: string;
  /** `grid` for side-by-side cards, `list` for stacked full-width sections. */
  layout?: "grid" | "list";
}) {
  const sensors = useSensors(
    // Desktop: a few pixels of movement starts the drag immediately.
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    // Touch: PointerSensor loses the gesture to the browser's scroll, so touch
    // needs a brief hold to claim it. A quick swipe still scrolls the page.
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const byId = new Map(items.map((item) => [item.id, item]));
  const sorted = order.map((id) => byId.get(id)).filter((item): item is T => Boolean(item));
  for (const item of items) {
    if (!order.includes(item.id)) sorted.push(item);
  }

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const ids = sorted.map((item) => item.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    onOrderChange(arrayMove(ids, from, to));
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext
        items={sorted.map((item) => item.id)}
        strategy={layout === "list" ? verticalListSortingStrategy : rectSortingStrategy}
      >
        <div className={className}>
          {sorted.map((item) => (
            <SortableItem key={item.id} item={item} render={render} />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
