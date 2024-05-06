export interface UserAuth {
  state: string;
  nonce: string;
  callback: string | undefined;
}

export interface UserAuthRepository {
  write(ua: UserAuth) : void;
  read(state: string): UserAuth | undefined;
}

export class UserAuthRepo implements UserAuthRepository {
  private uas = new Map<string, UserAuth>();
  write(ua: UserAuth) {
    this.uas.set(ua.state, ua);
  }

  read(state: string): UserAuth | undefined {
    return this.uas.get(state);}
}
export const userAuthRepo = new UserAuthRepo();
