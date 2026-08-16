import { cn } from "@/lib/utils";

// The right-hand pane of the shell — the opposite role from ListColumn, which is
// why it lives in its own module: most consumers want one or the other, never both.
// `centered` is for the placeholder states that sit where a conversation or profile
// will eventually render.
export function MainPane({
  className,
  centered,
  children,
}: {
  className?: string;
  centered?: boolean;
  children: React.ReactNode;
}) {
  return (
    <main className={cn("bg-background h-full w-full min-w-0", centered ? "grid place-items-center" : "flex flex-col", className)}>
      {children}
    </main>
  );
}
