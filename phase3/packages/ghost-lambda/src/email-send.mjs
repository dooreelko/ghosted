import { createAdminHandler } from './admin-app.mjs';
import { invalidateFresh } from './runtime.mjs';

// Newsletter send: the job Ghost dispatched when a post with a newsletter was published.
const admin = await createAdminHandler();
export const handler = async (event) => {
  // The job reads rows written moments ago by another function: never trust this copy's snapshot.
  invalidateFresh();
  await admin.sendEmail(event.job);
  return { sent: event.job.emailId };
};
