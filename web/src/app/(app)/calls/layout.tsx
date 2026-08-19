import { ListColumn } from "@/components/features/shell/list-column";
import { ShellColumns } from "@/components/features/shell/shell-columns";
import { CallHistoryList } from "./call-history-list";
import { CallsRefresher } from "./calls-refresher";

export default function CallsLayout({ children }: LayoutProps<"/calls">) {
  return (
    <>
      <ShellColumns
        list={
          <ListColumn title="Calls">
            <CallHistoryList />
          </ListColumn>
        }
        // Without this the default [] made isDetail permanently false, so the pane
        // could never appear on mobile. Trailing slash so /calls stays the index and
        // any future /calls/[id] is a detail route without touching this line.
        detailPrefixes={["/calls/"]}
      >
        {children}
      </ShellColumns>
      <CallsRefresher />
    </>
  );
}
