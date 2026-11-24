# Privacy Policy for Focus Timer

Last updated: November 24, 2026

Focus Timer ("the extension") is a browser extension with a countdown timer, a Pomodoro timer, a stopwatch, a world clock and optional site blocking during focus sessions. This policy explains what the extension stores and what it does with it.

## Summary

Focus Timer does not collect, send or share any personal data. It has no account, no server, no analytics and no tracking. Everything it saves stays in your browser's local extension storage on your device.

## What is stored on your device

The extension uses the browser's local storage (the `storage` permission) to keep these items:

- **The current timer session**: whether a timer is running, paused or done, when it ends, the time left, the session length, and the optional "What are you focusing on?" message (up to 120 characters). For a Pomodoro session it also keeps the current phase, the cycle number and the phase lengths.
- **Your Pomodoro lengths**: the focus, break and long break minutes you set.
- **Your last focus message**, so the box is filled in next time.
- **The stopwatch state**: whether it is running, when it started, the elapsed time and your laps.
- **Display choices**: which tab you last used (Timer or Stopwatch, Standard or Pomodoro), whether the World Clock and block list are collapsed, and the time zones you added to the World Clock.
- **Your block list**: the sites you chose to block, any custom sites you added, and whether blocking is switched on.
- **The last version whose "What's new" note you saw**, so the note shows only once per update.

The extension does not store your browsing history, the pages you visit, or the addresses of your tabs.

You can delete all of this at any time by removing the extension, or by clearing its data from the browser's extension settings.

## Site blocking

Site blocking only does anything if you switch it on and choose at least one site. While a focus session is running (or paused), the extension:

- Creates blocking rules in your browser with the `declarativeNetRequest` permission, built only from your own block list. The browser applies these rules itself; no list is downloaded from anywhere. Some built-in choices cover a second address: YouTube also covers youtu.be, and X also covers twitter.com.
- Uses the `tabs` permission to read the address of a tab when it changes, only to check it against your block list. If the site is on the list, the tab is sent to the extension's own "blocked" page. This check happens locally; tab addresses are never saved or sent anywhere.

The rules are removed when the session ends or is reset, and during Pomodoro breaks.

## Permissions

- **alarms**: to end the timer on time, even when the popup is closed.
- **notifications**: to tell you when a timer, focus phase or break ends.
- **storage**: to keep the items listed above on your device.
- **offscreen**: to play the end-of-timer sound.
- **declarativeNetRequest**: to block the sites on your block list during a focus session.
- **tabs**: to check a tab's address against your block list, locally, and show the blocked page.

## Network and third parties

Focus Timer makes no network requests of its own. The only outside links are ones you choose to click: the store review page and the developer's LinkedIn profile. Focus Timer does not sell, transfer or share any data with anyone, because it does not collect any.

## Changes to this policy

If this policy changes, the updated version will be posted at the same address with a new "Last updated" date.

## Contact

If you have questions about this policy, you can reach the developer, Adham Eltawil, through the contact details on the extension's Microsoft Edge Add-ons or Chrome Web Store listing.
