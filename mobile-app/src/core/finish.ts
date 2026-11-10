import { saveWithRetries, setLastAttempt, patchLastAttempt, type SaveState } from "./exam-flow";
import type { AttemptSnapshot } from "./engine";
import { saveResult } from "./repo/results";
import { removeSession } from "./session";

/** Show the attempt right away, store it in the background, and drop the saved copy only once it is safely in the database. */
export async function persistAttempt(snapshot: AttemptSnapshot): Promise<SaveState> {
  setLastAttempt({ ...snapshot, saveState: "saving" });
  const state = await saveWithRetries(snapshot, saveResult);
  patchLastAttempt(snapshot.examId, { saveState: state });
  if (state === "saved" || state === "blocked") { if (state === "saved") removeSession(snapshot.uid, snapshot.examId); }
  return state;
}
