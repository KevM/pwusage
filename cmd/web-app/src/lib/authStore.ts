import { writable } from 'svelte/store';
import {PUBLIC_TESLA_CALLBACK_URL, PUBLIC_TESLA_OAUTH_CLIENT_ID} from '$env/static/public';
import { type UserStore, type User } from '$lib/types';

// Create a writable store with initial state
export const authStore = writable<UserStore>({
    user: null,
    nonce: null,
});

// Function to update the user
export function setUser(user: User | null) {
    authStore.update(state => ({ ...state, user}));
}

export function setNonce(nonce: string) {
    authStore.update(state => ({ ...state, nonce: nonce }));
}

// Function to clear the user (logout)
export function clear() {
    authStore.update(state => ({ ...state, user: null, nonce: null}));
}

export function getTeslaLoginUri() : string {
    const s = Math.random().toString(36).substring(2, 12);
    const nonce = Math.random().toString(36).substring(2, 12);
    const scopes = "openid%20energy_device_data%20offline_access%20user_data%20energy_cmds"
    const uri = `https://auth.tesla.com/oauth2/v3/authorize?&locale=en-US&prompt=login&response_type=code&scope=${scopes}&state=${s}&redirect_uri=${PUBLIC_TESLA_CALLBACK_URL}&client_id=${PUBLIC_TESLA_OAUTH_CLIENT_ID}&nonce=${nonce}`;
    authStore.update(state => ({ ...state, oauth_nonce: nonce, oauth_state: s }));
    return uri
}

