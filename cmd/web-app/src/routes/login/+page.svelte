<script lang="ts">
  import { authStore, getTeslaLoginUri} from "$lib/authStore"; // import your auth store

  let isAuthenticated: boolean;
  let username: string;

  // Subscribe to the auth store
  authStore.subscribe((value) => {
    isAuthenticated = value.isAuthenticated;
    username = value.username;
  });
</script>

{#if isAuthenticated}
You are logged in as {username}. Would you like to <a href="logout">logout</a>?
{:else}
<p>You are not currently logged in.</p>

<p>You will need to authenticate using your Tesla credentials and authorize us to access Tesla's API on your behalf.</p>
<a href="{getTeslaLoginUri()}">Login to Tesla</a>
{/if}