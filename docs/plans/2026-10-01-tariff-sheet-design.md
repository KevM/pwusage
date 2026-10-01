# Tariff sheet design

Approved: dedicated iOS dashboard toolbar button opening a tariff sheet.

Show the current season and period using the site's timezone, then every current tariff's seasons, date ranges, periods, weekday rules, time windows, and buy/sell rates. Match the web app's weekend override labels and rate fallback. Use authorized, private, no-store server responses built from current-only saved tariffs and the existing Schedule resolver. No Tesla calls or schema changes.

Refresh active markers while visible; suppress stale active markers when refresh fails. Include loading, empty, retry, and close controls. Support Dynamic Type and VoiceOver.

## Endpoint consolidation

User preference: one endpoint for tariffs. Reuse `/api/site/[id]/refresh-tariffs`: GET returns the saved tariff contract and current activity without calling Tesla; POST retains the existing explicit Tesla refresh behavior. Remove `/api/mobile/tariffs`. The web app continues using its existing POST route and server-rendered tariff data; the iOS sheet reads through GET on that same route.
