import { UserX } from "lucide-react";
import { MainPane } from "@/components/features/shell/main-pane";
import { EmptyState } from "@/components/features/shell/empty-state";

// One page for "no such user", "deactivated" and "scheduled for deletion" — the
// query can't distinguish them and neither should the UI.
export default function UserNotFound() {
  return (
    <MainPane centered>
      <EmptyState icon={<UserX size={40} />} title="User not found" description="This account doesn't exist, or is no longer available." />
    </MainPane>
  );
}
