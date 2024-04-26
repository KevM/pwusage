<script lang="ts">
  import type { PageData } from './$types';
  import CopyToClipboard from '$lib/CopyToClipboard.svelte';

  export let data: PageData;

</script>

<h1>TeslaCallback</h1>

<h4>Access Token</h4>
<textarea cols="90" rows="12">{data.auth?.access_token}</textarea>
<CopyToClipboard text={data.auth?.access_token}} let:copy>
  <br/><button on:click={copy}>Copy</button>
</CopyToClipboard>

<h4>Refresh Token</h4>
<textarea cols="90" rows="1">{data.auth?.refresh_token}</textarea>
<CopyToClipboard text={data.auth?.refresh_token}} let:copy>
  <br/><button on:click={copy}>Copy</button>
</CopyToClipboard>