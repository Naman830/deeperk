import type { Metadata } from "next";
import { SettingsPane } from "../settings-pane";
import { ThemePicker } from "./theme-picker";

export const metadata: Metadata = { title: "Appearance" };

export default function AppearanceSettingsPage() {
  return (
    <SettingsPane title="Appearance">
      <ThemePicker />
    </SettingsPane>
  );
}
