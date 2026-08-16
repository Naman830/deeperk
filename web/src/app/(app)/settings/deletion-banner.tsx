import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

// Shown while a deletion is pending. Reaching any authenticated page already
// cancels it (getSession clears the column), so in practice this only appears on
// the render immediately after scheduling — which is exactly when it's needed.
export function DeletionBanner({ deletionScheduledAt }: { deletionScheduledAt: Date | null }) {
  if (!deletionScheduledAt) return null;

  const date = new Date(deletionScheduledAt).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });

  return (
    <Alert variant="destructive">
      <AlertTriangle />
      <AlertTitle>Your account is scheduled for deletion</AlertTitle>
      <AlertDescription>Everything is removed on {date}. Logging in before then cancels it automatically.</AlertDescription>
    </Alert>
  );
}
