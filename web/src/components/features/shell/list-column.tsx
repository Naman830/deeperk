import { cn } from "@/lib/utils";

type ListColumnProps = {
  title: string;
  action?: React.ReactNode;
  // Rendered directly under the title row — the sketch's search input.
  toolbar?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
};

// The middle column of the three-pane shell. Shared by conversations, calls and
// settings so all three line up pixel-for-pixel. Sizing is owned by ShellColumns.
export function ListColumn({ title, action, toolbar, className, children }: ListColumnProps) {
  return (
    <div className={cn("bg-sidebar flex h-full w-full min-w-0 flex-col md:border-r", className)}>
      {/* h-14 matches the thread header exactly, so the two columns' top edges
          line up. sticky + backdrop-blur keeps the title legible while the list
          scrolls under it, which matters most on a phone where this column is
          the whole screen. */}
      <div className="bg-sidebar/80 sticky top-0 z-10 flex h-14 shrink-0 items-center justify-between gap-2 px-4 backdrop-blur">
        <h1 className="truncate text-base font-semibold tracking-tight">{title}</h1>
        {action}
      </div>
      {toolbar && <div className="shrink-0 px-3 pb-3">{toolbar}</div>}
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-3">{children}</div>
    </div>
  );
}
