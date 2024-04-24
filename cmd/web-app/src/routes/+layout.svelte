<script lang="ts">
  import { authStore } from "$lib/authStore";
  import { type User } from "$lib/types";

  let user: User | null;
  authStore.subscribe((value) => {
    user = value.user;
  });
</script>

<nav>
  <a href="/">Home</a>
  <a href="/usage">Usage</a>
  {#if user}
    <a href="/logout">Logout</a>
  {:else}
    <a href="/login">Login</a>
  {/if}
</nav>

<slot />
