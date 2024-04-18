<script lang="ts">
  import type { PageData } from './$types';

  export let data: PageData; // declare the data prop

  function kwh(value: number)  {
    return (value / 1000).toFixed(1) + " kwh";
  }
</script>

<h1>Harrison Power</h1>

{#if data.usage}
  <h2>{data.usage.range}</h2>
  From {data.usage.start} to {data.usage.end}
  {#each data.usage.tariffs as tariff}
    <h3>{tariff.tariff}</h3>
    <ul>
      <li>Home Use {kwh(tariff.home_usage)}</li>
      <li>Solar Production {kwh(tariff.solar_production)}</li>
      <li>Grid Imported: {kwh(tariff.grid_imported)}</li>
      <li>Grid Exported: {kwh(tariff.grid_exported)}</li>
      <li>Grid Net: {kwh(tariff.grid_exported- tariff.grid_imported)}</li>
    </ul>
  {/each}
{:else}
  <p>Loading...</p>
{/if}
