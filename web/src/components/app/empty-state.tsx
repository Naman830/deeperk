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
      {icon && <span className="text-muted-foreground opacity-60">{icon}</span>}
      <div>
        <p className="text-sm font-medium">{title}</p>
        {description && <p className="text-muted-foreground mx-auto mt-1 max-w-xs text-sm">{description}</p>}
      </div>
      {action}
    </div>
  );
}
