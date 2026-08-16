import { SettingsNav } from "./settings-nav";
import { ShellColumns } from "@/components/features/shell/shell-columns";

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    // On mobile the section list and the section itself can't share the screen,
    // so every subsection counts as a detail route. /settings (Profile) is the
    // index and stays beside the list on desktop.
    <ShellColumns
      list={<SettingsNav />}
      detailPrefixes={["/settings/privacy", "/settings/account", "/settings/appearance"]}
    >
      {children}
    </ShellColumns>
  );
}
