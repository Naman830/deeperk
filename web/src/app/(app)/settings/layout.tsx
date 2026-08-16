import { SettingsNav } from "./settings-nav";
import { ShellColumns } from "@/components/features/shell/shell-columns";

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    // On mobile the section list and the section itself can't share the screen,
    // so every subsection is a detail route and /settings is the index. One
    // trailing-slash prefix rather than an enumerated list, so adding a section
    // can't silently make it unreachable on mobile.
    <ShellColumns list={<SettingsNav />} detailPrefixes={["/settings/"]}>
      {children}
    </ShellColumns>
  );
}
