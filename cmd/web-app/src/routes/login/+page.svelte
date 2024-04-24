<script lang="ts">
  import { authStore, getTeslaLoginUri } from "$lib/authStore"; 
  import { type User } from "$lib/types"; 

  let user: User | null;
  authStore.subscribe((value) => {
    user = value.user;
  });
</script>

{#if user}
  You are logged in. Would you like to <a href="logout">logout</a>?
{:else}
  <p>You are not currently logged in.</p>
  <p>
    You will need to authenticate using your Tesla credentials and authorize us
    to access Tesla's API on your behalf.
  </p>
  <a href={getTeslaLoginUri()}>Login to Tesla</a>
{/if}
