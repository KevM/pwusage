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
  <li>Home Use: {kwh(dashboard.currently.load_imported)}</li>
  <li>Solar Production: {kwh(dashboard.currently.solar_exported)}</li>
  <li>Grid Imported: {kwh(dashboard.currently.grid_imported)}</li>
  <li>Grid Exported: {kwh(dashboard.currently.grid_exported)}</li>
  <li>Battery: {soc(dashboard.currently.battery_soc)}</li>
  <li>Tariff: {dashboard.currently.tariff}</li>
</ul>

<Usage usage={dashboard.day} />
<Usage usage={dashboard.week} />
<Usage usage={dashboard.month} />
<Usage usage={dashboard.year} />
{:else}
  <p>Loading Report...</p>
{/if}
