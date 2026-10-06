import { seedUsers } from "@/lib/auth/users";
import { ensureSeeded } from "@/lib/seed";

export async function bootstrap(): Promise<void> {
  seedUsers();
  await ensureSeeded();
}
