<script lang="ts">
  import { authStore } from "$lib/authStore";  // import your auth store

  let isAuthenticated: boolean;
  let username: string;

  // Subscribe to the auth store
  authStore.subscribe((value) => {
    isAuthenticated = value.isAuthenticated;
    username = value.username;
  });
</script>

<nav>
  <a href="/">Home</a>
  {#if isAuthenticated}
    <a href="/profile">{username}</a>
  {:else}
    <a href="/login">Login</a>
  {/if}
</nav>

<slot />
