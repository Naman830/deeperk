"use client";

import { AtSign, Bell, MessageSquare, PhoneIncoming, Type, Volume2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { playBlip, primeBlip } from "@/lib/realtime/blip";
import {
  useNotificationPrefs,
  type NotificationPrefs,
} from "@/lib/realtime/notification-prefs";

const ROWS: {
  key: keyof NotificationPrefs;
  label: string;
  description: string;
  icon: typeof Bell;
}[] = [
  {
    key: "toasts",
    label: "Show message popups",
    description: "A small popup when a message arrives while you're elsewhere in the app.",
    icon: MessageSquare,
  },
  {
    key: "sound",
    label: "Play a sound",
    description: "A short blip for each new message.",
    icon: Volume2,
  },
  {
    key: "titleBlink",
    label: "Flash the tab title",
    description: "Shows the unread count in the browser tab while ChatSphere is in the background.",
    icon: Type,
  },
  {
    key: "ringtone",
    label: "Ring for incoming calls",
    description: "Play a ringtone when a call comes in — the call screen itself always shows.",
    icon: PhoneIncoming,
  },
];

export function NotificationsForm() {
  const { prefs, setPref } = useNotificationPrefs();

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardContent className="flex flex-col gap-1 py-1">
          {ROWS.map(({ key, label, description, icon: Icon }) => (
            <div
              key={key}
              className="flex items-start gap-3 border-b py-3 last:border-b-0"
            >
              <Icon size={17} className="text-muted-foreground mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <Label htmlFor={`pref-${key}`} className="text-sm font-medium">
                  {label}
                </Label>
                <p className="text-muted-foreground mt-0.5 text-xs">{description}</p>
              </div>
              <Switch
                id={`pref-${key}`}
                checked={prefs[key]}
                onCheckedChange={(checked) => {
                  setPref(key, checked);
                  // Turning sound ON plays it once, so the choice is audible
                  // immediately rather than at the next message. primeBlip
                  // first because the AudioContext can only be unlocked from a
                  // real gesture — this click is one.
                  if (key === "sound" && checked) {
                    primeBlip();
                    playBlip();
                  }
                }}
              />
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex items-start gap-3 py-3">
          <AtSign size={17} className="text-primary mt-0.5 shrink-0" />
          <p className="text-muted-foreground text-xs">
            A message that <span className="text-foreground font-medium">@mentions you</span> still notifies you in a
            muted group — but it respects the switches above, so turning popups off turns them off everywhere.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
