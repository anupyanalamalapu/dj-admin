import { cookies } from "next/headers";
import { getCookieName, verifySessionToken } from "./session";

export function getAdminSession(): { username: string } | null {
  const token = cookies().get(getCookieName())?.value;
  const session = verifySessionToken(token);
  if (!session) {
    return null;
  }
  return { username: session.username };
}
