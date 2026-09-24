<script lang="ts">
  import { goto } from "$app/navigation";

  let email = "admin@localhost";
  let password = "admin";
  let error = "";
  let busy = false;

  async function handleSubmit() {
    busy = true;
    error = "";

    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    const payload = (await response.json()) as { error?: string; user?: { email: string } };
    if (!response.ok) {
      error = payload.error || "Invalid email or password.";
      busy = false;
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const redirect = params.get("redirect") || "/";
    await goto(redirect);
  }
</script>

<svelte:head>
  <title>Login</title>
</svelte:head>

<div class="login-shell">
  <form class="login-card" on:submit|preventDefault={handleSubmit}>
    <h1>Asset Library</h1>
    <label>
      <span>Email</span>
      <input bind:value={email} type="email" autocomplete="username" required />
    </label>
    <label>
      <span>Password</span>
      <input bind:value={password} type="password" autocomplete="current-password" required />
    </label>
    {#if error}
      <p class="error">{error}</p>
    {/if}
    <button type="submit" disabled={busy}>{busy ? "Signing in..." : "Sign in"}</button>
  </form>
</div>

<style>
  :global(body) {
    margin: 0;
    font-family: sans-serif;
    background: #111827;
    color: #f3f4f6;
  }

  .login-shell {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 1.5rem;
  }

  .login-card {
    width: min(100%, 28rem);
    display: grid;
    gap: 1rem;
    background: rgba(17, 24, 39, 0.9);
    border: 1px solid rgba(148, 163, 184, 0.2);
    border-radius: 1rem;
    padding: 2rem;
    box-shadow: 0 24px 60px rgba(15, 23, 42, 0.45);
  }

  h1 {
    margin: 0;
    font-size: 2rem;
  }

  label {
    display: grid;
    gap: 0.35rem;
  }

  input {
    width: 100%;
    border-radius: 0.5rem;
    border: 1px solid #475569;
    padding: 0.75rem 0.85rem;
    font: inherit;
    background: rgba(15, 23, 42, 0.7);
    color: inherit;
  }

  button {
    border: none;
    border-radius: 0.5rem;
    background: #2563eb;
    color: white;
    padding: 0.8rem 1rem;
    font: inherit;
    cursor: pointer;
  }

  .error {
    margin: 0;
    color: #fca5a5;
  }
</style>
