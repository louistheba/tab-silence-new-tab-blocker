# Tab Silence: New Tab Blocker

This Chrome extension lets you choose, site by site, whether websites should be allowed to open new tabs. When you turn blocking on for a site, it also adds extra privacy protections to reduce leakage during popup attempts.

## What it does

- Defaults to **not blocking** on every site.
- Adds a popup when you click the extension icon, so you can turn blocking on or off for the current base URL.
- Saves that preference in `chrome.storage.local` per base URL, such as `https://example.com`, on the local browser only.
- Watches for real popup-opening behavior on the current site and surfaces that signal in the popup.
- When blocking is enabled for a site, overrides `window.open()` in the page context so popup scripts are stopped earlier.
- When blocking is enabled for a site, rewrites risky targets such as `_blank` back to `_self`, while leaving `_self`, `_top`, `_parent`, and same-page frame targets alone.
- When blocking is enabled for a site, strips link `ping` tracking attributes and blocks `ping` requests for that tab at the network layer.
- When blocking is enabled for a site, uses popup-tab fallback closing plus temporary session rules to reduce the chance of `Referer`, `Cookie`, or `Origin` leakage if a tab is created for a split second.
- Shows a lifetime `2nd-Layer Block` count for the backup layer that had to step in after a site still tried to open a new tab.
- Keeps extension data local to the browser and does not send browsing activity to a remote server.
- Colors the toolbar icon per website state: grey when idle, yellow when popup behavior has been detected but blocking is off, and green when blocking is on.

## Install
Can be installed either by
- Download and load the extension manually in developer mode in the browser
- Download via Chrome extension store https://chromewebstore.google.com/detail/kdnpahhcldaalamgeekldkfdpohcjflh?utm_source=item-share-cb

## Notes

- Blocking is intentionally aggressive on sites where you turn it on. Manual attempts by web content to open new tabs from those sites will also be stopped.
- The popup signal is based on observed popup-opening behavior, not a full static security scan of the page.
- The `2nd-Layer Block` count only tracks lifetime fallback blocks where the backup layer had to step in.
- For Chrome Web Store submission notes, see `CHROME_WEB_STORE_SUBMISSION.md`.

## License

This project is available under the MIT License.

If you incorporate it into a closed-source project, I would appreciate it if you let me know by opening a GitHub issue or contacting me.

Notification is appreciated, but not legally required.
