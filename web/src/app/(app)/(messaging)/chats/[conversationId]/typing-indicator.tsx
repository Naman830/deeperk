import { cn } from "@/lib/utils";

// No "use client": rendered from chat-thread.tsx. Sits inside the scroll
// container so it counts as pinned content and the view follows it.
export function TypingIndicator({ names }: { names: string[] }) {
  if (names.length === 0) return null;

  const label = names.length === 1 ? `${names[0]} is typing` : "Several people are typing";

  return (
    <div className="flex items-center gap-2 px-3 pb-3">
      <span className="bg-muted flex items-center gap-1 rounded-2xl rounded-bl-md px-3 py-2">
        {[0, 1, 2].map((dot) => (
          <span
            key={dot}
            className={cn(
              "bg-muted-foreground/60 size-1.5 animate-bounce rounded-full motion-reduce:animate-none",
              dot === 1 && "[animation-delay:150ms]",
              dot === 2 && "[animation-delay:300ms]",
            )}
          />
        ))}
      </span>
      <span className="text-muted-foreground text-xs">{label}</span>
    </div>
  );
}
