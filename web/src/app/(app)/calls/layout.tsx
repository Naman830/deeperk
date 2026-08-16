import { PhoneOff } from "lucide-react";
import { ListColumn } from "@/components/app/list-column";
import { ShellColumns } from "@/components/app/shell-columns";
import { EmptyState } from "@/components/app/empty-state";

export default function CallsLayout({ children }: LayoutProps<"/calls">) {
  return (
    <ShellColumns
      list={
        <ListColumn title="Calls">
          <EmptyState icon={<PhoneOff size={28} />} title="No calls yet" description="Your call history will show up here." />
        </ListColumn>
      }
    >
      {children}
    </ShellColumns>
  );
}
