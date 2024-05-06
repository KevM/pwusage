import type UserAuthRepository from '$lib/userRepo';

declare global {
 namespace App {
  // interface Error {}

  // Uncomment the `interface Locals` and create a `db` property
  interface Locals {
   userRepo: UserAuthRepository;
  }

  // interface PageData {}
  // interface PageState {}
  // interface Platform {}
 }
}

export {};