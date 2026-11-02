import { createAdminHandler } from './admin-app.mjs';

// Newsletter send: the job Ghost dispatched when a post with a newsletter was published.
const admin = await createAdminHandler();
export const handler = async (event) => {
  await admin.sendEmail(event.job);
  return { sent: event.job.emailId };
};
