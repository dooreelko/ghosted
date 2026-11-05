import { createAdminHandler } from './admin-app.mjs';

// Fired by a one-shot schedule: calls Ghost's own schedule endpoint with the signed URL it handed
// the scheduler, which publishes the post (and sends its newsletter, through the email function).
const admin = await createAdminHandler();
export const handler = async (event) => {
  const res = await admin.callback(event);
  console.log(JSON.stringify({ scheduledCallback: { path: new URL(event.url).pathname, status: res.statusCode } }));
  if (res.statusCode >= 400) throw new Error(`scheduled callback answered ${res.statusCode}: ${String(res.body).slice(0, 300)}`);
  return { status: res.statusCode };
};
