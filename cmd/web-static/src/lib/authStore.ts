import { writable } from 'svelte/store';

interface User {
    email: string;
    authToken: string;
    refreshToken: string;
    oauth_nonce: string;
    oauth_state: string;
}

interface UserStore {
    user: User | null;
    isAuthenticated: boolean;
    username: string;
}

// Create a writable store with initial state
export const authStore = writable<UserStore>({
    user: null,
    isAuthenticated: false,
    username: '',
});

// Function to update the user
export function setUser(user: User | null) {
    authStore.update(state => ({ ...state, user, isAuthenticated: user !== null, username: user?.email || '' }));
}

// Function to clear the user (logout)
export function clearUser() {
    authStore.update(state => ({ ...state, user: null, isAuthenticated: false, username: '' }));
}

export function getTeslaLoginUri() : string {
    const s = Math.random().toString(36).substring(2, 15);
    const nonce = Math.random().toString(36).substring(2, 15);
    const redirectUri = 'http://localhost:8090/usage/auth/tesla_callback';
    const clientid = '5fcb567b7830-4498-8fd8-c861851b24ac';
    const scopes = "openid%20energy_device_data%20offline_access%20"

    const uri = `https://auth.tesla.com/oauth2/v3/authorize?&locale=en-US&prompt=login&response_type=code&scope=${scopes}&state=${s}&nonce=${nonce}&redirect_uri=${redirectUri}&client_id=${clientid}`;
    authStore.update(state => ({ ...state, oauth_nonce: nonce, oauth_state: s }));
   
    return uri
}
