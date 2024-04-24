<script lang="ts">
  import type { UsageReport } from "$lib/types";

  export let usage: UsageReport;
  function kwh(value: number) {
    return (value / 1000).toFixed(1) + " kwh";
  }
  function capitalize(word: string) {
    return word.substring(0, 1).toUpperCase() + word.substring(1).toLowerCase();
  }
</script>

<h3>{capitalize(usage.range)}</h3>
{#each usage.tariffs as tariff}
  <h4>{tariff.tariff}</h4>
  <ul>
    <li>Home Use {kwh(tariff.home_usage)}</li>
    <li>Solar Production {kwh(tariff.solar_production)}</li>
    <li>Grid Imported: {kwh(tariff.grid_imported)}</li>
    <li>Grid Exported: {kwh(tariff.grid_exported)}</li>
    <li>Grid Net: {kwh(tariff.grid_exported - tariff.grid_imported)}</li>
  </ul>
{/each}
