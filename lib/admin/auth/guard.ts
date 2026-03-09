import { cookies } from "next/headers";
import { getCookieName, verifySessionToken } from "./session";

export async function getAdminSession(): Promise<{ username: string } | null> {
  const token = cookies().get(getCookieName())?.value;
  const session = await verifySessionToken(token);
  if (!session) {
    return null;
  }
  return { username: session.username };
}
