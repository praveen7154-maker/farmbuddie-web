# Web admin simulation

The whole admin panel, end to end, in Chromium, with no Firebase project and
no VPS. It catches broken pages, script errors, failed requests, leaks and
script injection before a deploy.

```
cd server && npm install         # once - the server modules run inside the harness
bash tools/web_sim/run.sh        # report: /tmp/web_sim/report.txt (+ screenshots on a failure)
```

Module Pricing runs on a real Postgres when `WEB_SIM_PG` points at a throwaway
database whose name ends in `test` or `sim` (its pricing tables are wiped):

```
WEB_SIM_PG=postgres://user:pass@127.0.0.1:5432/websim bash tools/web_sim/run.sh
WEB_SIM_ONLY=16 WEB_SIM_PG=... bash tools/web_sim/run.sh     # only phase 16 (quick re-run)
```

## What is real, what is not

| Part | In the simulation |
|---|---|
| Every page, its HTML / CSS / JS (`public/`) | **Real**, served as Firebase Hosting serves it |
| Bridge server modules - production, team users, OTA, event log, distributors, broadcast, pricing | **Real** code (`server/src/bridge/*`) on in-memory stores |
| `productionFirebase.js`, `deviceProvisioning.js`, `announcementsFirebase.js`, `distributorsFirebase.js`, `teamAccess.js` | **Real** code, pointed at an in-memory Firestore (`memdb.js`) |
| Firestore | In-memory (`memdb.js`), shared by the pages and the server code |
| Firebase Auth | Fake (`fake-firebase/firebase-auth.js`): email login, custom tokens for the onboarding team |
| Firestore security rules | **Not** simulated - the server's own checks are |
| The hub (event log replies) | `fake-hub.js` - 60 records incl. the butterfly "valve stuck" |
| OTA signing key | A throwaway key made for each run - never the fleet key |
| MQTT / TBMQ | Recorded / faked (commands are captured, not sent) |
| Postgres (Module Pricing) | **Real** with `WEB_SIM_PG`, else an empty store |
| CDN libraries (Chart.js, xlsx, qrcode, html2pdf) | **Real** files, fetched once |

## The flows (run.js)

1. Admin sign-in (wrong password refused), every Home module link, signed-out redirect
2. User Roles: create production + onboarding accounts, duplicate refused, switch off / on, new password, delete
3. Production staff: SIM list upload (CSV), 3 controllers (SIM from the inventory, IMEI check), duplicate IMEI refused, nodes; staff can't reach admin pages or the admin API
4. Distributor onboarding (bad PAN refused)
5. Farmer onboarding as the onboarding team: controller + MQTT credentials, assigned controller refused again, same Aadhaar refused; the team is kept to its pages
6. Farmer Database (40 farms: pages, search, deactivate), View, Edit (secondary mobile, node mapping, unmapping)
7. Distributor Database, View, Edit, app password reset
8. MCU / Controller Database
9. Dashboard counts, app access (phone authorization) per farm
10. Analytics and device view: live status, remote Motor ON
11. Firmware OTA: sign in the browser, upload, release, progress, a wrong key refused
12. Event Log: warranty card, 60 records paged from the hub, write-once serial
13. Message Broadcast
14. VPS status, Module Pricing (loads), Ctrl+K search, theme, sign out
15. A switched-off onboarding member refused by the server; no page scrolls sideways at 390 px
16. Module Pricing on a real database (`WEB_SIM_PG`): Production Pricing (a made product's components, a
    bought one's supplier + freight, an edit, a refused entry), a price list with company discounts and our
    cost taken from Production Pricing, publish, the distributors' PDF, the calculator passing on the company
    discount (distributor margin unchanged), the saved quotation's Company / Additional discount rows

Throughout: names carrying `<img src=x onerror=...>` (a farmer, a distributor,
a team member, a broadcast) must never run, and any code that puts that text
into the page as HTML is reported with its file and line. Leak checks repeat
an action and watch live Firestore listeners, timers, window/document
listeners and DOM size.
