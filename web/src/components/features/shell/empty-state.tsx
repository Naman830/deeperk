import { cn } from "@/lib/utils";

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 px-6 py-12 text-center", className)}>
      {/* The icon sits in a soft plate rather than floating: a bare 28px glyph
          at 60% opacity reads as a rendering failure on the dark ground, which
          is precisely where empty states are most common. */}
      {icon && (
        <span className="bg-muted/60 text-muted-foreground grid size-14 place-items-center rounded-2xl">{icon}</span>
      )}
      <div>
        <p className="text-sm font-medium">{title}</p>
        {description && (
          <p className="text-muted-foreground mx-auto mt-1 max-w-xs text-sm leading-relaxed">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}
