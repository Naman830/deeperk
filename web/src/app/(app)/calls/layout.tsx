import { PhoneOff } from "lucide-react";
import { ListColumn } from "@/components/features/shell/list-column";
import { ShellColumns } from "@/components/features/shell/shell-columns";
import { EmptyState } from "@/components/features/shell/empty-state";

export default function CallsLayout({ children }: LayoutProps<"/calls">) {
  return (
    <ShellColumns
      list={
        <ListColumn title="Calls">
          <EmptyState icon={<PhoneOff size={28} />} title="No calls yet" description="Your call history will show up here." />
        </ListColumn>
      }
      // Without this the default [] made isDetail permanently false, so the pane
      // could never appear on mobile. Trailing slash so /calls stays the index and
      // any future /calls/[id] is a detail route without touching this line.
      detailPrefixes={["/calls/"]}
    >
      {children}
    </ShellColumns>
  );
}
