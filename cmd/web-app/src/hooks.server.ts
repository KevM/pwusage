import type { Handle } from "@sveltejs/kit";
import { userAuthRepo } from "$lib/userRepo";

export const handle: Handle = async ({ event, resolve }) => {
  if (!event.locals.userRepo) {
    event.locals.userRepo = userAuthRepo;
  }
  const resp = await resolve(event);
  return resp;
};
