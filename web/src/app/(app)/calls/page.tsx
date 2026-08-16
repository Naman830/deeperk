import type { Metadata } from "next";
import { Phone } from "lucide-react";
import { MainPane } from "@/components/app/list-column";
import { EmptyState } from "@/components/app/empty-state";

export const metadata: Metadata = { title: "Calls" };

// Placeholder until Socket.IO signaling exists (Docs/call/call.md — not built).
export default function CallsPage() {
  return (
    <MainPane centered>
      <EmptyState icon={<Phone size={40} />} title="Calls aren't available yet" description="Audio and video calling arrives with the signaling server." />
    </MainPane>
  );
}
