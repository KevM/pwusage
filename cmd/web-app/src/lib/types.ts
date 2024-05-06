export interface UserStore {
    user: User | null;
    nonce: string | null;
    callbackUri: string | null;
}

export interface User {
    authToken: string;
    idToken: string;
    refreshToken: string;
}
