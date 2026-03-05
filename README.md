# RedAlert Chrome Extension

A Chrome extension that sends **Red Alert** notifications for a **manually selected location**.

The extension is optimized to be efficient and responsive:
- Adaptive polling (fast during active events, slower when quiet)
- Request deduplication and notification cooldown
- Conditional fetch support (`If-None-Match` / `If-Modified-Since`) when available
- Overlap protection (no concurrent poll spam)

## Features

- Manual location input
- Autocomplete suggestions for Israeli locations (via Nominatim)
- Test notification button
- "Check now against server" button
- Background alert monitoring with anti-spam logic

## Data Sources

- Alerts feed: `https://www.oref.org.il/warningMessages/alert/alerts.json`
- Geocoding/autocomplete: Nominatim (`nominatim.openstreetmap.org`)

## Installation (Load Unpacked)

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this folder:
   `C:\Users\abyos\Documents\GitHub\RedAlert`

## Usage

1. Open the extension popup
2. Enter your location manually (you can use suggestions)
3. Click **Save**
4. Use **Send test notification** to verify notification delivery
5. Use **Check now against server** for an immediate check

## Notes

- Chrome extension notifications are controlled mainly by Chrome + OS notification settings.
- If notifications are blocked, enable notifications for Chrome in your system settings.
- The extension is currently **manual-location only** (GPS and Google Maps modes were removed).

## Development

Main files:
- `manifest.json`
- `popup.html`
- `popup.css`
- `popup.js`
- `background.js`

To apply local changes after editing, reload the extension in `chrome://extensions`.
