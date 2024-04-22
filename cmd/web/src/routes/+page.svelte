<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { fetchDashboardReport } from "$lib/usage_report";
  import type { DashboardReport } from "$lib/types";
  import Usage from "$lib/Usage.svelte";
  
  let dashboard : DashboardReport

  function kwh(value: number) {
    return (value / 1000).toFixed(1) + " kwh";
  }

  function soc(value: number) {
    return value.toFixed(1) + " %";
  }
  let intervalId: number;
  
  onMount(async () => {
    // Fetch data immediately on mount
    dashboard = await fetchDashboardReport();

    // Then fetch data every 60 seconds
    intervalId = setInterval(async () => {
      dashboard = await fetchDashboardReport();
    }, 60000);
  });

  onDestroy(() => {
    clearInterval(intervalId);
  });
</script>

<h1>Harrison Power</h1>
{#if dashboard}

<h2>Currently</h2>
<ul>
  <li>Home Using: {kwh(dashboard.currently.load)}</li>
  <li>Solar Producing: {kwh(dashboard.currently.solar_production)}</li>
  <li>Grid Flow: {kwh(dashboard.currently.grid)}</li>
  <li>Battery Flow: {soc(dashboard.currently.battery)}</li>
  <li>Battery Charge: {soc(dashboard.currently.battery_soc)}</li>
  <li>Tariff: {dashboard.currently.tariff}</li>
</ul>

<Usage usage={dashboard.day} />
<Usage usage={dashboard.week} />
<Usage usage={dashboard.month} />
<Usage usage={dashboard.year} />
{:else}
  <p>Loading Report...</p>
{/if}
