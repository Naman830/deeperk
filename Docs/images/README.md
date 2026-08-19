# Screenshots — capture guide

The root [`README.md`](../../README.md) expects four PNGs in this folder. Until they
exist, its screenshot table renders as broken images with alt text — that is deliberate,
not an oversight, and it fixes itself the moment you drop the files in. **Keep the exact
filenames below**; nothing else needs to change.

Nothing here is gitignored, so these files commit normally.

| Filename | Route | What should be on screen |
| --- | --- | --- |
| `chat.png` | `/chats/<id>` | A populated DM or group thread: 10+ messages across both sides, a reply quote, an image attachment, a read receipt (double tick), and the typing indicator if you can catch it. This is the hero shot — make the thread look lived-in. |
| `call.png` | any route, mid-call | An active **video** call: two or more participant tiles with real camera output, the control bar visible (mute / camera / hang up), and the call timer running. Group mesh (3 tiles) is more impressive than 1:1 if you can arrange it. |
| `voice-note.png` | `/chats/<id>` | A voice-note bubble mid-playback — waveform/progress advanced, duration visible — with at least one other message above it for context. |
| `settings.png` | `/settings/profile` | The settings pane with an avatar set, a bio filled in, and one or two social links. Shows the nav rail, the settings list column, and the form together. |

## How to capture them

1. Run the app with real data — sign up two accounts with **real names and handles**, not
   the `zz.e2e.` test fixtures.
2. Use the **dark theme** (the app's default). It's what the design was built for and the
   indigo primary reads best against it.
3. Desktop shots at **1440×900**, browser chrome cropped out. The three-column shell needs
   the width; anything narrower collapses the layout and undersells it.
4. Save as PNG. Keep each file under ~500 KB — resize to 1440px wide and let PNG
   compression do the rest, or export at 2× and downscale.
5. Blur or avoid anything real: email addresses, other people's names, any avatar you
   don't own.

> The Playwright browser suite writes ~45 screenshots to `tests/browser/artifacts/` on
> every `npm run test:browser` run. They are **not** suitable here — that directory is
> gitignored, and the shots show fixture identities (`E2e chata`, `@zz.e2e.…`) against
> near-empty threads. Useful as a reference for framing, not as content.

## Adding more

If you add a fifth image, reference it from the README's screenshot section and add a row
above so the next person knows what it's meant to show.
