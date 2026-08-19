import Link from "next/link";
import { PhoneOff } from "lucide-react";
import { MainPane } from "@/components/features/shell/main-pane";
import { EmptyState } from "@/components/features/shell/empty-state";
import { Button } from "@/components/ui/button";

// Scoped to this segment so the shell survives. Without it, notFound() bubbles
// past the other scoped boundaries to the root one, which replaces the whole
// app chrome.
export default function CallNotFound() {
  return (
    <MainPane centered>
      <EmptyState
        icon={<PhoneOff size={40} />}
        title="Call not found"
        description="It may have been removed, or you don't have access."
        action={
          <Button asChild variant="outline">
            <Link href="/calls">Back to calls</Link>
          </Button>
        }
      />
    </MainPane>
  );
}
