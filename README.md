# Powerwall Time of Usage

This application collects data from your Tesla Powerwall gateway to assist in monitoring your home electricity consumption. It does this by giving you detailed information about your energy consumption and production during your differnt tariff (billing rate) periods. 

{ Show Report Snapshots HERE }

## Why? 

Most solar systems include monitoring to help you see how much energy your system is producing and they may help you monitor your consumption. Tesla does a pretty good job of this but there is room for improvement especially when you are on a Time Of Use plan for the you consume.

Most people simply try to avoid consuming power during the Peak billing rates and shift usage to cheaper Off-Peak rates. It just makes sense. But the catch is your solar production is happening during the day mostly during On-Peak rate periods. Which means that your solar system is never getting you credits for the Off-Peak energy your are consuming. This would not be bad except that most energy providers do not pay you very well for solar over production. This means that during the On-Peak billing period you produce 500 extra kwhs a month On-Peak they DO NOT subtract those kwhs from your Off-Peak consumption. They credit you for your over production at a much lower rate than even your Off-Peak consumption. 

> On Peak OverProduction: 500 kwh * 0.055 $/kwh = **$27.50**
> 
> Off Peak Consumption: 500 kwh * 0.106 $/kwh = **$53.00**

This shows that when your solar is overproducing if you avoid over producing and shift your consumption to on-peak you will save a decent amount each month which of course will add up substantially over the life of your solar system.

> Savings over system lifetime: $53 - $27.50 * 12 months * 25 years = **7650$**

### How we help

We monitor your system collecting how much power your are importing and exporting for each Tariff Period. We make this information available to you via a web application. 

### Time Of Use Example

Switching to a Time of Use usually means you pay less on nights and weekends and more during weekdays (M-F) during business hours or later in the evening. For example here is a real world Time Of Use plan:

| Tariff | Period | Consumption | Buyback |
|------|--------|-------------|---------|
|  On-Peak    | Monday - Friday 8am - 8pm  |  0.233 $/kwh | 0.055 $/kwh  |
|  Off-Peak    |  Monday - Friday 12am-8am, 8pm-12am, 24/7 on weekends  |  0.106 $/kwh | 0.47 $/kwh  |

Your solar production is mostly _On-Peak_ and a single Tesla Powerwall 2 has 11.5 kwh of storage so it usually fills up during the day and we use it's power to avoid paying for grid kwhs at night. Except, if we charge our EV or do other energy heavy things like a lot of cooking or laundry. In these cases our natural behavior makes us consume _Off-Peak_ grid electricity (kwh) and we avoid doing energy intensive things during the day because the energy costs are so much higher (.23$ vs. .10$). With PwUsage we have more information to make decisions. 

{{ Expand this to show screen shots which help make decisions based on ToU details }}

### Glossary

**Tariff** - A rate per kwh for electricity that you purchase from the grid and usually a separate rate for selling back to the grid.

**Tariff Period** - A range of time and the tariff it is being bill at. Example: _Monday 8am-8pm Tariff: On-Peak_

## Developers

### Running PWUsage Locally

1. Clone repo
2. Set up environment variables:
   * Copy `cmd/next-app/example.env` to `cmd/next-app/.env`
   * You'll need a [Tesla Developer account](https://developer.tesla.com/dashboard) and [API access](https://developer.tesla.com/request). Edit `cmd/next-app/.env` with your developer credentials.
3. Install dependencies and start the web app:
   ```bash
   cd cmd/next-app
   npm install
   npm run dev
   ```
4. For native iOS development, open `cmd/ios-app` (see `cmd/ios-app/README.md`).

### Setup

If you're starting from an empty DB for the Next.js app:

1. Create the schema:
   ```bash
   cd cmd/next-app
   ./create-db.sh
   ```
   This creates `cmd/next-app/pwusage.db` with the required tables and foreign keys.

2. Point the app at it by setting `DATABASE_URL` (in `cmd/next-app/.env` or your shell), e.g.:
   ```env
   DATABASE_URL="file:pwusage.db"
   ```

3. Start the Next.js dev server:
   ```bash
   cd cmd/next-app
   npm install
   npm run dev     # start the web app
   ```

4. Authenticate via the UI (or copy an existing access token into AppSettings)

### GitHub Actions CI/CD Configuration

The GitHub Actions workflow (`.github/workflows/ci.yml`) automates building, testing, database backups, migrations, and deployments to Vercel. 

To configure CI/CD, set the following secrets in your GitHub repository (**Settings > Secrets and variables > Actions**):

| Secret Name | Required For | Description |
|---|---|---|
| `DATABASE_URL` | Production Migrations & Backups | The production PostgreSQL database connection string. Used to run migrations and perform backups before migrations. |
| `DEV_DATABASE_URL` | Migration Verification & Previews | The development/preview PostgreSQL database connection string. Used to verify migrations on PRs and configure preview deployments. |
| `CRON_SECRET` | Migrations | The API secret used to authorize sub-daily cron triggers. The migration job replaces the `{{CRON_SECRET}}` placeholder in SQL migration files with this secret at deploy time. |
| `BLOB_READ_WRITE_TOKEN` | Database Backups | Vercel Blob read-write token. Used to upload zipped SQL database backups before migrations run. |
| `VERCEL_TOKEN` | Vercel Deployment | Vercel Personal Access Token used to authenticate deployments. |
| `VERCEL_ORG_ID` | Vercel Deployment | Vercel Organization ID. |
| `VERCEL_PROJECT_ID` | Vercel Deployment | Vercel Project ID. |
| `DISCORD_WEBHOOK` | Notifications | Discord webhook URL used to send deployment status notifications. |
