<script lang="ts">
  import type { PageData } from './$types';
  import { authStore} from "$lib/authStore"; // import your auth store

  export let data: PageData;

</script>

<h1>TeslaCallback</h1>

<h4>Access Token</h4>
<code>
  {data.auth?.access_token}
</code>

<h4>Refresh Token</h4>
<code>
  {data.auth?.refresh_token}
</code>
