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
2. Copy `./cmd/web-app/example.env` to `./cmd/web-app/.env` 
   * You'll need to have a [Tesla Developer account](https://developer.tesla.com/dashboard) and have [requested API access](https://developer.tesla.com/request). Rename the `example.env` files and edit their contents for your developer account.
3. Start the web application
   * `cd ./cmd/web-app`
   * `npm install`
   * `npm run dev`
4. Start the TUI 
   * `cd ./cmd/pwrtool`
   * `go run . tui`

