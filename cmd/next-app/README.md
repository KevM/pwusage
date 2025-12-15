# Powerwall Usage 

This application helps you track your Powerwall usage and monitor your energy production and consumption. The main goal is for users who have time of use (TOU) rates and want to optimize their energy usage. 


## ToDo

* Trmnl markdown is not showing all tariff periods
* Research how trmnl integration workflow "should" work

## Configuration

Create a `.env` file in the root directory (or use `env_file` in Docker) with the following variables:

### Required
- `DATABASE_URL`: Connection string for the PostgreSQL database (Supabase recommended). 
    - **Important**: Use the **Transaction Pooler (IPv4)** connection string on port `6543` to avoid connection limits and ensure IPv4 compatibility in Docker.
    - Format: `postgres://[user]:[password]@aws-0-[region].pooler.supabase.com:6543/[dbname]?sslmode=require`
    - Make sure to explicitly provide the password (do not use the placeholder).
- `NEXT_PUBLIC_APP_URL`: The base URL of your application. Used for API calls and OAuth redirects. Example: `http://localhost:3000`
- `PUBLIC_TESLA_OAUTH_CLIENT_ID`: Your Tesla Fleet API Client ID.
- `TESLA_OAUTH_SECRET`: Your Tesla Fleet API Client Secret.
- `PUBLIC_TESLA_OAUTH_AUDIENCE`: The Tesla API audience. Example: `https://fleet-api.prd.na.vn.cloud.tesla.com`

### Optional / Integrations
- `TRMNL_CLIENT_ID`: Client ID for Trmnl integration.
- `TRMNL_CLIENT_SECRET`: Client Secret for Trmnl integration.


## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
