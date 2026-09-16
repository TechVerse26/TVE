import { waitForAuth, consumePostLoginRedirect } from "./utils.js";
import { navigate } from "./router.js";

export async function redirectIfAlreadyAuthed() {
  const user = await waitForAuth();
  if (user) {
    navigate(consumePostLoginRedirect() || "#/home");
    return true;
  }
  return false;
}
